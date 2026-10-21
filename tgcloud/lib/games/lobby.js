/**
 * Lobby + stake + settle logic for XOXO and RPS.
 */
import { db } from 'sdk';
import { sql } from 'sdk/db';
import {
  MIN_STAKE, MAX_STAKE, TURN_TIMEOUT_SEC,
  GAME_XOXO, GAME_RPS,
  STATUS_STAKE, STATUS_CUSTOM, STATUS_CHALLENGE, STATUS_WAITING,
  STATUS_PLAYING, STATUS_FINISHED, STATUS_CANCELLED,
  RESULT_WIN, RESULT_DRAW, RESULT_TIMEOUT, RESULT_CANCEL,
  ACTIVE_STATUSES, RPS_MIN_PLAYERS, RPS_MAX_PLAYERS, RPS_ROUNDS,
  CELL_EMPTY, CELL_X, CELL_O, COIN,
} from './constants.js';
import { emptyBoard, checkWinner, applyMove } from './engine_xoxo.js';
import {
  initRpsState, normalizeMove, resolveRound, applyScores,
  matchWinner, leaders,
} from './engine_rps.js';
import { p, h } from './rich.js';
import { style, mention } from '../texts.js';

const now = () => Math.floor(Date.now() / 1000);

function title(gt) {
  return gt === GAME_RPS ? '𝑹𝑷𝑺' : '𝑿𝑶𝑿𝑶';
}

function pfx(gt) {
  return gt === GAME_RPS ? 'rps' : 'xo';
}

function matchCode(id, gt) {
  return `${gt === GAME_RPS ? 'RPS' : 'XOXO'}-${String(id).padStart(4, '0')}`;
}

async function balanceOf(uid) {
  const r = await db.get(sql`SELECT balance FROM users WHERE telegram_id = ${uid}`);
  return r ? Number(r.balance) : 0;
}

async function ensureUser(uid, username, firstName) {
  await db.run(sql`INSERT OR IGNORE INTO users (telegram_id, balance) VALUES (${uid}, 0)`);
  if (username || firstName) {
    await db.run(sql`
      UPDATE users SET username = COALESCE(${username ? String(username).toLowerCase() : null}, username),
        first_name = COALESCE(${firstName || null}, first_name)
      WHERE telegram_id = ${uid}
    `);
  }
}

async function txExists(key) {
  const r = await db.get(sql`SELECT 1 AS x FROM game_tx WHERE key = ${key}`);
  return !!r;
}

async function txPut(key) {
  await db.run(sql`INSERT OR IGNORE INTO game_tx (key, created_at) VALUES (${key}, ${now()})`);
}

function parseBoard(raw) {
  try {
    const b = JSON.parse(raw || '[]');
    if (Array.isArray(b) && b.length === 9) return b.map((c) => (c === 'X' || c === 'O' ? c : ''));
  } catch (_) {}
  return emptyBoard();
}

function parseState(raw) {
  try {
    const o = JSON.parse(raw || '{}');
    return o && typeof o === 'object' ? o : {};
  } catch (_) {
    return {};
  }
}

function rowToLobby(r) {
  if (!r) return null;
  return {
    lobby_id: r.id,
    chat_id: r.chat_id,
    message_id: r.message_id,
    creator_id: r.creator_id,
    player_x_id: r.player_x_id,
    player_o_id: r.player_o_id,
    player_x_username: r.player_x_username,
    player_x_first_name: r.player_x_first_name,
    player_o_username: r.player_o_username,
    player_o_first_name: r.player_o_first_name,
    status: r.status,
    stake: r.stake,
    pot: r.pot,
    board: parseBoard(r.board),
    current_turn: r.current_turn,
    created_at: r.created_at,
    updated_at: r.updated_at,
    turn_started_at: r.turn_started_at,
    winner_id: r.winner_id,
    result: r.result,
    stakes_reserved: r.stakes_reserved,
    kind: r.kind,
    game_type: r.game_type || GAME_XOXO,
    game_state: parseState(r.game_state),
  };
}

export async function getLobby(lobbyId) {
  const r = await db.get(sql`SELECT * FROM game_lobbies WHERE id = ${lobbyId}`);
  return rowToLobby(r);
}

export async function getPlayerLobbyId(userId) {
  const r = await db.get(sql`SELECT lobby_id FROM game_active_players WHERE user_id = ${userId}`);
  return r ? r.lobby_id : null;
}

async function bindPlayer(userId, lobbyId) {
  await db.run(sql`
    INSERT INTO game_active_players (user_id, lobby_id) VALUES (${userId}, ${lobbyId})
    ON CONFLICT(user_id) DO UPDATE SET lobby_id = excluded.lobby_id
  `);
}

async function unbindLobby(lobby) {
  const ids = stakeUserIds(lobby);
  for (const uid of ids) {
    await db.run(sql`DELETE FROM game_active_players WHERE user_id = ${uid} AND lobby_id = ${lobby.lobby_id}`);
  }
}

export async function clearPlayerLock(userId) {
  await db.run(sql`DELETE FROM game_active_players WHERE user_id = ${userId}`);
}

