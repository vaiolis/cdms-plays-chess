// Require the Node Slack SDK package (github.com/slackapi/node-slack-sdk)
const { WebClient, LogLevel } = require('@slack/web-api');
const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const fetch = require('node-fetch');
const signVerification = require('./signVerification');
const { URLSearchParams } = require('url');
const { Chess } = require('chess.js');
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

const app = new express();

app
  .use(express.urlencoded({ extended: true }))
  .use(express.static(path.join(__dirname, 'public')))
  .set('views', path.join(__dirname, 'views'))
  .set('view engine', 'ejs')
  .get('/', (req, res) => res.render('pages/index'))
  .get('/db', async (req, res) => {
    try {
      const dbClient = await pool.connect();
      const result = await dbClient.query('SELECT * FROM test_table');
      const results = { results: result ? result.rows : null };
      res.render('pages/db', results);
      dbClient.release();
    } catch (err) {
      console.error(err);
      res.send('Error ' + err);
    }
  })
  .post('/playLarry', (req, res) => {
    signVerification(req, res, () => playMove(req, res, LARRY));
  })
  .post('/playCarrie', (req, res) => {
    signVerification(req, res, () => playMove(req, res, CARRIE));
  })
  .post('/play', (req, res) => {
    signVerification(req, res, () => playMove(req, res));
  })
  .listen(PORT, () => console.log(`Listening on ${PORT}`));

playMove = async (req, res, playingAsArg) => {
  const { text, user_name } = req.body;
  let playingAs = playingAsArg || getRandomPlayer();

  try {
    const [gameId, ongoingGameExists, isPlayerTurn, fenString] =
      await getGameMetadata(playingAs);

    const dbClient = await pool.connect();
    const dbResult = await dbClient.query({
      text: `SELECT * FROM moves WHERE username = $1 AND game_id = $2 ORDER BY move_id DESC LIMIT 1`,
      values: [user_name, gameId],
    });

    if (dbResult.rows && dbResult.rows.length) {
      const timeSinceLastMove =
        new Date().getTime() - Date.parse(dbResult.rows[0].created_at);
      console.log(`time since last move: ` + timeSinceLastMove);
      if (timeSinceLastMove < process.env.MOVE_TIMEOUT) {
        res.send('🕒 Please wait 1 minute between moves');
        dbClient.release();
        return;
      }

      if (playingAs !== dbResult.rows[0].team) {
        res.send(
          `⛔ You are playing for ${dbResult.rows[0].team}, please wait until it is your turn to move`
        );
        dbClient.release();
        return;
      }
    }

    if (ongoingGameExists && !isPlayerTurn) {
      playingAs = getOtherPlayer(playingAs);
    }

    let chess;
    if (ongoingGameExists && fenString) {
      chess = new Chess(fenString);
    } else {
      chess = new Chess();
    }

    const moveResult = chess.move(text, { sloppy: true });
    if (moveResult == null) {
      res.send(`🚫 Invalid move: *${text}* was not played`);
      return;
    }

    const lastMove = getLastMove(chess);
    const uciMove = `${lastMove.from}${lastMove.to}`;

    const playMoveResponse = await fetch(
      `https://lichess.org/api/board/game/${gameId}/move/${uciMove}`,
      { method: 'post', headers: buildAuthHeader(playingAs) }
    );

    if (playMoveResponse.ok) {
      res.send(`*${text}* was successfully played`);
      slackClient.chat.postMessage({
        channel: process.env.CHANNEL_ID,
        text: `${getChessEmoji(
          lastMove.color,
          lastMove.piece
        )} ${user_name} played *${text}*\n>View ongoing game at https://lichess.org/${gameId}`,
      });
      dbClient.query({
        text: `INSERT INTO moves(username, move, team, game_id) VALUES($1, $2, $3, $4)`,
        values: [user_name, text, playingAs, gameId],
      });
    } else {
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

getGameMetadata = async (playingAs) => {
  const currentlyPlayingResponse = await fetch(
    'https://lichess.org/api/account/playing',
    { headers: buildAuthHeader(playingAs) }
  );
  const currentlyPlayingJson = await currentlyPlayingResponse.json();
  const ongoingGameExists =
    currentlyPlayingJson &&
    currentlyPlayingJson.nowPlaying &&
    currentlyPlayingJson.nowPlaying.length;
  const isPlayerTurn =
    ongoingGameExists && currentlyPlayingJson.nowPlaying[0].isMyTurn;
  const fenString = ongoingGameExists && currentlyPlayingJson.nowPlaying[0].fen;
  let gameId;

  if (ongoingGameExists) {
    const currentGame = currentlyPlayingJson.nowPlaying[0];
    console.log('Current game ID: ' + currentGame.gameId);
    gameId = currentGame.gameId;
  } else {
    const createNewGameJson = await createNewGame(getLichessToken(playingAs));
    console.log('Created new game with ID ' + createNewGameJson.game.id);
    gameId = createNewGameJson.game.id;
  }

  return [gameId, ongoingGameExists, isPlayerTurn, fenString];
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
      : process.env.LARRY_LICHESS_TOKEN
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
      }
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

getChessEmoji = (color, piece) => {
  if (color === 'w') {
    switch (piece) {
      case 'k':
        return '♔';
      case 'q':
        return '♕';
      case 'r':
        return '♖';
      case 'n':
        return '♘';
      case 'b':
        return '♗';
      default:
        return '♙';
    }
  } else {
    switch (piece) {
      case 'k':
        return '♚';
      case 'q':
        return '♛';
      case 'r':
        return '♜';
      case 'n':
        return '♞';
      case 'b':
        return '♝';
      default:
        return '♟️';
    }
  }
};
