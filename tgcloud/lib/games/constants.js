/** Game Hub constants — ported from Python xoxo.py (XOXO + RPS only). */

export const COIN = '🍥';
export const MIN_STAKE = 500;
export const MAX_STAKE = 1_000_000_000;
export const STAKE_PRESETS = [500, 1000, 2000, 5000, 10000];
export const TURN_TIMEOUT_SEC = 120;
export const LOBBY_IDLE_SEC = 10 * 60;

export const GAME_XOXO = 'xoxo';
export const GAME_RPS = 'rps';

export const STATUS_STAKE = 'stake_select';
export const STATUS_CUSTOM = 'custom_stake';
export const STATUS_CHALLENGE = 'challenge_pending';
export const STATUS_WAITING = 'waiting';
export const STATUS_PLAYING = 'playing';
export const STATUS_FINISHED = 'finished';
export const STATUS_CANCELLED = 'cancelled';

export const ACTIVE_STATUSES = [
  STATUS_STAKE, STATUS_CUSTOM, STATUS_CHALLENGE, STATUS_WAITING, STATUS_PLAYING,
];

export const RESULT_WIN = 'win';
export const RESULT_DRAW = 'draw';
export const RESULT_TIMEOUT = 'timeout';
export const RESULT_CANCEL = 'cancel';

export const RPS_MIN_PLAYERS = 2;
export const RPS_MAX_PLAYERS = 4;
export const RPS_ROUNDS = 3;
export const RPS_MOVES = ['rock', 'paper', 'scissors'];
export const RPS_GLYPH = { rock: '🪨', paper: '📄', scissors: '✂️' };
export const RPS_NAME = { rock: 'Stone', paper: 'Paper', scissors: 'Scissors' };

export const CELL_EMPTY = '⬜';
export const CELL_X = '❌';
export const CELL_O = '⭕';

export const WIN_LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6],
];