function stakeUserIds(lobby) {
  if (lobby.game_type === GAME_RPS) {
    const players = lobby.game_state?.players || [];
    const ids = players.map((p) => Number(p.id)).filter(Boolean);
    if (ids.length) return [...new Set(ids)];
  }
  const ids = [];
  if (lobby.player_x_id) ids.push(Number(lobby.player_x_id));
  if (lobby.player_o_id) ids.push(Number(lobby.player_o_id));
  return ids;
}

export function parseStake(raw) {
  const text = String(raw ?? '').trim().replace(/,/g, '').replace(/_/g, '');
  if (!/^[0-9]+$/.test(text) || text.length > 12) return { ok: false, error: 'Stake must be a positive whole number.' };
  const amount = Number(text);
  if (amount < MIN_STAKE) return { ok: false, error: `Minimum stake is ${MIN_STAKE.toLocaleString()} ${COIN}.` };
  if (amount > Math.floor(MAX_STAKE / 2)) return { ok: false, error: 'That amount is too large.' };
  return { ok: true, amount };
}

export async function createLobby(chatId, creatorId, username, firstName, { kind = 'open', opponent = null, gameType = GAME_XOXO } = {}) {
  await ensureUser(creatorId, username, firstName);
  const existing = await getPlayerLobbyId(creatorId);
  if (existing) {
    const L = await getLobby(existing);
    if (L && ACTIVE_STATUSES.includes(L.status)) return { ok: false, error: 'busy' };
    await clearPlayerLock(creatorId);
  }
  if (opponent?.id) {
    await ensureUser(opponent.id, opponent.username, opponent.first_name);
    const oe = await getPlayerLobbyId(opponent.id);
    if (oe) {
      const L = await getLobby(oe);
      if (L && ACTIVE_STATUSES.includes(L.status)) return { ok: false, error: 'opponent_busy' };
      await clearPlayerLock(opponent.id);
    }
  }

  const t = now();
  const status = opponent?.id ? STATUS_STAKE : STATUS_STAKE;
  const kindVal = opponent?.id ? 'direct' : 'open';
  let gameState = '{}';
  if (gameType === GAME_RPS) {
    gameState = JSON.stringify(initRpsState(creatorId, username, firstName, opponent));
  }

  const res = await db.run(sql`
    INSERT INTO game_lobbies (
      chat_id, creator_id, player_x_id, player_o_id,
      player_x_username, player_x_first_name, player_o_username, player_o_first_name,
      status, stake, pot, board, created_at, updated_at, kind, game_type, game_state
    ) VALUES (
      ${chatId}, ${creatorId}, ${creatorId}, ${opponent?.id || null},
      ${username || null}, ${firstName || null},
      ${opponent?.username || null}, ${opponent?.first_name || null},
      ${status}, 0, 0, ${JSON.stringify(emptyBoard())}, ${t}, ${t},
      ${kindVal}, ${gameType}, ${gameState}
    )
  `);
  // tgcloud may return lastInsertRowid differently
  const row = await db.get(sql`
    SELECT * FROM game_lobbies WHERE creator_id = ${creatorId} AND chat_id = ${chatId}
    ORDER BY id DESC LIMIT 1
  `);
  const lobby = rowToLobby(row);
  await bindPlayer(creatorId, lobby.lobby_id);
  if (opponent?.id) await bindPlayer(opponent.id, lobby.lobby_id);
  return { ok: true, lobby };
}

export async function setLobbyMessage(lobbyId, messageId) {
  await db.run(sql`UPDATE game_lobbies SET message_id = ${messageId}, updated_at = ${now()} WHERE id = ${lobbyId}`);
}

async function saveLobby(lobby, fields) {
  const t = now();
  await db.run(sql`
    UPDATE game_lobbies SET
      status = ${fields.status ?? lobby.status},
      stake = ${fields.stake ?? lobby.stake},
      pot = ${fields.pot ?? lobby.pot},
      board = ${JSON.stringify(fields.board ?? lobby.board)},
      current_turn = ${fields.current_turn !== undefined ? fields.current_turn : lobby.current_turn},
      turn_started_at = ${fields.turn_started_at !== undefined ? fields.turn_started_at : lobby.turn_started_at},
      player_o_id = ${fields.player_o_id !== undefined ? fields.player_o_id : lobby.player_o_id},
      player_o_username = ${fields.player_o_username !== undefined ? fields.player_o_username : lobby.player_o_username},
      player_o_first_name = ${fields.player_o_first_name !== undefined ? fields.player_o_first_name : lobby.player_o_first_name},
      stakes_reserved = ${fields.stakes_reserved !== undefined ? fields.stakes_reserved : lobby.stakes_reserved},
      winner_id = ${fields.winner_id !== undefined ? fields.winner_id : lobby.winner_id},
      result = ${fields.result !== undefined ? fields.result : lobby.result},
      game_state = ${JSON.stringify(fields.game_state ?? lobby.game_state)},
      updated_at = ${t}
    WHERE id = ${lobby.lobby_id}
  `);
  return getLobby(lobby.lobby_id);
}

