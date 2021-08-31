module.exports = {
    getChessEmoji: (color, piece) => {
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
      },
};
