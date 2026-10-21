/**
 * Commands + callbacks for XOXO and RPS (rich messages).
 */
import { api } from '../message_api.js';
import { fmt } from '../store.js';
import {
  GAME_XOXO, GAME_RPS, COIN, STATUS_CUSTOM, STATUS_PLAYING,
} from './constants.js';
import {
  createLobby, setLobbyMessage, setStake, startCustomStake, joinLobby, abortXoxoMatch, abortRpsMatch,
  acceptChallenge, startRpsMatch, cancelLobby, makeMove, rpsSubmitMove,
  rpsAdvanceReveal, getLobby, getPlayerLobbyId, clearPlayerLock, getStats,
  renderLobby, gamesListBody, gamesKeyboard,
} from './lobby.js';
import { sendGameRich, editGameRich, gameBody, p } from './rich.js';

async function answer(cb, text, alert = false) {
  try {
    await api.answerCallbackQuery({
      callback_query_id: cb.id,
      ...(text ? { text, show_alert: !!alert } : {}),
    });
  } catch (_) {}
}

async function showLobby(chatId, messageId, lobby, user) {
  const { body, keyboard } = renderLobby(lobby, user);
  const isXoxoBoard = (lobby.game_type || GAME_XOXO) === GAME_XOXO
    && lobby.status === STATUS_PLAYING;
  const html = gameBody(isXoxoBoard ? null : user, body);
  const buttonAlign = lobby.status === STATUS_PLAYING ? 'left' : 'center';
  if (messageId) {
    await editGameRich(chatId, messageId, html, keyboard, buttonAlign);
  } else {
    const sent = await sendGameRich(chatId, html, keyboard, {}, buttonAlign);
    const mid = sent?.message_id || sent?.result?.message_id;
    if (mid) await setLobbyMessage(lobby.lobby_id, mid);
  }
}

async function startGame(message, gameType) {
  const user = message.from;
  const chatId = message.chat.id;
  if (message.chat.type === 'private') {
    await sendGameRich(
      chatId,
      gameBody(user, p('「GROUP COMMAND」') + p('Play /xoxo and /rps in a group.')),
      null,
    );
    return;
  }

  // Optional @username challenge: "/xoxo @user"
  const parts = (message.text || '').trim().split(/\s+/);
  let opponent = null;
  // Direct challenge by reply
  const reply = message.reply_to_message?.from;
  if (reply && !reply.is_bot && Number(reply.id) !== Number(user.id)) {
    opponent = {
      id: reply.id,
      username: reply.username,
      first_name: reply.first_name,
    };
  }

  const result = await createLobby(chatId, user.id, user.username, user.first_name, {
    kind: opponent ? 'direct' : 'open',
    opponent,
    gameType,
  });
  if (!result.ok) {
    const msg = result.error === 'busy'
      ? 'You already have an active hub lobby. Use /xoxo_cancel.'
      : result.error === 'opponent_busy'
        ? 'That player is already in a hub match.'
        : 'Could not create lobby.';
    await sendGameRich(chatId, gameBody(user, p(`❌ ${msg}`)), null);
    return;
  }
  await showLobby(chatId, null, result.lobby, user);
}

export async function handleXoxoCommand(message) {
  await startGame(message, GAME_XOXO);
}

export async function handleRpsCommand(message) {
  await startGame(message, GAME_RPS);
}

export async function handleGamesCommand(message) {
  await sendGameRich(
    message.chat.id,
    gameBody(message.from, gamesListBody()),
    gamesKeyboard(),
  );
}