async function reserveStakes(lobby) {
  if (Number(lobby.stakes_reserved) === 1) return { ok: true };
  const stake = Number(lobby.stake);
  const uids = stakeUserIds(lobby);
  if (uids.length < 2) return { ok: false, error: 'missing' };
  for (const uid of uids) {
    if ((await balanceOf(uid)) < stake) return { ok: false, error: 'poor', uid };
  }
  const code = matchCode(lobby.lobby_id, lobby.game_type);
  for (const uid of uids) {
    const key = `${lobby.game_type}_stake:${lobby.lobby_id}:${uid}`;
    if (await txExists(key)) continue;
    const paid = await db.run(sql`
      UPDATE users SET balance = balance - ${stake}
      WHERE telegram_id = ${uid} AND balance >= ${stake}
    `);
    if (!paid.rowsAffected) return { ok: false, error: 'poor', uid };
    await txPut(key);
  }
  return { ok: true };
}

async function payoutWinner(lobby, winnerId) {
  const pot = Number(lobby.pot) || 0;
  if (pot <= 0 || !winnerId) return;
  const key = `${lobby.game_type}_settle:${lobby.lobby_id}`;
  if (await txExists(key)) return;
  await db.run(sql`UPDATE users SET balance = balance + ${pot} WHERE telegram_id = ${winnerId}`);
  await txPut(key);
}

async function refundStakes(lobby) {
  if (Number(lobby.stakes_reserved) !== 1) return;
  const stake = Number(lobby.stake) || 0;
  if (stake <= 0) return;
  for (const uid of stakeUserIds(lobby)) {
    const key = `${lobby.game_type}_refund:${lobby.lobby_id}:${uid}`;
    if (await txExists(key)) continue;
    await db.run(sql`UPDATE users SET balance = balance + ${stake} WHERE telegram_id = ${uid}`);
    await txPut(key);
  }
}

async function bumpStats(userId, gameType, { win = false, loss = false, draw = false, coinsDelta = 0 } = {}) {
  if (gameType === GAME_RPS) {
    await db.run(sql`INSERT OR IGNORE INTO rps_stats (user_id) VALUES (${userId})`);
    const row = await db.get(sql`SELECT * FROM rps_stats WHERE user_id = ${userId}`);
    let { games, wins, losses, draws, coins_won, coins_lost, streak, best_streak } = row;
    games = Number(games) + 1;
    if (win) { wins = Number(wins) + 1; streak = streak >= 0 ? Number(streak) + 1 : 1; best_streak = Math.max(Number(best_streak), streak); }
    else if (loss) { losses = Number(losses) + 1; streak = streak <= 0 ? Number(streak) - 1 : -1; }
    else if (draw) { draws = Number(draws) + 1; streak = 0; }
    if (coinsDelta > 0) coins_won = Number(coins_won) + coinsDelta;
    if (coinsDelta < 0) coins_lost = Number(coins_lost) - coinsDelta;
    await db.run(sql`
      UPDATE rps_stats SET games=${games}, wins=${wins}, losses=${losses}, draws=${draws},
        coins_won=${coins_won}, coins_lost=${coins_lost}, streak=${streak}, best_streak=${best_streak}
      WHERE user_id = ${userId}
    `);
  } else {
    await db.run(sql`INSERT OR IGNORE INTO xoxo_stats (user_id) VALUES (${userId})`);
    const row = await db.get(sql`SELECT * FROM xoxo_stats WHERE user_id = ${userId}`);
    let { games, wins, losses, draws, coins_won, coins_lost, streak, best_streak } = row;
    games = Number(games) + 1;
    if (win) { wins = Number(wins) + 1; streak = streak >= 0 ? Number(streak) + 1 : 1; best_streak = Math.max(Number(best_streak), streak); }
    else if (loss) { losses = Number(losses) + 1; streak = streak <= 0 ? Number(streak) - 1 : -1; }
    else if (draw) { draws = Number(draws) + 1; streak = 0; }
    if (coinsDelta > 0) coins_won = Number(coins_won) + coinsDelta;
    if (coinsDelta < 0) coins_lost = Number(coins_lost) - coinsDelta;
    await db.run(sql`
      UPDATE xoxo_stats SET games=${games}, wins=${wins}, losses=${losses}, draws=${draws},
        coins_won=${coins_won}, coins_lost=${coins_lost}, streak=${streak}, best_streak=${best_streak}
      WHERE user_id = ${userId}
    `);
  }
}

async function finishLobby(lobby, result, winnerId) {
  const pot = Number(lobby.pot) || 0;
  if (result === RESULT_WIN && winnerId) {
    await payoutWinner(lobby, winnerId);
  } else if (result === RESULT_DRAW || result === RESULT_CANCEL) {
    await refundStakes({ ...lobby, stakes_reserved: 1 });
  } else if (result === RESULT_TIMEOUT && winnerId) {
    await payoutWinner(lobby, winnerId);
  } else {
    await refundStakes({ ...lobby, stakes_reserved: 1 });
  }

  const updated = await saveLobby(lobby, {
    status: STATUS_FINISHED,
    result,
    winner_id: winnerId || null,
    current_turn: null,
  });

  await db.run(sql`
    INSERT OR REPLACE INTO game_matches (lobby_id, chat_id, player_x_id, player_o_id, stake, pot, result, winner_id, finished_at, game_type)
    VALUES (${lobby.lobby_id}, ${lobby.chat_id}, ${lobby.player_x_id}, ${lobby.player_o_id},
      ${lobby.stake}, ${lobby.pot}, ${result}, ${winnerId || null}, ${now()}, ${lobby.game_type})
  `);

  const uids = stakeUserIds(lobby);
  for (const uid of uids) {
    if (result === RESULT_DRAW) {
      await bumpStats(uid, lobby.game_type, { draw: true });
    } else if (result === RESULT_WIN || result === RESULT_TIMEOUT) {
      if (uid === winnerId) await bumpStats(uid, lobby.game_type, { win: true, coinsDelta: pot - Number(lobby.stake) });
      else await bumpStats(uid, lobby.game_type, { loss: true, coinsDelta: -Number(lobby.stake) });
    }
  }
  await unbindLobby(updated);
  return updated;
}

