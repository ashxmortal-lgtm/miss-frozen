import { RPS_ROUNDS, RPS_MOVES } from './constants.js';

const WINNING = new Map([
  ['rock|scissors', 'rock'],
  ['scissors|rock', 'rock'],
  ['rock|paper', 'paper'],
  ['paper|rock', 'paper'],
  ['paper|scissors', 'scissors'],
  ['scissors|paper', 'scissors'],
]);

export function normalizeMove(move) {
  if (move == null) return null;
  const t = String(move).trim().toLowerCase();
  if (t === 'rock' || t === 'stone' || t === 'r') return 'rock';
  if (t === 'paper' || t === 'p') return 'paper';
  if (t === 'scissors' || t === 'scissor' || t === 's') return 'scissors';
  return null;
}

/** Multiplayer RPS: set of unique moves — 1 or 3 → draw; 2 → winners who picked the winning move. */
export function resolveRound(choices) {
  const norm = {};
  for (const [k, raw] of Object.entries(choices || {})) {
    const uid = Number(k);
    if (!Number.isFinite(uid)) continue;
    const m = normalizeMove(raw);
    if (m) norm[uid] = m;
  }
  const moves = [...new Set(Object.values(norm))];
  if (moves.length !== 2) {
    return { type: 'draw', winning_move: null, winners: [], losers: Object.keys(norm).map(Number) };
  }
  const key = `${moves[0]}|${moves[1]}`;
  const winning = WINNING.get(key);
  if (!winning) {
    return { type: 'draw', winning_move: null, winners: [], losers: Object.keys(norm).map(Number) };
  }
  const winners = [];
  const losers = [];
  for (const [uid, m] of Object.entries(norm)) {
    (m === winning ? winners : losers).push(Number(uid));
  }
  return { type: 'win', winning_move: winning, winners, losers };
}

export function leaders(scores) {
  const parsed = {};
  for (const [k, v] of Object.entries(scores || {})) {
    const uid = Number(k);
    if (Number.isFinite(uid)) parsed[uid] = Number(v) || 0;
  }
  const vals = Object.values(parsed);
  if (!vals.length) return [];
  const hi = Math.max(...vals);
  return Object.keys(parsed).map(Number).filter((id) => parsed[id] === hi);
}

export function matchWinner(scores, roundNumber, suddenDeath = false) {
  const L = leaders(scores);
  if (L.length !== 1) return null;
  if (suddenDeath || Number(roundNumber) >= RPS_ROUNDS) return L[0];
  return null;
}

export function applyScores(scores, resolution) {
  const nxt = {};
  for (const [k, v] of Object.entries(scores || {})) nxt[String(k)] = Number(v) || 0;
  if (resolution?.type === 'win') {
    for (const uid of resolution.winners || []) {
      const key = String(uid);
      nxt[key] = (nxt[key] || 0) + 1;
    }
  }
  return nxt;
}

export function initRpsState(creatorId, username, firstName, opponent = null) {
  const players = [{ id: Number(creatorId), username, first_name: firstName }];
  if (opponent?.id) {
    players.push({
      id: Number(opponent.id),
      username: opponent.username || null,
      first_name: opponent.first_name || null,
    });
  }
  const ids = players.map((p) => p.id);
  return {
    players,
    round: 1,
    choices: {},
    scores: Object.fromEntries(ids.map((i) => [String(i), 0])),
    round_history: [],
    active_ids: ids,
    phase: 'lobby',
    sudden_death: false,
    settled: false,
    last_resolution: null,
  };
}

export { RPS_MOVES };