export async function handleCancelCommand(message) {
  const user = message.from;
  const chatId = message.chat.id;
  const lid = await getPlayerLobbyId(user.id);
  if (!lid) {
    await clearPlayerLock(user.id);
    await sendGameRich(chatId, gameBody(user, p('No active hub lobby.')), null);
    return;
  }
  const lobby = await getLobby(lid);
  if (!lobby || lobby.status === STATUS_PLAYING) {
    if (lobby?.status === STATUS_PLAYING) {
      if ((lobby.game_type || GAME_XOXO) === GAME_XOXO) {
        const result = await abortXoxoMatch(lid, user.id);
        if (!result.ok) {
          const msg = result.error === 'not_participant'
            ? 'Only a player in this XOXO match can abort it.'
            : 'This XOXO match is no longer active.';
          await sendGameRich(chatId, gameBody(user, p(msg)), null);
          return;
        }
        if (lobby.message_id) await showLobby(chatId, lobby.message_id, result.lobby, user);
        await sendGameRich(
          chatId,
          gameBody(user, p('XOXO match aborted; both stakes have been refunded.')),
          null,
        );
        return;
      }
      if (lobby.game_type === GAME_RPS) {
        const result = await abortRpsMatch(lid, user.id);
        if (!result.ok) {
          const msg = result.error === 'not_participant'
            ? 'Only a player in this RPS match can abort it.'
            : 'This RPS match is no longer active.';
          await sendGameRich(chatId, gameBody(user, p(msg)), null);
          return;
        }
        if (lobby.message_id) await showLobby(chatId, lobby.message_id, result.lobby, user);
        await sendGameRich(
          chatId,
          gameBody(user, p('RPS match aborted; stakes have been refunded.')),
          null,
        );
        return;
      }
      await sendGameRich(chatId, gameBody(user, p('Match in progress — finish it or wait for timeout.')), null);
      return;
    }
    await clearPlayerLock(user.id);
    await sendGameRich(chatId, gameBody(user, p('Stale lock cleared. You can start a new game.')), null);
    return;
  }
  const result = await cancelLobby(lid, user.id);
  if (!result.ok) {
    await clearPlayerLock(user.id);
    await sendGameRich(chatId, gameBody(user, p('Lock force-cleared. Try again.')), null);
    return;
  }
  if (lobby.message_id) {
    await showLobby(chatId, lobby.message_id, result.lobby, user);
  }
  await sendGameRich(chatId, gameBody(user, p('✅ Hub lobby cancelled.')), null);
}

export async function handleStatsCommand(message, gameType) {
  const user = message.from;
  const s = await getStats(user.id, gameType);
  const body = p(`<b>${gameType === GAME_RPS ? 'RPS' : 'XOXO'} STATS</b>`)
    + p(`🎮 Games: <b>${s.games}</b>`)
    + p(`🏆 Wins: <b>${s.wins}</b> · 💀 Losses: <b>${s.losses}</b> · 🤝 Draws: <b>${s.draws}</b>`)
    + p(`📈 Won: <b>${fmt(s.coins_won)}</b> ${COIN}`)
    + p(`📉 Lost: <b>${fmt(s.coins_lost)}</b> ${COIN}`)
    + p(`🏅 Best streak: <b>${s.best_streak}</b>`);
  await sendGameRich(message.chat.id, gameBody(user, body), null);
}

/** Custom stake text input while STATUS_CUSTOM */
export async function handleCustomStakeText(message) {
  const user = message.from;
  if (!user || user.is_bot) return false;
  const text = (message.text || '').trim();
  if (!text || text.startsWith('/')) return false;
  const lid = await getPlayerLobbyId(user.id);
  if (!lid) return false;
  const lobby = await getLobby(lid);
  if (!lobby || lobby.status !== STATUS_CUSTOM) return false;
  if (Number(lobby.chat_id) !== Number(message.chat.id)) return false;
  if (Number(lobby.creator_id) !== Number(user.id)) return false;

  const result = await setStake(lid, user.id, text);
  if (!result.ok) {
    const msg = result.error === 'poor'
      ? `Not enough ${COIN}.`
      : (typeof result.error === 'string' ? result.error : 'Invalid stake.');
    await sendGameRich(message.chat.id, gameBody(user, p(`⚠️ ${msg}`)), null);
    return true;
  }
  await showLobby(message.chat.id, lobby.message_id, result.lobby, user);
  return true;
}

/**
 * Returns true if callback was a games hub action (xo: / rps: / games:).
 */