export async function setStake(lobbyId, userId, amountRaw) {
  const lobby = await getLobby(lobbyId);
  if (!lobby) return { ok: false, error: 'missing' };
  if (Number(lobby.creator_id) !== Number(userId)) return { ok: false, error: 'not_creator' };
  if (lobby.status !== STATUS_STAKE && lobby.status !== STATUS_CUSTOM) return { ok: false, error: 'state' };
  const parsed = parseStake(amountRaw);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  if ((await balanceOf(userId)) < parsed.amount) return { ok: false, error: 'poor' };

  const gt = lobby.game_type;
  let nextStatus = STATUS_WAITING;
  if (lobby.kind === 'direct') nextStatus = STATUS_CHALLENGE;
  if (gt === GAME_RPS && lobby.kind === 'open') nextStatus = STATUS_WAITING;

  const updated = await saveLobby(lobby, {
    stake: parsed.amount,
    pot: 0,
    status: nextStatus,
  });
  return { ok: true, lobby: updated };
}

export async function startCustomStake(lobbyId, userId) {
  const lobby = await getLobby(lobbyId);
  if (!lobby) return { ok: false, error: 'missing' };
  if (Number(lobby.creator_id) !== Number(userId)) return { ok: false, error: 'not_creator' };
  if (lobby.status !== STATUS_STAKE) return { ok: false, error: 'state' };
  const updated = await saveLobby(lobby, { status: STATUS_CUSTOM });
  return { ok: true, lobby: updated };
}

export async function joinLobby(lobbyId, userId, username, firstName, chatId) {
  const lobby = await getLobby(lobbyId);
  if (!lobby) return { ok: false, error: 'missing' };
  if (Number(lobby.chat_id) !== Number(chatId)) return { ok: false, error: 'wrong_chat' };
  if (Number(lobby.creator_id) === Number(userId)) return { ok: false, error: 'self' };

  const existing = await getPlayerLobbyId(userId);
  if (existing && existing !== lobbyId) {
    const L = await getLobby(existing);
    if (L && ACTIVE_STATUSES.includes(L.status)) return { ok: false, error: 'busy' };
  }

  await ensureUser(userId, username, firstName);
  if ((await balanceOf(userId)) < Number(lobby.stake)) return { ok: false, error: 'poor' };
  if ((await balanceOf(lobby.player_x_id)) < Number(lobby.stake)) return { ok: false, error: 'poor_x' };

  if (lobby.game_type === GAME_RPS) {
    const gs = { ...lobby.game_state };
    const players = [...(gs.players || [])];
    if (players.some((p) => Number(p.id) === Number(userId))) return { ok: false, error: 'taken' };
    if (players.length >= RPS_MAX_PLAYERS) return { ok: false, error: 'full' };
    if (lobby.status !== STATUS_WAITING) return { ok: false, error: 'state' };
    players.push({ id: Number(userId), username, first_name: firstName });
    gs.players = players;
    gs.active_ids = players.map((p) => p.id);
    gs.scores = Object.fromEntries(players.map((p) => [String(p.id), gs.scores?.[String(p.id)] || 0]));
    await bindPlayer(userId, lobbyId);
    const updated = await saveLobby(lobby, { game_state: gs });
    return { ok: true, lobby: updated };
  }

  // XOXO
  if (lobby.status !== STATUS_WAITING) return { ok: false, error: 'state' };
  if (lobby.player_o_id) return { ok: false, error: 'taken' };

  await bindPlayer(userId, lobbyId);
  let updated = await saveLobby(lobby, {
    player_o_id: userId,
    player_o_username: username || null,
    player_o_first_name: firstName || null,
  });

  // Reserve and start
  updated.stake = Number(updated.stake);
  updated.pot = updated.stake * 2;
  const reserved = await reserveStakes(updated);
  if (!reserved.ok) {
    await saveLobby(updated, {
      player_o_id: null,
      player_o_username: null,
      player_o_first_name: null,
    });
    await clearPlayerLock(userId);
    return { ok: false, error: reserved.error === 'poor' ? 'poor' : 'poor_x' };
  }
  updated = await saveLobby(updated, {
    stakes_reserved: 1,
    pot: updated.stake * 2,
    status: STATUS_PLAYING,
    current_turn: 'X',
    turn_started_at: now(),
    board: emptyBoard(),
  });
  return { ok: true, lobby: updated };
}

