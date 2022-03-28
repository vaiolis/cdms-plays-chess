// Require the Node Slack SDK package (github.com/slackapi/node-slack-sdk)
const { WebClient, LogLevel } = require('@slack/web-api');
const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const fetch = require('node-fetch');
const signVerification = require('./signVerification');
const constants = require('./constants.js');
const util = require('./util.js');
const { URLSearchParams } = require('url');
const { Chess } = require('chess.js');
const Queue = require('bee-queue');

const moveValidationQueue = new Queue('validateMove', {
  redis: process.env.REDIS_URL,
});

const PORT = process.env.PORT || constants.DEFAULT_PORT;
const CARRIE = 'carrie';
const LARRY = 'larry';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// WebClient instantiates a client that can call API methods
// When using Bolt, you can use either `app.client` or the `client` passed to listeners.
const slackClient = new WebClient(process.env.SLACK_BOT_TOKEN, {
  // LogLevel can be imported and used to make debugging simpler
  logLevel: LogLevel.DEBUG,
});

moveValidationQueue.process(async (job) => {
  const result = await processMove(job.data);
  return result;
});

const app = new express();

app
  .use(express.urlencoded({ extended: true }))
  .use(express.static(path.join(__dirname, 'public')))
  .set('views', path.join(__dirname, 'views'))
  .set('view engine', 'ejs')
  .get('/', (req, res) => res.render('pages/index'))
  .post('/playLarry', (req, res) => {
    signVerification(req, res, () => playMove(req, res, constants.PLAYER_2));
  })
  .post('/playCarrie', (req, res) => {
    signVerification(req, res, () => playMove(req, res, constants.PLAYER_1));
  })
  .post('/play', (req, res) => {
    signVerification(req, res, () => playMove(req, res));
  })
  .post('/board', (req, res) => {
    signVerification(req, res, () => getBoardUrl(req, res));
  })
  .post('/matchHistory', (req, res) => {
    signVerification(req, res, () => getMatchHistory(req, res));
  })
  .post('/playNoSlack', (req, res) => playMove(req, res))
  .post('/boardNoSlack', (req, res) => getBoardUrl(req, res))
  .post('/matchHistoryNoSlack', (req, res) => getMatchHistory(req, res))
  .listen(PORT, () => console.log(`Listening on ${PORT}`));

playMove = async (req, res, playingAsArg) => {
  const { text, user_name } = req.body;
  let playingAs = playingAsArg || util.getRandomPlayer();
  let dbClient;

  try {
    dbClient = await pool.connect();

    let gameId;
    let ongoingGameExists;
    let isPlayerTurn;
    try {
      const gameMetadata = await getGameMetadata(
        dbClient,
        playingAs,
        res,
        text,
      );

      gameId = gameMetadata[0];
      ongoingGameExists = gameMetadata[1];
      isPlayerTurn = gameMetadata[2];
    } catch (error) {
      console.error(`🚫 Invalid Move: ${text} was determined to be invalid before creating new lichess game.`);
      res.send(error);
      dbClient.release();
      return;
    }

    const userMovesResult = await dbClient.query({
      text: `SELECT * FROM moves WHERE username = $1 AND game_id = $2 ORDER BY move_id DESC LIMIT 1`,
      values: [user_name, gameId],
    });

    if (userMovesResult.rows && userMovesResult.rows.length) {
      const currentMoveRow = userMovesResult.rows[0];

      const timeSinceLastMove =
        new Date().getTime() - Date.parse(currentMoveRow.created_at);

      if (timeSinceLastMove < process.env.MOVE_TIMEOUT) {
        res.send(
          `🕒 Please wait ${
            process.env.MOVE_TIMEOUT / 1000
          } seconds between moves`,
        );
        dbClient.release();
        return;
      }

      if (
        (playingAs === currentMoveRow.team && !isPlayerTurn) ||
        (playingAs !== currentMoveRow.team && isPlayerTurn)
      ) {
        res.send(
          `⛔ You are playing for ${currentMoveRow.team}, please wait until it is your turn to move`,
        );
        dbClient.release();
        return;
      }

      // Make user play moves associated with their current team
      playingAs = currentMoveRow.team;
    } else if (ongoingGameExists && !isPlayerTurn) {
      // If user is not on a team, make sure their next move is for the current team-to-play
      playingAs = util.getOtherPlayer(playingAs);
    }

    const jobData = {
      gameId,
      ongoingGameExists,
      playingAs,
      user_name,
      suggestedMove: text,
    };

    const moveValidationJob = moveValidationQueue.createJob(jobData);
    moveValidationJob.timeout(3000).retries(1).save();
    res.send(`✅ Move submitted!`);
    dbClient.release();
  } catch (error) {
    console.error(error);
    dbClient?.release();
  }
};

