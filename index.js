// Require the Node Slack SDK package (github.com/slackapi/node-slack-sdk)
const { WebClient, LogLevel } = require('@slack/web-api');
const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const fetch = require('node-fetch');
const signVerification = require('./signVerification');
const { URLSearchParams } = require('url');
const PORT = process.env.PORT || 5000;

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
    signVerification(req, res, () => playMove(req, res, 'larry'));
  })
  .post('/playCarrie', (req, res) => {
    signVerification(req, res, () => playMove(req, res, 'carrie'));
  })
  .post('/play', (req, res) => {
    signVerification(req, res, () => playMove(req, res));
  })
  .listen(PORT, () => console.log(`Listening on ${PORT}`));

playMove = async (req, res, playingAs) => {
  const { text, user_name } = req.body;
  const headers = {
    Authorization: 'Bearer ' + getLichessToken(playingAs),
  };
  let gameId = '';

  try {
    const dbClient = await pool.connect();
    const dbResult = await dbClient.query({
      text: `SELECT * FROM moves WHERE username = $1 ORDER BY move_id DESC LIMIT 1`,
      values: [user_name],
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
    }

    const currentlyPlayingResponse = await fetch(
      'https://lichess.org/api/account/playing',
      { headers }
    );
    const currentlyPlayingJson = await currentlyPlayingResponse.json();
    const ongoingGameExists =
      currentlyPlayingJson &&
      currentlyPlayingJson.nowPlaying &&
      currentlyPlayingJson.nowPlaying.length;

    if (ongoingGameExists) {
      const currentGame = currentlyPlayingJson.nowPlaying[0];
      console.log('Current game ID: ' + currentGame.gameId);
      gameId = currentGame.gameId;
    } else {
      const createNewGameJson = await createNewGame(getLichessToken(playingAs));
      console.log('Created new game with ID ' + createNewGameJson.game.id);
      gameId = createNewGameJson.game.id;
    }

    if (ongoingGameExists && !currentlyPlayingJson.nowPlaying[0].isMyTurn) {
      res.send('It is not your turn to play a move!');
      dbClient.release();
      return;
    }

    const playMoveResponse = await fetch(
      `https://lichess.org/api/board/game/${gameId}/move/${text}`,
      { method: 'post', headers }
    );

    if (playMoveResponse.ok) {
      res.send(`*${text}* was successfully played`);
      slackClient.chat.postMessage({
        channel: process.env.CHANNEL_ID,
        text: `${getChessEmoji(
          'black',
          'pawn'
        )} ${user_name} played *${text}*\n>View ongoing game at https://lichess.org/${gameId}`,
      });
      dbClient.query({
        text: `INSERT INTO moves(username, move, team, game_id) VALUES($1, $2, $3, $4)`,
        values: [user_name, text, playingAs, gameId],
      });
    } else {
      res.send(`Invalid move: *${text}* was not played`);
    }

    dbClient.release();
  } catch (error) {
    console.error(error);
  }
};

createNewGame = async (token) => {
  const headers = {
    Authorization: 'Bearer ' + token,
  };

  const params = new URLSearchParams();
  params.append('color', 'white');
  params.append('rated', false);
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
  playingAs.toLowerCase() === 'larry'
    ? process.env.LARRY_LICHESS_TOKEN
    : process.env.CARRIE_LICHESS_TOKEN;

getChessEmoji = (color, piece) => {
  if (color === 'white') {
    switch (piece) {
      case 'king':
        return '♔';
      case 'queen':
        return '♕';
      case 'rook':
        return '♖';
      case 'knight':
        return '♘';
      case 'bishop':
        return '♗';
      default:
        return '♙';
    }
  } else {
    switch (piece) {
      case 'king':
        return '♚';
      case 'queen':
        return '♛';
      case 'rook':
        return '♜';
      case 'knight':
        return '♞';
      case 'bishop':
        return '♝';
      default:
        return '♟️';
    }
  }
};