export async function acceptChallenge(lobbyId, userId, chatId) {
  const lobby = await getLobby(lobbyId);
  if (!lobby) return { ok: false, error: 'missing' };
  if (Number(lobby.chat_id) !== Number(chatId)) return { ok: false, error: 'wrong_chat' };
  if (Number(lobby.player_o_id) !== Number(userId)) return { ok: false, error: 'not_opponent' };
  if (lobby.status !== STATUS_CHALLENGE) return { ok: false, error: 'state' };
  if ((await balanceOf(userId)) < Number(lobby.stake)) return { ok: false, error: 'poor' };
  if ((await balanceOf(lobby.player_x_id)) < Number(lobby.stake)) return { ok: false, error: 'poor_x' };

  if (lobby.game_type === GAME_RPS) {
    return startRpsMatch(lobbyId, lobby.creator_id, chatId);
  }

  let updated = { ...lobby, pot: Number(lobby.stake) * 2 };
  const reserved = await reserveStakes(updated);
  if (!reserved.ok) return { ok: false, error: reserved.error === 'poor' ? 'poor' : 'poor_x' };
  updated = await saveLobby(lobby, {
    stakes_reserved: 1,
    pot: Number(lobby.stake) * 2,
    status: STATUS_PLAYING,
    current_turn: 'X',
    turn_started_at: now(),
    board: emptyBoard(),
  });
  return { ok: true, lobby: updated };
}

export async function startRpsMatch(lobbyId, userId, chatId) {
  const lobby = await getLobby(lobbyId);
  if (!lobby) return { ok: false, error: 'missing' };
  if (Number(lobby.chat_id) !== Number(chatId)) return { ok: false, error: 'wrong_chat' };
  if (Number(lobby.creator_id) !== Number(userId)) return { ok: false, error: 'not_creator' };
  if (lobby.status !== STATUS_WAITING && lobby.status !== STATUS_CHALLENGE) return { ok: false, error: 'state' };
  const players = lobby.game_state?.players || [];
  if (players.length < RPS_MIN_PLAYERS) return { ok: false, error: 'need_players' };
  if (players.length > RPS_MAX_PLAYERS) return { ok: false, error: 'full' };

  const stake = Number(lobby.stake);
  for (const pl of players) {
    if ((await balanceOf(pl.id)) < stake) return { ok: false, error: 'poor' };
  }
  const pot = stake * players.length;
  let updated = { ...lobby, pot, game_state: lobby.game_state };
  const reserved = await reserveStakes(updated);
  if (!reserved.ok) return { ok: false, error: 'poor' };

  const gs = { ...lobby.game_state, phase: 'choosing', choices: {}, round: 1, sudden_death: false };
  updated = await saveLobby(lobby, {
    stakes_reserved: 1,
    pot,
    status: STATUS_PLAYING,
    turn_started_at: now(),
    game_state: gs,
  });
  return { ok: true, lobby: updated };
}

export async function cancelLobby(lobbyId, userId) {
  const lobby = await getLobby(lobbyId);
  if (!lobby) return { ok: false, error: 'missing' };
  if (Number(lobby.creator_id) !== Number(userId)) return { ok: false, error: 'not_creator' };
  if (lobby.status === STATUS_PLAYING) return { ok: false, error: 'started' };
  if (Number(lobby.stakes_reserved) === 1) await refundStakes(lobby);
  const updated = await saveLobby(lobby, { status: STATUS_CANCELLED, result: RESULT_CANCEL });
  await unbindLobby(updated);
  return { ok: true, lobby: updated };
}

export async function abortRpsMatch(lobbyId, userId) {
  const lobby = await getLobby(lobbyId);
  if (!lobby) return { ok: false, error: "missing" };
  if (lobby.status !== STATUS_PLAYING) return { ok: false, error: "state" };
  if (lobby.game_type !== GAME_RPS) return { ok: false, error: "wrong_game" };

  const players = (lobby.game_state?.players || []).map((p) => Number(p.id));
  if (!players.includes(Number(userId))) {
    return { ok: false, error: "not_participant" };
  }

  if (Number(lobby.stakes_reserved) === 1) await refundStakes(lobby);
  const updated = await saveLobby(lobby, {
    status: STATUS_CANCELLED,
    result: RESULT_CANCEL,
    winner_id: null,
    current_turn: null,
  });
  await unbindLobby(updated);
  return { ok: true, lobby: updated };
}

export async function abortXoxoMatch(lobbyId, userId) {
  const lobby = await getLobby(lobbyId);
  if (!lobby) return { ok: false, error: 'missing' };
  if (lobby.status !== STATUS_PLAYING) return { ok: false, error: 'state' };
  if (lobby.game_type !== GAME_XOXO) return { ok: false, error: 'wrong_game' };

  const participantIds = [lobby.player_x_id, lobby.player_o_id].map(Number);
  if (!participantIds.includes(Number(userId))) {
    return { ok: false, error: 'not_participant' };
  }

  if (Number(lobby.stakes_reserved) === 1) await refundStakes(lobby);
  const updated = await saveLobby(lobby, {
    status: STATUS_CANCELLED,
    result: RESULT_CANCEL,
    winner_id: null,
    current_turn: null,
  });
  await unbindLobby(updated);
  return { ok: true, lobby: updated };
}

async function settleExpiredXoxoTurn(lobby) {
  if (!lobby.turn_started_at || now() - Number(lobby.turn_started_at) <= TURN_TIMEOUT_SEC) {
    return null;
  }
  const turn = lobby.current_turn || 'X';
  const winnerId = turn === 'X' ? lobby.player_o_id : lobby.player_x_id;
  return finishLobby(lobby, RESULT_TIMEOUT, winnerId);
}