processMove = async (jobData) => {
  const { gameId, ongoingGameExists, playingAs, suggestedMove, user_name } =
    jobData;
  let dbClient;
  let message;
  let chess;

  try {
    dbClient = await pool.connect();

    const boardResult = await dbClient.query({
      text: `SELECT * FROM boards WHERE game_id = $1 LIMIT 1`,
      values: [gameId],
    });

    const boardRow = boardResult.rows[0] || {};
    const currentBoardFen = boardRow.fen;
    const currentMoveCount = boardRow.move_count || 0;
    const currentPlayer = boardRow.current_team;

    if (currentPlayer && playingAs !== currentPlayer) {
      console.log(
        `❌ Too Late: ${suggestedMove} was to be played for ${playingAs} but it is ${currentPlayer}'s turn`,
      );
      message = `❌ Too Late: it is now the other player's turn!`;
      dbClient.release();
      return {
        result: 'error',
        message,
      };
    }

    if (ongoingGameExists && currentBoardFen) {
      chess = new Chess(currentBoardFen);
    } else {
      chess = new Chess();
    }

    const moveResult = chess.move(suggestedMove);
    if (moveResult == null) {
      console.error(
        `🚫 Invalid Move: ${suggestedMove} was determined invalid by ChessJS and not played.`,
      );
      message = `🚫 Invalid move: *${suggestedMove}* was not played`;
      dbClient.release();
      return {
        result: 'error',
        message,
      };
    }

    const nextBoardFen = chess.fen();
    const lastMove = util.getLastMove(chess);
    const uciMove = `${lastMove.from}${lastMove.to}`;
    const isGameOver = chess.game_over();

    const playMoveResponse = await fetch(
      `https://lichess.org/api/board/game/${gameId}/move/${uciMove}`,
      { method: 'post', headers: util.buildAuthHeader(playingAs) },
    );

    const gameUrlText =
      !isGameOver && (!ongoingGameExists || currentMoveCount % 10 === 0)
        ? `\n>View ongoing game at https://lichess.org/${gameId}`
        : '';

    if (playMoveResponse.ok) {
      message = `*${suggestedMove}* was successfully played`;

      dbClient.query({
        text: `INSERT INTO moves(username, move, team, game_id) VALUES($1, $2, $3, $4)`,
        values: [user_name, suggestedMove, playingAs, gameId],
      });

      if (isGameOver) {
        let result;
        if (chess.in_checkmate()) {
          result = playingAs.toUpperCase().charAt(0);
        } else {
          result = 'D';
        }

        dbClient.query({
          text: `INSERT INTO boards(game_id, fen, current_team, move_count, result) VALUES($1, $2, $3, $4, $5) ON CONFLICT (game_id) DO UPDATE SET fen = EXCLUDED.fen, current_team = EXCLUDED.current_team, move_count = EXCLUDED.move_count, result = EXCLUDED.result`,
          values: [
            gameId,
            nextBoardFen,
            util.getOtherPlayer(playingAs),
            currentMoveCount + 1,
            result,
          ],
        });
      } else {
        dbClient.query({
          text: `INSERT INTO boards(game_id, fen, current_team, move_count) VALUES($1, $2, $3, $4) ON CONFLICT (game_id) DO UPDATE SET fen = EXCLUDED.fen, current_team = EXCLUDED.current_team, move_count = EXCLUDED.move_count`,
          values: [
            gameId,
            nextBoardFen,
            util.getOtherPlayer(playingAs),
            currentMoveCount + 1,
          ],
        });
      }

      const timeSinceLastUpdate = ongoingGameExists
        ? new Date().getTime() - Date.parse(boardResult.rows[0]?.last_updated)
        : 1500;

      if (timeSinceLastUpdate > 1499 || isGameOver) {
        const gameOverMessage = isGameOver
          ? '\n🏁 The current game is now over! Use /play to start a new one!'
          : '';

        slackClient.chat.postMessage({
          channel: process.env.CHANNEL_ID,
          text: `${util.getChessEmoji(
            lastMove.color,
            lastMove.piece,
          )} ${user_name} played *${suggestedMove}*${gameUrlText}${gameOverMessage}`,
        });
      }

      console.log(
        `✅ Valid Move: ${suggestedMove} was played by ${user_name} for board ${gameId}`,
      );
      dbClient.release();
      return {
        result: 'success',
        message,
      };
    } else {
      console.error(
        `🚫 Attempted Move: ${suggestedMove} was attempted with Lichess and was rejected`,
      );
      message = `🚫 Invalid move: *${suggestedMove}* was not played`;
      dbClient.release();
      return {
        result: 'error',
        message,
      };
    }
  } catch (error) {
    console.error(error);
    dbClient?.release();
    return {
      result: 'error',
      message: '🚫 Unexpected Error: An unexpected error occurred',
    };
  }
};