export async function handleGamesCallback(cb) {
  const data = String(cb.data || '');
  if (!(data.startsWith('xo:') || data.startsWith('rps:') || data.startsWith('games:'))) {
    return false;
  }

  if (data.startsWith('games:')) {
    const tip = data.split(':')[2] || '';
    const tips = {
      xoxo: 'Type /xoxo or reply to someone with /xoxo',
      rps: 'Type /rps (2–4 players)',
      stats: '/xoxo_stats · /rps_stats',
      cancel: '/xoxo_cancel',
    };
    await answer(cb, tips[tip] || 'Type /games', true);
    return true;
  }

  const parts = data.split(':');
  const pfx = parts[0];
  const action = parts[1] || '';
  const lobbyId = Number(parts[2]) || 0;
  const user = cb.from;
  const msg = cb.message;
  const chatId = msg?.chat?.id;
  const messageId = msg?.message_id;

  if (action === 'noop') {
    await answer(cb);
    return true;
  }

  if (action === 'stake') {
    const amount = parts[3];
    const result = await setStake(lobbyId, user.id, amount);
    if (!result.ok) {
      const map = {
        not_creator: 'Only the challenger picks the stake.',
        state: 'Stake already chosen.',
        poor: `Not enough ${COIN}.`,
      };
      await answer(cb, map[result.error] || String(result.error), true);
      return true;
    }
    await answer(cb);
    await showLobby(chatId, messageId, result.lobby, user);
    return true;
  }

  if (action === 'custom') {
    const result = await startCustomStake(lobbyId, user.id);
    if (!result.ok) {
      await answer(cb, 'Only the challenger can set a custom stake.', true);
      return true;
    }
    await answer(cb);
    await showLobby(chatId, messageId, result.lobby, user);
    return true;
  }

  if (action === 'join') {
    const result = await joinLobby(lobbyId, user.id, user.username, user.first_name, chatId);
    if (!result.ok) {
      const map = {
        self: "You can't join your own lobby.",
        busy: "You're already in a hub match.",
        poor: `Not enough ${COIN}.`,
        poor_x: 'Host cannot afford the stake.',
        taken: 'Someone already joined.',
        full: 'Lobby full (4 players).',
        state: "This lobby isn't open.",
        wrong_chat: 'Join from the original group.',
        missing: 'Lobby not found.',
      };
      await answer(cb, map[result.error] || "Can't join.", true);
      return true;
    }
    await answer(cb);
    await showLobby(chatId, messageId, result.lobby, user);
    return true;
  }

  if (action === 'accept') {
    const result = await acceptChallenge(lobbyId, user.id, chatId);
    if (!result.ok) {
      const map = {
        not_opponent: 'Only the challenged player can accept.',
        poor: `Not enough ${COIN}.`,
        poor_x: 'Challenger cannot afford the stake.',
        state: "Challenge isn't pending.",
        wrong_chat: 'Accept in the original group.',
      };
      await answer(cb, map[result.error] || "Can't accept.", true);
      return true;
    }
    await answer(cb);
    await showLobby(chatId, messageId, result.lobby, user);
    return true;
  }

  if (action === 'start' && pfx === 'rps') {
    const result = await startRpsMatch(lobbyId, user.id, chatId);
    if (!result.ok) {
      const map = {
        not_creator: 'Only the creator can start.',
        need_players: 'Need at least 2 players.',
        poor: `Not enough ${COIN}.`,
        state: "Lobby isn't ready.",
      };
      await answer(cb, map[result.error] || "Can't start.", true);
      return true;
    }
    await answer(cb);
    await showLobby(chatId, messageId, result.lobby, user);
    return true;
  }

  if (action === 'abort' && pfx === 'xo') {
    const result = await abortXoxoMatch(lobbyId, user.id);
    if (!result.ok) {
      const map = {
        not_participant: 'Only the two players in this match can abort it.',
        state: 'This XOXO match is no longer active.',
        wrong_game: 'This button is only for XOXO matches.',
        missing: 'Match not found.',
      };
      await answer(cb, map[result.error] || "Can't abort this match.", true);
      return true;
    }
    await answer(cb, 'Match aborted; both stakes refunded.');
    await showLobby(chatId, messageId, result.lobby, user);
    return true;
  }

  if (action === 'cancel') {
    const result = await cancelLobby(lobbyId, user.id);
    if (!result.ok) {
      const map = {
        started: 'Match already started.',
        not_creator: 'Only the creator can cancel.',
        missing: 'Lobby not found.',
      };
      await answer(cb, map[result.error] || "Can't cancel.", true);
      return true;
    }
    await answer(cb);
    await showLobby(chatId, messageId, result.lobby, user);
    return true;
  }

  if (action === 'cell' && pfx === 'xo') {
    const cell = Number(parts[3]);
    await answer(cb);
    const result = await makeMove(lobbyId, user.id, cell, chatId);
    if (!result.ok) return true;
    await showLobby(chatId, messageId, result.lobby, user);
    return true;
  }

  if (action === 'move' && pfx === 'rps') {
    const move = parts[3];
    await answer(cb, '🔒 Move locked.');
    const result = await rpsSubmitMove(lobbyId, user.id, move, chatId);
    if (!result.ok) return true;
    await showLobby(chatId, messageId, result.lobby, user);
    return true;
  }

  if (action === 'next' && pfx === 'rps') {
    await answer(cb);
    const result = await rpsAdvanceReveal(lobbyId, user.id);
    if (!result.ok) return true;
    await showLobby(chatId, messageId, result.lobby, user);
    return true;
  }

  await answer(cb);
  return true;
}

export function isGamesCallback(data) {
  const d = String(data || '');
  return d.startsWith('xo:') || d.startsWith('rps:') || d.startsWith('games:');
}