export async function makeMove(lobbyId, userId, cell, chatId) {
  let lobby = await getLobby(lobbyId);
  if (!lobby) return { ok: false, error: 'missing' };
  if (lobby.status !== STATUS_PLAYING) return { ok: false, error: 'state' };
  if (lobby.game_type !== GAME_XOXO) return { ok: false, error: 'wrong_game' };

  const timedOut = await settleExpiredXoxoTurn(lobby);
  if (timedOut) return { ok: true, lobby: timedOut, timed: true };

  const turn = lobby.current_turn || 'X';
  const turnId = turn === 'X' ? lobby.player_x_id : lobby.player_o_id;
  if (Number(turnId) !== Number(userId)) return { ok: false, error: 'not_turn' };

  const nxt = applyMove(lobby.board, cell, turn);
  if (!nxt) return { ok: false, error: 'occupied' };
  const outcome = checkWinner(nxt);

  if (outcome === 'X') {
    lobby.board = nxt;
    lobby = await finishLobby(lobby, RESULT_WIN, lobby.player_x_id);
  } else if (outcome === 'O') {
    lobby.board = nxt;
    lobby = await finishLobby(lobby, RESULT_WIN, lobby.player_o_id);
  } else if (outcome === 'draw') {
    lobby.board = nxt;
    lobby = await finishLobby(lobby, RESULT_DRAW, null);
  } else {
    lobby = await saveLobby(lobby, {
      board: nxt,
      current_turn: turn === 'X' ? 'O' : 'X',
      turn_started_at: now(),
    });
  }
  return { ok: true, lobby };
}

export async function rpsSubmitMove(lobbyId, userId, move, chatId) {
  let lobby = await getLobby(lobbyId);
  if (!lobby) return { ok: false, error: 'missing' };
  if (lobby.status !== STATUS_PLAYING || lobby.game_type !== GAME_RPS) return { ok: false, error: 'state' };
  const gs = { ...lobby.game_state };
  if (gs.phase !== 'choosing') return { ok: false, error: 'phase' };
  const m = normalizeMove(move);
  if (!m) return { ok: false, error: 'bad_move' };
  const active = (gs.active_ids || []).map(Number);
  if (!active.includes(Number(userId))) return { ok: false, error: 'not_player' };
  if (gs.choices?.[String(userId)]) return { ok: false, error: 'already' };

  gs.choices = { ...(gs.choices || {}), [String(userId)]: m };
  const allIn = active.every((id) => gs.choices[String(id)]);
  if (!allIn) {
    lobby = await saveLobby(lobby, { game_state: gs });
    return { ok: true, lobby, revealed: false };
  }

  // Resolve round
  const resolution = resolveRound(gs.choices);
  gs.scores = applyScores(gs.scores, resolution);
  gs.last_resolution = resolution;
  gs.round_history = [...(gs.round_history || []), { round: gs.round, ...resolution, choices: { ...gs.choices } }];
  gs.phase = 'revealed';
  gs.choices = {};
  lobby = await saveLobby(lobby, { game_state: gs, turn_started_at: now() });
  return { ok: true, lobby, revealed: true };
}

export async function rpsAdvanceReveal(lobbyId, userId) {
  let lobby = await getLobby(lobbyId);
  if (!lobby) return { ok: false, error: 'missing' };
  const gs = { ...lobby.game_state };
  if (gs.phase !== 'revealed') return { ok: false, error: 'phase' };

  const winner = matchWinner(gs.scores, gs.round, gs.sudden_death);
  if (winner) {
    gs.phase = 'done';
    gs.settled = true;
    lobby = await saveLobby(lobby, { game_state: gs });
    lobby = await finishLobby(lobby, RESULT_WIN, winner);
    return { ok: true, lobby };
  }

  // After normal rounds, if tie → sudden death
  if (!gs.sudden_death && Number(gs.round) >= RPS_ROUNDS) {
    const L = leaders(gs.scores);
    if (L.length > 1) {
      gs.sudden_death = true;
      gs.active_ids = L;
    }
  }

  gs.round = Number(gs.round) + 1;
  gs.phase = 'choosing';
  gs.choices = {};
  lobby = await saveLobby(lobby, { game_state: gs, turn_started_at: now() });
  return { ok: true, lobby };
}

export async function getStats(userId, gameType) {
  if (gameType === GAME_RPS) {
    await db.run(sql`INSERT OR IGNORE INTO rps_stats (user_id) VALUES (${userId})`);
    return db.get(sql`SELECT * FROM rps_stats WHERE user_id = ${userId}`);
  }
  await db.run(sql`INSERT OR IGNORE INTO xoxo_stats (user_id) VALUES (${userId})`);
  return db.get(sql`SELECT * FROM xoxo_stats WHERE user_id = ${userId}`);
}

// ---------- Render (body HTML + classic keyboard for rich conversion) ----------

function glyph(mark) {
  if (mark === 'X') return CELL_X;
  if (mark === 'O') return CELL_O;
  return CELL_EMPTY;
}

export function stakeKeyboard(lobbyId, gameType) {
  const pr = pfx(gameType);
  return {
    inline_keyboard: [
      [
        { text: '500 🍥', callback_data: `${pr}:stake:${lobbyId}:500`, style: 'primary' },
        { text: 'Custom Amt', callback_data: `${pr}:custom:${lobbyId}`, style: 'primary' },
      ],
      [{ text: '◀️ Back', callback_data: `${pr}:cancel:${lobbyId}`, style: 'primary' }],
    ],
  };
}

