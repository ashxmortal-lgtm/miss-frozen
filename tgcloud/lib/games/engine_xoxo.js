import { WIN_LINES } from './constants.js';

export function emptyBoard() {
  return ['', '', '', '', '', '', '', '', ''];
}

export function checkWinner(board) {
  for (const [a, b, c] of WIN_LINES) {
    if (board[a] && board[a] === board[b] && board[a] === board[c]) return board[a];
  }
  if (board.every(Boolean)) return 'draw';
  return null;
}

export function applyMove(board, cell, mark) {
  if (mark !== 'X' && mark !== 'O') return null;
  const i = Number(cell);
  if (!Number.isInteger(i) || i < 0 || i > 8 || board[i]) return null;
  const nxt = board.slice();
  nxt[i] = mark;
  return nxt;
}
