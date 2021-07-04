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
const client = new WebClient(process.env.SLACK_BOT_TOKEN, {
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
    signVerification(req, res, () =>
      playMove(req, res, process.env.LARRY_LICHESS_TOKEN)
    );
  })
  .post('/playCarrie', (req, res) => {
    signVerification(req, res, () =>
      playMove(req, res, process.env.CARRIE_LICHESS_TOKEN)
    );
  })
  .listen(PORT, () => console.log(`Listening on ${PORT}`));

playMove = async (req, res, token) => {
  const { text, user_name } = req.body;
  const headers = {
    Authorization: 'Bearer ' + token,
  };
  let result = '';
  let gameId = '';

  try {
    const currentlyPlayingResponse = await fetch(
      'https://lichess.org/api/account/playing',
      { headers }
    );
    const currentlyPlayingJson = await currentlyPlayingResponse.json();
    if (
      currentlyPlayingJson &&
      currentlyPlayingJson.nowPlaying &&
      currentlyPlayingJson.nowPlaying.length
    ) {
      const currentGame = currentlyPlayingJson.nowPlaying[0];
      console.log('Current game ID: ' + currentGame.gameId);
      gameId = currentGame.gameId;
    } else {
      const createNewGameJson = await createNewGame(token);
      console.log('Created new game with ID ' + createNewGameJson.game.id);
      gameId = createNewGameJson.game.id;
    }

    const playMoveResponse = await fetch(
      `https://lichess.org/api/board/game/${gameId}/move/${text}`,
      { method: 'post', headers }
    );
    if (playMoveResponse.ok) {
      result += `Move (${text}) was successfully played`;
      const result = await client.chat.postMessage({
        channel: process.env.CHANNEL_ID,
        text: `${user_name} played ${text}: view ongoing game at https://lichess.org/${gameId}`,
      });
    } else {
      result += `Move (${text}) failed`;
    }
  } catch (error) {
    console.error(error);
  }

  res.send(result);
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
