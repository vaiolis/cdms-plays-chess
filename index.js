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

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const slackClient = new WebClient(process.env.SLACK_BOT_TOKEN, {
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
  .post('/play', (req, res) => {
    signVerification(req, res, () => playMove(req, res));
  })
  .post('/board', (req, res) => {
    signVerification(req, res, () => getBoardUrl(req, res));
  })
  .post('/chessProfile', (req, res) => {
    signVerification(req, res, () => getChessProfile(req, res));
  })
  .post('/chessHelp', (req, res) => {
    signVerification(req, res, () => getChessHelp(req, res));
  })
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
    let suggestedMove;
    try {
      const gameMetadata = await getGameMetadata(dbClient, playingAs, text);

      gameId = gameMetadata[0];
      ongoingGameExists = gameMetadata[1];
      isPlayerTurn = gameMetadata[2];
      suggestedMove = gameMetadata[3];
    } catch (error) {
      console.error(
        `🚫 Invalid Move: ${text} was determined to be invalid before creating new lichess game.`,
      );
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
        console.log(`🕒 ${user_name} must wait before making another move`);
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
          `⛔ You are playing for ${util.getPlayerName(
            currentMoveRow.team,
          )}, please wait until it is your turn to move`,
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
      suggestedMove,
    };

    const moveValidationJob = moveValidationQueue.createJob(jobData);
    moveValidationJob.timeout(3000).retries(1).save();
    res.send(`🕒 Move submitted, if it doesn't show up on the board check your syntax and try again`);
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

    let moveResult;
    let committedMove;
    if (suggestedMove === constants.RANDOM) {
      committedMove = util.getRandomMove(chess);
      moveResult = chess.move(committedMove);
    } else {
      committedMove = suggestedMove;
      moveResult = chess.move(suggestedMove);
    }

    if (moveResult == null) {
      console.error(
        `🚫 Invalid Move: ${committedMove} was determined invalid by ChessJS and not played.`,
      );
      message = `🚫 Invalid move: *${committedMove}* was not played`;
      dbClient.release();
      return {
        result: 'error',
        message,
      };
    }

    const nextBoardFen = chess.fen();
    const lastMove = util.getLastMove(chess);
    const uciMove = `${lastMove.from}${lastMove.to}${lastMove.promotion}`;
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
      message = `*${committedMove}* was successfully played`;

      dbClient.query({
        text: `INSERT INTO moves(username, move, team, game_id) VALUES($1, $2, $3, $4)`,
        values: [user_name, committedMove, playingAs, gameId],
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
        const newGameMessage = !ongoingGameExists
          ? '🆕 A new game has begun!\n'
          : '';

        const gameOverMessage = isGameOver
          ? '\n🏁 The current game is now over! Use /play to start a new one!'
          : '';

        slackClient.chat.postMessage({
          channel: process.env.CHANNEL_ID,
          text: `${newGameMessage}${util.getChessEmoji(
            lastMove.color,
            lastMove.piece,
          )} ${user_name} played *${committedMove}*${gameUrlText}${gameOverMessage}`,
        });
      }

      console.log(
        `✅ Valid Move: ${committedMove} was played by ${user_name} for board ${gameId}`,
      );
      dbClient.release();
      return {
        result: 'success',
        message,
      };
    } else {
      console.error(
        `🚫 Attempted Move: ${committedMove} was attempted with Lichess and was rejected`,
      );
      message = `🚫 Invalid move: *${committedMove}* was not played`;
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

getGameMetadata = async (dbClient, playingAs, suggestedMove) => {
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
    let moveResult;
    if (suggestedMove === constants.RANDOM) {
      moveResult = chess.move(util.getRandomMove(chess));
    } else {
      moveResult = chess.move(suggestedMove);
    }

    if (moveResult == null) {
      throw new Error(`🚫 Invalid move: *${suggestedMove}* was not played`);
    }

    const createNewGameJson = await createNewGame(playingAs);
    gameId = createNewGameJson.game.id;
    ongoingGameExists = false;
    isPlayerTurn = true;
  }

  return [gameId, ongoingGameExists, isPlayerTurn, suggestedMove];
};

createNewGame = async (playingAs) => {
  const headers = util.buildAuthHeader(playingAs);

  const params = new URLSearchParams();
  params.append('color', 'white');
  params.append('rated', false);
  params.append(
    'acceptByToken',
    playingAs === constants.PLAYER_2
      ? process.env.CARRIE_LICHESS_TOKEN
      : process.env.LARRY_LICHESS_TOKEN,
  );

  const opponent = util.getPlayerName(util.getOtherPlayer(playingAs));

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
  let dbClient;
  try {
    dbClient = await pool.connect();
    const lastGameResult = await dbClient.query(
      'SELECT * FROM boards ORDER BY created_at DESC LIMIT 1',
    );
    const row = lastGameResult.rows[0];
    const ongoingGameExists = row && !row?.result;
    const gameId = row?.game_id;

    if (ongoingGameExists) {
      res.send(`🕓 Track the ongoing game at https://lichess.org/${gameId}`);
    } else {
      res.send(
        `👻 No ongoing game exists, use the '/play' command to start a new board!`,
      );
    }
    dbClient?.release();
  } catch (error) {
    console.error(error);
    dbClient?.release();
  }
};

getChessProfile = async (req, res) => {
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
    for (let i = 0; i < games.length; i++) {
      const game = games[i];
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

    const usernameMessage = `👤 *User:* ${user_name}\n`;
    let currentTeamMessage =
      '👥 *Team:* you are not currently part of a team! use `/play` to submit a move for either side!\n';

    const lastGameResult = await dbClient.query(
      'SELECT * FROM boards ORDER BY created_at DESC LIMIT 1',
    );
    const row = lastGameResult.rows[0];
    if (row && !row?.result) {
      const gameId = row?.game_id;
      const userMovesResult = await dbClient.query({
        text: `SELECT * FROM moves WHERE username = $1 AND game_id = $2 ORDER BY move_id DESC LIMIT 1`,
        values: [user_name, gameId],
      });
      const currentMoveRow = userMovesResult.rows[0];
      if (currentMoveRow) {
        currentTeamMessage = `👥 *Team:* ${util.getPlayerName(
          currentMoveRow.team,
        )}\n`;
      }
    }

    res.send(
      usernameMessage +
        currentTeamMessage +
        `🏆 Your record (W-L-D) is ${wins}-${losses}-${draws} in a total of ${games.length} games`,
    );
    dbClient.release();
  } catch (error) {
    console.error(error);
  }
};

getChessHelp = (req, res) => {
  res.send(
    '*Vault Products Chess* is a slack app that lets Veevans collectively play a game of chaotic, anarchical chess!\n' +
      '• Every *5* seconds, you can submit a move with the `/play` command. You can either submit a move in ' +
      'Standard Algebraic Notation (e.g. `/play Nf3`) or suggest a random legal move by entering `/play random`.\n' +
      '• To watch an ongoing game, enter `/board` to get a link to an online chess board provided by lichess.org.\n' +
      '• Use the command `/chessProfile` to see your current team and win/loss/draw record.\n\n' +
      "*GLHF* and let's play some wild chess!",
  );
};
