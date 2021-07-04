// Require the Node Slack SDK package (github.com/slackapi/node-slack-sdk)
const { WebClient, LogLevel } = require('@slack/web-api');
const cool = require('cool-ascii-faces');
const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const fetch = require('node-fetch');
const signVerification = require('./signVerification');
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
  .get('/cool', (req, res) => res.send(cool()))
  .get('/times', (req, res) => res.send(showTimes()))
  .get('/db', async (req, res) => {
    try {
      const client = await pool.connect();
      const result = await client.query('SELECT * FROM test_table');
      const results = { results: result ? result.rows : null };
      res.render('pages/db', results);
      client.release();
    } catch (err) {
      console.error(err);
      res.send('Error ' + err);
    }
  })
  .post('/testcool', (req, res) => {
    signVerification(req, res, async () => {
      const { text, user_name } = req.body;
      try {
        const result = await client.chat.postMessage({
          channel: process.env.CHANNEL_ID,
          text: `${user_name} sent ${text}: ${cool()}`,
        });
        console.log(result);
      } catch (error) {
        console.error(error);
      }

      res.sendStatus(200);
    });
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

showTimes = () => {
  let result = '';
  const times = process.env.TIMES || 5;
  for (i = 0; i < times; i++) {
    result += i + ' ';
  }
  return result;
};

playMove = async (req, res, token) => {
  const { text, user_name } = req.body;
  const headers = {
    Authorization: 'Bearer ' + token,
  };
  let result = '';

  try {
    const response = await fetch(
      'https://lichess.org/api/account/playing',
      { headers }
    );
    const resJson = await response.json();
    console.log(resJson);
    if (resJson && resJson.nowPlaying && resJson.nowPlaying.length) {
      const currentGame = resJson.nowPlaying[0];
      console.log('current game ID: ' + currentGame.gameId);
      result =
        'Current game ID is ' +
        currentGame.gameId +
        ' and the last move played was ' +
        currentGame.lastMove;
    } else {
      result = 'Could not find ongoing game';
    }
  } catch (error) {
    console.error(error);
  }

  res.send(result);
};
