// Require the Node Slack SDK package (github.com/slackapi/node-slack-sdk)
const { WebClient, LogLevel } = require('@slack/web-api');
const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const fetch = require('node-fetch');
const signVerification = require('./signVerification');
const util = require('./util.js');
const { URLSearchParams } = require('url');
const { Chess } = require('chess.js');
const Queue = require('bee-queue');

const carrieValidationQueue = new Queue('validateCarrieMove', {
  redis: process.env.REDIS_URL,
});
const larryValidationQueue = new Queue('validateLarryMove', {
  redis: process.env.REDIS_URL,
});

const PORT = process.env.PORT || 5000;
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

carrieValidationQueue.process(async (job) => {
  console.log(`Processing carrie job ${job.id}`);
  return job.data;
});

larryValidationQueue.process(async (job) => {
  console.log(`Processing larry job ${job.id}`);
  return job.data;
});

const app = new express();

app
  .use(express.urlencoded({ extended: true }))
  .use(express.static(path.join(__dirname, 'public')))
  .set('views', path.join(__dirname, 'views'))
  .set('view engine', 'ejs')
  .get('/', (req, res) => res.render('pages/index'))
  .post('/playLarry', (req, res) => {
    signVerification(req, res, () => playMove(req, res, LARRY));
  })
  .post('/playCarrie', (req, res) => {
    signVerification(req, res, () => playMove(req, res, CARRIE));
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
  .post('/testQueueNoSlack', (req, res) => testQueue(req, res))
  .listen(PORT, () => console.log(`Listening on ${PORT}`));

playMove = async (req, res, playingAsArg) => {
  const { text, user_name } = req.body;
  let playingAs = playingAsArg || getRandomPlayer();

  try {
    const dbClient = await pool.connect();
    const [gameId, ongoingGameExists, isPlayerTurn] = await getGameMetadata(
      dbClient,
      playingAs,
    );

    const userMovesResult = await dbClient.query({
      text: `SELECT * FROM moves WHERE username = $1 AND game_id = $2 ORDER BY move_id DESC LIMIT 1`,
      values: [user_name, gameId],
    });

    if (userMovesResult.rows && userMovesResult.rows.length) {
      const currentMoveRow = userMovesResult.rows[0];

      const timeSinceLastMove =
        new Date().getTime() - Date.parse(currentMoveRow.created_at);
      // console.log(`time since last move: ` + timeSinceLastMove);

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
          `⛔ You are playing for ${currentMoveRow.team}, please wait until it is your turn to move`
        );
        dbClient.release();
        return;
      }

      // Make user play moves associated with their current team
      playingAs = currentMoveRow.team;
    } else if (ongoingGameExists && !isPlayerTurn) {
      // If user is not on a team, make sure their next move is for the current team-to-play
      playingAs = getOtherPlayer(playingAs);
    }

    let chess;
    const boardResult = await dbClient.query({
      text: `SELECT * FROM boards WHERE game_id = $1 LIMIT 1`,
      values: [gameId],
    });

    const currentBoardFen = boardResult.rows[0]?.fen;
    // console.log(`DB Board Fen: ${currentBoardFen}`);
    if (ongoingGameExists && currentBoardFen) {
      chess = new Chess(currentBoardFen);
    } else {
      chess = new Chess();
    }

    const moveResult = chess.move(text, { sloppy: true });
    if (moveResult == null) {
      console.error(`Move: ${text} was determined invalid by ChessJS and not played.`);
      res.send(`🚫 Invalid move: *${text}* was not played`);
      dbClient.release();
      return;
    }
    const nextBoardFen = chess.fen();
    const lastMove = getLastMove(chess);
    const uciMove = `${lastMove.from}${lastMove.to}`;

    const playMoveResponse = await fetch(
      `https://lichess.org/api/board/game/${gameId}/move/${uciMove}`,
      { method: 'post', headers: buildAuthHeader(playingAs) },
    );

    const gameUrlText = !ongoingGameExists
      ? `\n>View ongoing game at https://lichess.org/${gameId}`
      : '';

    if (playMoveResponse.ok) {
      res.send(`*${text}* was successfully played`);
      slackClient.chat.postMessage({
        channel: process.env.CHANNEL_ID,
        text: `${util.getChessEmoji(
          lastMove.color,
          lastMove.piece,
        )} ${user_name} played *${text}*${gameUrlText}`,
      });
      dbClient.query({
        text: `INSERT INTO moves(username, move, team, game_id) VALUES($1, $2, $3, $4)`,
        values: [user_name, text, playingAs, gameId],
      });
      dbClient.query({
        text: `INSERT INTO boards(game_id, fen) VALUES($1, $2) ON CONFLICT (game_id) DO UPDATE SET fen = EXCLUDED.fen`,
        values: [gameId, nextBoardFen],
      });
    } else {
      console.error(`Move: ${text} was attempted with Lichess and was rejected`);
      res.send(`🚫 Invalid move: *${text}* was not played`);
    }

    dbClient.release();
  } catch (error) {
    console.error(error);
  }
};

