const constants = require('./constants.js');

const getChessEmoji = (color, piece) => {
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

const getRandomPlayer = () =>
  Math.random() < 0.5 ? constants.PLAYER_1 : constants.PLAYER_2;

const getOtherPlayer = (playingAs) =>
  playingAs === constants.PLAYER_1 ? constants.PLAYER_2 : constants.PLAYER_1;

const getLastMove = (chess) => {
  const history = chess.history({ verbose: true });
  return history[history.length - 1];
};

const getLichessToken = (playingAs = '') =>
  playingAs.toLowerCase() === constants.PLAYER_1
    ? process.env.CARRIE_LICHESS_TOKEN
    : process.env.LARRY_LICHESS_TOKEN;

const buildAuthHeader = (playingAs) => ({
  Authorization: 'Bearer ' + getLichessToken(playingAs),
});

const getRandomInt = (max) => Math.floor(Math.random() * max);

const getRandomMove = (chess) => {
  const candidateMoves = chess.moves();
  return candidateMoves[getRandomInt(candidateMoves.length)];
};

module.exports = {
  getChessEmoji,
  getRandomPlayer,
  getOtherPlayer,
  getLastMove,
  buildAuthHeader,
  getLichessToken,
  getRandomInt,
  getRandomMove,
};