export function boardKeyboard(lobby) {
  const pr = 'xo';
  const rows = [];
  for (let r = 0; r < 3; r++) {
    const row = [];
    for (let c = 0; c < 3; c++) {
      const i = r * 3 + c;
      const mark = lobby.board[i];
      row.push({
        text: mark ? glyph(mark) : CELL_EMPTY,
        callback_data: mark || lobby.status !== STATUS_PLAYING
          ? `${pr}:noop:${lobby.lobby_id}`
          : `${pr}:cell:${lobby.lobby_id}:${i}`,
        style: 'transparent',
      });
    }
    rows.push(row);
  }
  if (lobby.status === STATUS_PLAYING) {
    rows.push([{
      text: '🛑 ABORT MATCH',
      callback_data: `xo:abort:${lobby.lobby_id}`,
      style: 'primary',
    }]);
  }
  return { inline_keyboard: rows };
}

export function waitingKeyboard(lobby) {
  const pr = pfx(lobby.game_type);
  if (lobby.game_type === GAME_RPS) {
    const rows = [[{ text: '➕ JOIN', callback_data: `${pr}:join:${lobby.lobby_id}` }]];
    rows.push([{ text: '▶️ START', callback_data: `${pr}:start:${lobby.lobby_id}` }]);
    rows.push([{ text: '❌ CANCEL', callback_data: `${pr}:cancel:${lobby.lobby_id}` }]);
    return { inline_keyboard: rows };
  }
  return {
    inline_keyboard: [
      [{ text: '✅ JOIN', callback_data: `${pr}:join:${lobby.lobby_id}` }],
      [{ text: '❌ CANCEL', callback_data: `${pr}:cancel:${lobby.lobby_id}` }],
    ],
  };
}

export function challengeKeyboard(lobby) {
  const pr = pfx(lobby.game_type);
  return {
    inline_keyboard: [
      [{ text: '✅ ACCEPT', callback_data: `${pr}:accept:${lobby.lobby_id}` }],
      [{ text: '❌ CANCEL', callback_data: `${pr}:cancel:${lobby.lobby_id}` }],
    ],
  };
}

export function rpsMoveKeyboard(lobbyId) {
  return {
    inline_keyboard: [[
      { text: '🪨 Stone', callback_data: `rps:move:${lobbyId}:rock` },
      { text: '📄 Paper', callback_data: `rps:move:${lobbyId}:paper` },
      { text: '✂️ Scissors', callback_data: `rps:move:${lobbyId}:scissors` },
    ]],
  };
}

export function rpsRevealKeyboard(lobbyId) {
  return {
    inline_keyboard: [[{ text: '➡️ NEXT', callback_data: `rps:next:${lobbyId}` }]],
  };
}