getGameMetadata = async (dbClient, playingAs, res, suggestedMove) => {
  const lastGameResult = await dbClient.query(
    'SELECT * FROM boards ORDER BY created_at DESC LIMIT 1',
  );
  const row = lastGameResult.rows[0];

  let ongoingGameExists;
  let gameId;
  let isPlayerTurn;
  if (row && !row?.result) {
    gameId = row?.game_id;
    ongoingGameExists = true;
    isPlayerTurn = row?.current_team === playingAs;
  } else {
    chess = new Chess();
    const moveResult = chess.move(suggestedMove);
    if (moveResult == null) {
      throw new Error(`🚫 Invalid move: *${suggestedMove}* was not played`);
    }

    const createNewGameJson = await createNewGame(playingAs);
    gameId = createNewGameJson.game.id;
    ongoingGameExists = false;
    isPlayerTurn = true;
  }

  /*
  const currentlyPlayingResponse = await fetch(
    'https://lichess.org/api/account/playing',
    { headers: util.buildAuthHeader(playingAs) },
  );
  const currentlyPlayingJson = await currentlyPlayingResponse.json();

  const ongoingGameExists = currentlyPlayingJson?.nowPlaying?.length;
  const isPlayerTurn =
    ongoingGameExists && currentlyPlayingJson.nowPlaying[0].isMyTurn;
  let gameId;

  if (ongoingGameExists) {
    const currentGame = currentlyPlayingJson.nowPlaying[0];
    gameId = currentGame.gameId;
    console.log('Current game ID: ' + gameId);
  } else {
    const createNewGameJson = await createNewGame(playingAs);
    gameId = createNewGameJson.game.id;
    console.log('Created new game with ID ' + gameId);
  }
  */

  return [gameId, ongoingGameExists, isPlayerTurn];
};

createNewGame = async (playingAs) => {
  const headers = util.buildAuthHeader(playingAs);

  const params = new URLSearchParams();
  params.append('color', 'white');
  params.append('rated', false);
  // Remove time controls to make this a correspondence game
  // params.append('clock.limit', constants.CLOCK_LIMIT);
  // params.append('clock.increment', constants.CLOCK_INCREMENT);
  params.append(
    'acceptByToken',
    playingAs === constants.PLAYER_2
      ? process.env.CARRIE_LICHESS_TOKEN
      : process.env.LARRY_LICHESS_TOKEN,
  );

  const opponent =
    playingAs === constants.PLAYER_2
      ? constants.PLAYER_1_NAME
      : constants.PLAYER_2_NAME;

  try {
    const response = await fetch(
      `https://lichess.org/api/challenge/${opponent}`,
      {
        method: 'post',
        headers,
        body: params,
      },
    );
    const responseJson = await response.json();
    return responseJson;
  } catch (error) {
    console.error(error);
  }

  return {};
};

getBoardUrl = async (req, res) => {
  try {
    const randomPlayer = util.getRandomPlayer();

    const currentlyPlayingResponse = await fetch(
      'https://lichess.org/api/account/playing',
      { headers: util.buildAuthHeader(randomPlayer) },
    );

    const currentlyPlayingJson = await currentlyPlayingResponse.json();

    const ongoingGameExists = currentlyPlayingJson?.nowPlaying?.length;

    if (ongoingGameExists) {
      const gameId = currentlyPlayingJson.nowPlaying[0].gameId;
      res.send(`🕓 Track the ongoing game at https://lichess.org/${gameId}`);
    } else {
      res.send(
        `👻 No ongoing game exists, use the '/play' command to start a new board!`,
      );
    }
  } catch (error) {
    console.error(error);
  }
};

getMatchHistory = async (req, res) => {
  const { user_name } = req.body;
  try {
    const dbClient = await pool.connect();
    const userGamesResult = await dbClient.query({
      text: `SELECT DISTINCT ON (boards.game_id) boards.game_id, fen, team, result from boards INNER JOIN moves ON boards.game_id = moves.game_id WHERE username = $1`,
      values: [user_name],
    });

    const games = userGamesResult.rows || [];

    let wins = 0;
    let losses = 0;
    let draws = 0;
    for (let i = 0; i < wins.length; i++) {
      if (game.result === 'D') {
        draws++;
      } else if (
        game.result &&
        game.team.toUpperCase().startsWith(game.result)
      ) {
        wins++;
      } else {
        losses++;
      }
    }

    res.send(
      `🏆 Your record (W-L-D) is ${wins}-${losses}-${draws} in a total of ${games.length} games`,
    );
    dbClient.release();
  } catch (error) {
    console.error(error);
  }
};