getRandomPlayer = () => (Math.random() < 0.5 ? CARRIE : LARRY);

getOtherPlayer = (playingAs) => (playingAs === CARRIE ? LARRY : CARRIE);

getLastMove = (chess) => {
  const history = chess.history({ verbose: true });
  return history[history.length - 1];
};

buildAuthHeader = (playingAs) => ({
  Authorization: 'Bearer ' + getLichessToken(playingAs),
});

getGameMetadata = async (dbClient, playingAs) => {
  const lastGameResult = await dbClient.query(
    'SELECT * FROM boards ORDER BY created_at DESC LIMIT 1',
  );
  const row = lastGameResult.rows[0];

  let ongoingGameExists;
  let gameId;
  let isPlayerTurn;
  if (!row?.result) {
    gameId = row?.game_id;
    ongoingGameExists = true;
    isPlayerTurn = row?.current_team === playingAs;
  } else {
    const createNewGameJson = await createNewGame(getLichessToken(playingAs));
    gameId = createNewGameJson.game.id;
    ongoingGameExists = false;
    isPlayerTurn = true;
  }

  /*
  const currentlyPlayingResponse = await fetch(
    'https://lichess.org/api/account/playing',
    { headers: buildAuthHeader(playingAs) },
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
    const createNewGameJson = await createNewGame(getLichessToken(playingAs));
    gameId = createNewGameJson.game.id;
    console.log('Created new game with ID ' + gameId);
  }
  */

  return [gameId, ongoingGameExists, isPlayerTurn];
};

createNewGame = async (token) => {
  const headers = {
    Authorization: 'Bearer ' + token,
  };

  const params = new URLSearchParams();
  params.append('color', 'white');
  params.append('rated', false);
  params.append('clock.limit', 900);
  params.append('clock.increment', 0);
  params.append(
    'acceptByToken',
    token === process.env.LARRY_LICHESS_TOKEN
      ? process.env.CARRIE_LICHESS_TOKEN
      : process.env.LARRY_LICHESS_TOKEN,
  );

  const opponent =
    token === process.env.LARRY_LICHESS_TOKEN ? 'Carrie_CRC' : 'Larry_LDM';

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

getLichessToken = (playingAs = '') =>
  playingAs.toLowerCase() === LARRY
    ? process.env.LARRY_LICHESS_TOKEN
    : process.env.CARRIE_LICHESS_TOKEN;

getBoardUrl = async (req, res) => {
  try {
    const randomPlayer = getRandomPlayer();

    const currentlyPlayingResponse = await fetch(
      'https://lichess.org/api/account/playing',
      { headers: buildAuthHeader(randomPlayer) },
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
    const wins = games.reduce((wins, game) => {
      if (game.result && game.team.toUpperCase().startsWith(game.result)) {
        return wins + 1;
      }
      return wins;
    }, 0);

    // TODO calculate results of games with unpopulated results by using ChessJs

    res.send(`🏆 You've won ${wins} out of ${games.length} games`);
    dbClient.release();
  } catch (error) {
    console.error(error);
  }
};

testQueue = async (req, res) => {
  const player = getRandomPlayer();
  try {
    if (player === CARRIE) {
      const carrieJob = carrieValidationQueue.createJob({ foo: 'bar' });
      const jobComplete = await carrieJob.timeout(3000).retries(1).save();

      res.send(
        `Carrie job with id: ${carrieJob.id} completed with data: ${jobComplete}`,
      );
    } else {
      const larryJob = larryValidationQueue.createJob({ fuz: 'wuz' });
      const jobComplete = await larryJob.timeout(3000).retries(1).save();

      res.send(
        `Larry job with id: ${larryJob.id} completed with data: ${jobComplete}`,
      );
    }
  } catch (error) {
    console.log(error);
    res.send('Some error occurred');
  }
};