export function renderLobby(lobby, viewerUser = null) {
  const gt = lobby.game_type || GAME_XOXO;
  const code = matchCode(lobby.lobby_id, gt);
  const t = title(gt);

  if (lobby.status === STATUS_STAKE) {
    const body = h(`${t} — CHOOSE STAKE`) + p(`Match <code>${code}</code>`) + p(`Minimum: ${MIN_STAKE.toLocaleString()} ${COIN}`);
    return { body, keyboard: stakeKeyboard(lobby.lobby_id, gt) };
  }
  if (lobby.status === STATUS_CUSTOM) {
    const body = h(`${t} — CUSTOM STAKE`) + p(`Send a whole number ≥ ${MIN_STAKE.toLocaleString()} ${COIN} in this chat.`);
    return { body, keyboard: { inline_keyboard: [[{ text: '❌ CANCEL', callback_data: `${pfx(gt)}:cancel:${lobby.lobby_id}` }]] } };
  }
  if (lobby.status === STATUS_CHALLENGE) {
    const body = h(`${t} CHALLENGE`) + p(`Stake: <b>${Number(lobby.stake).toLocaleString()} ${COIN}</b>`) + p('Waiting for accept…');
    return { body, keyboard: challengeKeyboard(lobby) };
  }
  if (lobby.status === STATUS_WAITING) {
    if (gt === GAME_RPS) {
      const players = lobby.game_state?.players || [];
      const lines = players.map((pl, i) => p(`${i + 1}. id ${pl.id}`));
      const body = h(`${t} LOBBY`) + p(`Stake: <b>${Number(lobby.stake).toLocaleString()} ${COIN}</b>`) + p(`Players ${players.length}/${RPS_MAX_PLAYERS}`) + lines.join('') + p('Creator presses START (min 2).');
      return { body, keyboard: waitingKeyboard(lobby) };
    }
    const body = h(`${t} OPEN`) + p(`Stake: <b>${Number(lobby.stake).toLocaleString()} ${COIN}</b>`) + p('Waiting for opponent…');
    return { body, keyboard: waitingKeyboard(lobby) };
  }
  if (lobby.status === STATUS_PLAYING) {
    if (gt === GAME_RPS) return renderRpsPlaying(lobby);
    const turn = lobby.current_turn || 'X';
    const isXTurn = turn === 'X';
    const currentPlayer = {
      id: isXTurn ? lobby.player_x_id : lobby.player_o_id,
      first_name: isXTurn ? lobby.player_x_first_name : lobby.player_o_first_name,
    };
    const turnSymbol = isXTurn ? '&#88;' : '&#79;';
    const body = p(`Turn: ${mention(currentPlayer)} ${turnSymbol}`)
      + p(`ᴘᴏᴛ: <b>${Number(lobby.pot).toLocaleString()} ${COIN}</b>`)
      + p(`ᴛᴜʀɴ: ${turn.toLowerCase()} ${isXTurn ? CELL_X : CELL_O}`)
      + p(lobby.board.map(glyph).join(''));
    return { body, keyboard: boardKeyboard(lobby) };
  }
  if (lobby.status === STATUS_FINISHED) {
    if (lobby.result === RESULT_WIN) {
      let winnerUser = null;
      if (lobby.winner_id) {
        if (Number(lobby.winner_id) === Number(lobby.player_x_id)) {
          winnerUser = { id: lobby.player_x_id, first_name: lobby.player_x_first_name, username: lobby.player_x_username };
        } else if (Number(lobby.winner_id) === Number(lobby.player_o_id)) {
          winnerUser = { id: lobby.player_o_id, first_name: lobby.player_o_first_name, username: lobby.player_o_username };
        } else if (lobby.game_type === GAME_RPS) {
          const pl = (lobby.game_state?.players || []).find((p) => Number(p.id) === Number(lobby.winner_id));
          if (pl) winnerUser = pl;
        }
      }
      const winMention = winnerUser ? mention(winnerUser) : "Winner";
      const gName = gt === GAME_RPS ? "Rps" : "Xoxo";
      const body = `<p><b>${gName} game over</b><br>Winner: ${winMention}<br>${Number(lobby.pot).toLocaleString()} 🍥 added to your account.</p>`;
      return { body, keyboard: { inline_keyboard: [] } };
    }
    let msg = "Finished.";
    if (lobby.result === RESULT_DRAW) msg = "Draw — stakes refunded.";
    else if (lobby.result === RESULT_TIMEOUT) msg = "Timeout — pot awarded.";
    const gName = gt === GAME_RPS ? "Rps" : "Xoxo";
    const body = p(`<b>${gName} game over</b>`) + p(msg);
    return { body, keyboard: { inline_keyboard: [] } };
  }
  if (lobby.status === STATUS_CANCELLED) {
    const msg = lobby.game_type === GAME_XOXO && lobby.turn_started_at
      ? 'Match aborted — both stakes refunded.'
      : 'Lobby closed.';
    return { body: h(`${t} CANCELLED`) + p(msg), keyboard: { inline_keyboard: [] } };
  }
  return { body: h(t), keyboard: { inline_keyboard: [] } };
}

function renderRpsPlaying(lobby) {
  const gs = lobby.game_state || {};
  const t = title(GAME_RPS);
  if (gs.phase === 'choosing') {
    const active = (gs.active_ids || []).map(Number);
    const locked = Object.keys(gs.choices || {}).length;
    const body = h(`${t} ROUND ${gs.round}${gs.sudden_death ? ' (SUDDEN DEATH)' : ''}`)
      + p(`Pot: <b>${Number(lobby.pot).toLocaleString()} ${COIN}</b>`)
      + p(`Locked in: ${locked}/${active.length}`)
      + p('Pick your move (hidden until all lock).');
    return { body, keyboard: rpsMoveKeyboard(lobby.lobby_id) };
  }
  if (gs.phase === 'revealed') {
    const res = gs.last_resolution || {};
    const winMove = res.winning_move ? p(`Winning move: <b>${res.winning_move}</b>`) : (res.type === 'win' ? '' : p('Round draw'));
    let winnerLine = '';
    if (res.winner_id) {
      const winPl = (gs.players || []).find((p) => Number(p.id) === Number(res.winner_id));
      if (winPl) winnerLine = p(`Winner: ${mention(winPl)}`);
    }
    const scoreItems = [];
    for (const pl of (gs.players || [])) {
      const sc = gs.scores?.[String(pl.id)] ?? 0;
      const nm = pl.first_name || pl.username || `User ${pl.id}`;
      scoreItems.push(`${nm}: ${sc}`);
    }
    const scoresText = p(`Scores: ${scoreItems.join(', ')}`);
    const body = h(`${t} REVEAL`) + winMove + winnerLine + scoresText;
    return { body, keyboard: rpsRevealKeyboard(lobby.lobby_id) };
  }
  return { body: h(t) + p('…'), keyboard: { inline_keyboard: [] } };
}

export function gamesListBody() {
  return h('🎮 GAME HUB')
    + p('<b>/xoxo</b> — Tic-Tac-Toe (2 players, stakes)')
    + p('<b>/rps</b> — Rock Paper Scissors (2–4 players)')
    + p('<b>/xoxo_stats</b> · <b>/rps_stats</b>')
    + p('❌ <b>/xoxo_cancel</b> — cancel lobby or abort match (stakes refunded)')
    + p('❌ <b>/rps_cancel</b> — cancel lobby or abort match (stakes refunded)');
}

export function gamesKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '❌ XOXO', callback_data: 'games:tip:xoxo' }, { text: '✊ RPS', callback_data: 'games:tip:rps' }],
      [{ text: '📊 Stats tips', callback_data: 'games:tip:stats' }],
    ],
  };
}

export { title, pfx, matchCode, balanceOf, ACTIVE_STATUSES };
