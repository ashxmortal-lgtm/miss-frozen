import { getAllShinobiState, isDead, isExhausted } from '../rpg/state.js';
/**
 * Map command + callback router.
 * Map artwork remains a photo; all controls are Telegram Rich Message buttons.
 */

import { api } from '../message_api.js';
import { db } from 'sdk';
import { sql } from 'sdk/db';
import { style, escapeHtml } from '../texts.js';
import { screenText, screenKeyboard, fmt } from '../store.js';
import { runActivity, settleOwn, KINDS } from '../activities.js';
import { MAP_ENABLED, MAX_CHAKRA, MAP_IMAGE_FALLBACK_MESSAGE_ID } from './constants.js';
import {
  mapKeyboard,
  villageKeyboard,
  hokageKeyboard,
  gateKeyboard,
  ichirakuKeyboard,
  bbqKeyboard,
  trainingKeyboard,
  hotspringsKeyboard,
  storeKeyboard,
  guard,
  backToMapRow,
} from './ui.js';
import {
  listPendingRewards,
  claimAllPendingRewards,
} from './pending.js';
import {
  applyBbqRecovery,
  listBbqSessions,
  startBbq,
  stopBbq,
  listExhausted,
  healExhaustedAtBbq,
} from './bbq.js';
import { collectStatus, statusTableHtml } from '../rpg/status.js';
import { dueText } from '../rpg/time.js';
import {
  trainSession,
  sakuraHealStatus, sakuraHeal, sakuraHealInfoText,
  katsuyuStatus, katsuyuHeal, katsuyuRestore, restorableTimers,
} from '../rpg/training.js';
import {
  ramenKeyboard,
  fieldMealKeyboard,
  buyRamen,
  prepareFieldMeal,
} from './ichiraku.js';
import { sendMapRich, editMapRich, mapBody } from './rich.js';
import { getMapPhotoFileId, storageIdForLocation } from './media.js';
import { showCatalog, catalogBlocks } from '../gift.js';
import { storeContent, abilityContent, editRichOr, richOr } from '../rich.js';
import { abilityText, abilityKeyboard } from '../ability.js';
import { send } from '../chat.js';

const EMO = {
  Sasuke: '⚔️',
  Sakura: '🌸',
  Naruto: '🍥',
  Itachi: '👁️',
  Hinata: '👁️',
  Jiraiya: '🐸',
  'Starter Shinobi': '🥷',
};

async function answer(cb, text, alert = false) {
  const payload = { callback_query_id: cb.id };
  if (text) {
    payload.text = text;
    payload.show_alert = !!alert;
  }
  try {
    await api.answerCallbackQuery(payload);
  } catch (_) {}
}

async function ownedNames(telegramId) {
  const rows = await db.all(sql`
    SELECT item_name FROM inventory
    WHERE telegram_id = ${telegramId} AND item_type = 'shinobi'
  `);
  return rows.map((r) => r.item_name);
}

function p(html) {
  return `<p>${html}</p>`;
}

function locBody(title, lines) {
  return p(`<b>${title}</b>`) + (lines || []).map((l) => p(l)).join('');
}

const LOC_COPY = {
  hokage: {
    title: '🏯 HOKAGE OFFICE',
    lines: ['Shinobi missions · Daily Quest · claim all rewards.'],
  },
  ichiraku: {
    title: '🍜 ICHIRAKU RAMEN',
    lines: ['Restore chakra with ramen or prepare a Field Meal.'],
  },
  bbq: {
    title: '🍖 BBQ',
    lines: ['Send shinobi here to recover chakra over time (+20 / 30 min).'],
  },
  gate: {
    title: '🚪 VILLAGE GATE',
    lines: ['Shinobi status · dispatch available units on patrol.'],
  },
  training: {
    title: '🥷 TRAINING GROUND',
    lines: ['Tsunade trains Sakura · Jiraiya trains Naruto.', 'One session per shinobi per day.'],
  },
  hotsprings: {
    title: '♨️ HOT SPRINGS',
    lines: [
      'Pet rest is not available in this version (pets omitted).',
      'This location is reserved for a future update.',
    ],
  },
  store: {
    title: '🏪 STORES',
    lines: ['Shinobi Store · Gift Store.'],
  },
};

function villageBody() {
  return p('Choose which village you want to visit.');
}

function homeBody() {
  return locBody('🗺️ KONOHA MAP', ['Choose a location.']);
}

function locationBody(locKey) {
  const c = LOC_COPY[locKey] || { title: 'Map', lines: [] };
  return locBody(c.title, c.lines);
}

function kbFor(locKey, userId) {
  const map = {
    hokage: hokageKeyboard,
    ichiraku: ichirakuKeyboard,
    bbq: bbqKeyboard,
    gate: gateKeyboard,
    training: trainingKeyboard,
    hotsprings: hotspringsKeyboard,
    store: storeKeyboard,
  };
  return (map[locKey] || mapKeyboard)(userId);
}

function abilityKeyboardFromMap(userId) {
  const keyboard = abilityKeyboard(userId);
  return {
    inline_keyboard: [
      ...(keyboard.inline_keyboard || []),
      backToMapRow(userId),
    ],
  };
}

/** Render the map photo, screen content and rich controls as one editable message. */
async function showScreen(chatId, panelMessageId, user, bodyInner, keyboard, locKey = 'home') {
  const body = mapBody(user, bodyInner);
  const storageId = storageIdForLocation(locKey);
  const caption = style('<b>🗺️ KONOHA MAP</b>');
  let photoFileId = await getMapPhotoFileId(chatId, storageId);
  if (!photoFileId && storageId !== MAP_IMAGE_FALLBACK_MESSAGE_ID) {
    photoFileId = await getMapPhotoFileId(chatId, MAP_IMAGE_FALLBACK_MESSAGE_ID);
  }
  const mediaOptions = { mediaFileId: photoFileId, mediaCaption: caption };
  const legacyPhotoId = user?._mapHasRichPanel
    ? Number(user?._mapPhotoMessageId) || null
    : null;

  if (panelMessageId) {
    const editedWithPhoto = await editMapRich(chatId, panelMessageId, body, keyboard, mediaOptions);
    if (editedWithPhoto && photoFileId && legacyPhotoId && legacyPhotoId !== panelMessageId) {
      try { await api.deleteMessage({ chat_id: chatId, message_id: legacyPhotoId }); } catch (_) {}
    }
    return panelMessageId;
  }

  const sent = await sendMapRich(chatId, body, keyboard, mediaOptions);
  return sent?.message_id || sent?.result?.message_id || null;
}

const now = () => Math.floor(Date.now() / 1000);

/** Minimal rich table: name, status, return time. */
async function gateBody(telegramId) {
  try {
    try { await settleOwn({ id: telegramId }); } catch (e) { console.error('[gate settle]', e); }
    const status = await collectStatus(telegramId);
    return `<p><b>🚪 VILLAGE GATE</b></p>${statusTableHtml(status.rows)}`;
  } catch (e) {
    console.error('[gateBody]', e);
    return locBody('🚪 VILLAGE GATE', [
      'Shinobi status temporarily unavailable.',
      'You can still try Send Available on Patrol.',
    ]);
  }
}

// --- Training Ground / healing panel helpers ---

function trainResultBody(r) {
  if (r.code === 'not_owned') return locBody('🥷 TRAINING GROUND', [`You don't own ${escapeHtml(r.shinobi)} yet.`]);
  if (r.code === 'no_trainer') return locBody('🥷 TRAINING GROUND', [`Training requires ${escapeHtml(r.trainer)} on your roster.`]);
  if (r.code === 'dead') return locBody('🥷 TRAINING GROUND', [`☠️ ${escapeHtml(r.shinobi)} is dead — revives at ${dueText(r.until)}.`]);
  if (r.code === 'exhausted') return locBody('🥷 TRAINING GROUND', [`🔥 ${escapeHtml(r.shinobi)} is exhausted — ready at ${dueText(r.until)}.`, '» Instant recovery at BBQ (200 🍥).']);
  if (r.code === 'cooldown') return locBody('🥷 TRAINING GROUND', [`🏋️ ${escapeHtml(r.shinobi)} already trained today.`, `Next session: ${dueText(r.until)}.`]);
  if (r.code === 'searching') return locBody('🥷 TRAINING GROUND', [`🔎 ${escapeHtml(r.shinobi)} is away searching for Lady Tsunade.`, `Search completes: ${dueText(r.until)}.`]);
  const lines = [
    `✅ ${escapeHtml(r.shinobi)} trained with ${escapeHtml(r.trainer)}.`,
    `Sessions completed: ${r.sessions}`,
    `Next session: ${dueText(r.nextTrainAt)}`,
  ];
  if (r.levelUp) lines.push(`🏅 Level up! ${escapeHtml(r.shinobi)} is now Lv. ${r.levelUp}.`);
  if (r.shinobi === 'Naruto') {
    lines.push(`🌀 Shadow Clone window: ${r.cloneWindowSec} sec (Lv. ${r.level}/${r.maxLevel}).`);
    if (r.sessionsToNext > 0) lines.push(`Next level in ${r.sessionsToNext} more session(s) — the clone window grows each level.`);
    else lines.push('Max level reached.');
  } else if (r.shinobi === 'Sakura') {
    if (r.sessionsToNext > 0) lines.push(`Next level in ${r.sessionsToNext} more session(s). (Lv. ${r.level}/${r.maxLevel})`);
    else lines.push('Max level reached — Sakura\'s Healing is unlocked.');
  }
  return locBody('🏋️ TRAINING COMPLETE', lines);
}

function sakuraHealSummary(r) {
  const parts = [];
  if (r.revived && r.revived.length) parts.push(`Revived: ${r.revived.join(', ')}`);
  if (r.exhaustedCleared && r.exhaustedCleared.length) parts.push(`Exhaustion cleared: ${r.exhaustedCleared.join(', ')}`);
  if (r.cooldownsCleared && r.cooldownsCleared.length) parts.push(`Mission cooldown reset: ${r.cooldownsCleared.join(', ')}`);
  return `🌸 Sakura's Healing used.\n${parts.join('\n')}`;
}

async function sakuraHealBody(telegramId) {
  const s = await sakuraHealStatus(telegramId);
  const info = sakuraHealInfoText(s);
  const lines = [info];
  if (s.unlocked) {
    lines.push('Once per 24h: revives your dead shinobi, clears exhaustion and resets mission cooldowns.');
  }
  if (s.uses >= 3) lines.push("🐌 Katsuyu's Healing is unlocked.");
  else if (s.unlocked) lines.push(`🐌 Katsuyu's Healing unlocks after ${3 - s.uses} more healing use(s).`);
  return locBody("🌸 SAKURA'S HEALING", lines);
}

function katsuyuKeyboard(userId) {
  return {
    inline_keyboard: [
      [{ text: "🐌 Use Katsuyu's Healing", callback_data: guard('map_kat_use', userId) }],
      backToMapRow(userId),
    ],
  };
}

async function katsuyuBody(telegramId) {
  const s = await katsuyuStatus(telegramId);
  const lines = [];
  if (!s.unlocked) {
    lines.push("Locked — unlocked after Sakura's Healing is used 3 times.");
  } else {
    lines.push('+200 ⚡ chakra on use.');
    lines.push('Restores one eligible timer (mission cooldown or exhaustion).');
    lines.push('Revives a dead shinobi — with 24h of Katsuyu protection.');
    if (s.cooldownUntil > s.now) lines.push(`Ready at ${dueText(s.cooldownUntil, s.now)}.`);
    else lines.push('Ready now.');
  }
  return locBody("🐌 KATSUYU'S HEALING", lines);
}

function katsuyuRestoreKeyboard(userId, result) {
  const rows = [];
  for (const t of result.restorable || []) {
    rows.push([{
      text: `${t.kind === 'exhaustion' ? '🔥' : '⏳'} ${t.shinobi} — clear ${t.kind === 'exhaustion' ? 'exhaustion' : 'mission cooldown'}`,
      callback_data: `map_kat_restore:${t.kind}:${t.shinobi}:${result.healKey}:${userId}`,
    }]);
  }
  rows.push(backToMapRow(userId));
  return { inline_keyboard: rows };
}

async function katsuyuRestoreBody(telegramId, result) {
  const lines = [
    `+${result.chakra} ⚡ chakra added.`,
  ];
  if (result.revived) lines.push(`🕊️ ${escapeHtml(result.revived)} revived with 24h of Katsuyu protection 🛡️`);
  lines.push('Choose ONE timer to restore:');
  return locBody("🐌 KATSUYU'S HEALING USED", lines);
}

async function clearGateSelection(telegramId) {
  try {
    await db.run(sql`DELETE FROM map_gate_selection WHERE telegram_id = ${telegramId}`);
  } catch (e) {
    console.error('[gate clear sel]', e);
  }
}

async function listGateSelection(telegramId) {
  try {
    const rows = await db.all(sql`
      SELECT shinobi FROM map_gate_selection WHERE telegram_id = ${telegramId}
    `);
    return new Set((rows || []).map((r) => r.shinobi));
  } catch (e) {
    console.error('[gate list sel]', e);
    return new Set();
  }
}

async function toggleGateSelection(telegramId, shinobi) {
  try {
    const exists = await db.get(sql`
      SELECT 1 FROM map_gate_selection
      WHERE telegram_id = ${telegramId} AND shinobi = ${shinobi}
    `);
    if (exists) {
      await db.run(sql`
        DELETE FROM map_gate_selection
        WHERE telegram_id = ${telegramId} AND shinobi = ${shinobi}
      `);
      return false;
    }
    await db.run(sql`
      INSERT OR IGNORE INTO map_gate_selection (telegram_id, shinobi)
      VALUES (${telegramId}, ${shinobi})
    `);
    return true;
  } catch (e) {
    console.error('[gate toggle]', e);
    return false;
  }
}


async function clearMissionSelection(telegramId) {
  try {
    await db.run(sql`DELETE FROM map_mission_selection WHERE telegram_id = ${telegramId}`);
  } catch (_) {}
}

async function listMissionSelection(telegramId) {
  try {
    await db.run(sql`CREATE TABLE IF NOT EXISTS map_mission_selection (telegram_id INTEGER, shinobi TEXT, PRIMARY KEY (telegram_id, shinobi))`);
    const rows = await db.all(sql`
      SELECT shinobi FROM map_mission_selection WHERE telegram_id = ${telegramId}
    `);
    return new Set((rows || []).map((r) => r.shinobi));
  } catch (_) {
    return new Set();
  }
}

async function toggleMissionSelection(telegramId, shinobi) {
  try {
    await db.run(sql`CREATE TABLE IF NOT EXISTS map_mission_selection (telegram_id INTEGER, shinobi TEXT, PRIMARY KEY (telegram_id, shinobi))`);
    const exists = await db.get(sql`
      SELECT 1 FROM map_mission_selection
      WHERE telegram_id = ${telegramId} AND shinobi = ${shinobi}
    `);
    if (exists) {
      await db.run(sql`
        DELETE FROM map_mission_selection
        WHERE telegram_id = ${telegramId} AND shinobi = ${shinobi}
      `);
      return false;
    }
    await db.run(sql`
      INSERT OR IGNORE INTO map_mission_selection (telegram_id, shinobi)
      VALUES (${telegramId}, ${shinobi})
    `);
    return true;
  } catch (_) {
    return false;
  }
}

async function selectAllMission(telegramId, names) {
  try {
    await db.run(sql`CREATE TABLE IF NOT EXISTS map_mission_selection (telegram_id INTEGER, shinobi TEXT, PRIMARY KEY (telegram_id, shinobi))`);
    for (const n of names) {
      await db.run(sql`INSERT OR IGNORE INTO map_mission_selection (telegram_id, shinobi) VALUES (${telegramId}, ${n})`);
    }
  } catch (_) {}
}

async function selectAllGate(telegramId, names) {
  try {
    for (const n of names) {
      await db.run(sql`INSERT OR IGNORE INTO map_gate_selection (telegram_id, shinobi) VALUES (${telegramId}, ${n})`);
    }
  } catch (_) {}
}

async function getEligibleStatus(telegramId, kind) {
  const eligible = KINDS[kind].eligible;
  const own = await ownedNames(telegramId);
  const t = now();
  const available = [];
  const busyNotes = [];

  const acts = await db.all(sql`
    SELECT shinobi, kind, status, ends_at, cooldown_until FROM activities
    WHERE telegram_id = ${telegramId}
  `);
  const actMap = Object.fromEntries((acts || []).map((a) => [a.shinobi, a]));

  const search = await db.get(sql`
    SELECT status, ends_at FROM tsunade_search WHERE telegram_id = ${telegramId}
  `);
  const searchActive = search && search.status === 'active';

  const states = await getAllShinobiState(telegramId);

  for (const name of eligible) {
    if (!own.includes(name)) continue;
    const act = actMap[name];
    const st = states[name] || {};

    if (name !== 'Starter Shinobi' && isDead(st, t)) {
      busyNotes.push(`• ${EMO[name] || '🥷'} ${name}: dead (revives at ${dueText(st.deadUntil, t)})`);
      continue;
    }
    if (act && act.status === 'active' && act.ends_at > t) {
      const actWord = act.kind === 'mission' ? 'mission' : 'patrol';
      busyNotes.push(`• ${EMO[name] || '🥷'} ${name}: on ${actWord} (returns at ${dueText(act.ends_at, t)})`);
      continue;
    }
    if (searchActive && (name === 'Naruto' || name === 'Jiraiya')) {
      busyNotes.push(`• ${EMO[name] || '🥷'} ${name}: searching Tsunade (ends at ${dueText(search.ends_at, t)})`);
      continue;
    }
    if (isExhausted(st, t)) {
      busyNotes.push(`• ${EMO[name] || '🥷'} ${name}: exhausted (ready at ${dueText(st.exhaustedUntil, t)})`);
      continue;
    }
    if (kind === 'mission' && act && act.cooldown_until > t) {
      busyNotes.push(`• ${EMO[name] || '🥷'} ${name}: cooldown (ready at ${dueText(act.cooldown_until, t)})`);
      continue;
    }
    available.push(name);
  }
  return { available, busyNotes };
}

function patrolPickKeyboard(userId, available, selected) {
  const rows = [];
  const pickButtons = available.map((name) => {
    const mark = selected.has(name) ? '✅' : '❌';
    return {
      text: `${mark} ${EMO[name] || '🥷'} ${name}`,
      callback_data: `map_ptog:${name}:${userId}`,
    };
  });
  for (let i = 0; i < pickButtons.length; i += 2) {
    rows.push(pickButtons.slice(i, i + 2));
  }
  const allSelected = available.length > 0 && available.every((n) => selected.has(n));
  rows.push([
    { text: allSelected ? '⬜ Deselect All' : '🔘 Select All', callback_data: guard('map_pall', userId) },
  ]);
  rows.push([
    { text: '🚀 Send on Patrol', callback_data: guard('map_psend', userId) },
    { text: '✖️ Cancel', callback_data: guard('map_loc_gate', userId) },
  ]);
  rows.push(backToMapRow(userId));
  return { inline_keyboard: rows };
}

function missionPickKeyboard(userId, available, selected) {
  const rows = [];
  const pickButtons = available.map((name) => {
    const mark = selected.has(name) ? '✅' : '❌';
    return {
      text: `${mark} ${EMO[name] || '🥷'} ${name}`,
      callback_data: `map_mtog:${name}:${userId}`,
    };
  });
  for (let i = 0; i < pickButtons.length; i += 2) {
    rows.push(pickButtons.slice(i, i + 2));
  }
  const allSelected = available.length > 0 && available.every((n) => selected.has(n));
  rows.push([
    { text: allSelected ? '⬜ Deselect All' : '🔘 Select All', callback_data: guard('map_mall', userId) },
  ]);
  rows.push([
    { text: '🚀 Send on Mission', callback_data: guard('map_msend', userId) },
    { text: '✖️ Cancel', callback_data: guard('map_loc_hokage', userId) },
  ]);
  rows.push(backToMapRow(userId));
  return { inline_keyboard: rows };
}


async function claimRewardsBody(telegramId) {
  const rows = await listPendingRewards(telegramId);
  if (!rows.length) {
    return locBody('💰 ᴄʟᴀɪᴍ ᴀʟʟ ʀᴇᴡᴀʀᴅꜱ', [
      'ɴᴏ ᴘᴇɴᴅɪɴɢ ʀᴇᴡᴀʀᴅꜱ.',
      'ᴄᴏᴍᴘʟᴇᴛᴇ ᴍɪꜱꜱɪᴏɴꜱ ᴏʀ ᴘᴀᴛʀᴏʟꜱ, ᴛʜᴇɴ ʀᴇᴛᴜʀɴ ʜᴇʀᴇ ᴛᴏ ᴄʟᴀɪᴍ.',
    ]);
  }
  const mission = rows.filter((r) => (r.kind || 'patrol') === 'mission');
  const patrol = rows.filter((r) => (r.kind || 'patrol') !== 'mission');
  const lines = [];
  let mTotal = 0;
  let pTotal = 0;
  if (mission.length) {
    lines.push('<b>Mission rewards</b>');
    for (const r of mission) {
      lines.push(`${EMO[r.shinobi] || '🥷'} ${escapeHtml(r.shinobi)} → +${fmt(r.reward)} 🍥`);
      mTotal += r.reward;
    }
    lines.push(`Subtotal: +${fmt(mTotal)} 🍥`);
  }
  if (patrol.length) {
    lines.push('<b>Patrol rewards</b>');
    for (const r of patrol) {
      lines.push(`${EMO[r.shinobi] || '🥷'} ${escapeHtml(r.shinobi)} → +${fmt(r.reward)} 🍥`);
      pTotal += r.reward;
    }
    lines.push(`Subtotal: +${fmt(pTotal)} 🍥`);
  }
  lines.push(`<b>TOTAL +${fmt(mTotal + pTotal)} 🍥</b>`);
  lines.push('Rewards are added to your balance only when you claim.');
  return locBody('💰 CLAIM ALL REWARDS', lines);
}

function claimRewardsKeyboard(userId, hasPending) {
  const rows = [];
  if (hasPending) {
    rows.push([{ text: '✅ Claim All', callback_data: guard('map_claim_confirm', userId) }]);
  }
  // Single back only (to Hokage Office)
  rows.push([{ text: '← Back', callback_data: guard('map_loc_hokage', userId) }]);
  return { inline_keyboard: rows };
}

export async function handleMapCommand(message) {
  if (!MAP_ENABLED) {
    await sendMapRich(
      message.chat.id,
      mapBody(message.from, p('🗺️ Map is temporarily disabled.')),
      null,
    );
    return;
  }
  const user = message.from;
  try {
    await applyBbqRecovery(user.id);
  } catch (e) {
    console.error('[map bbq sweep]', e);
  }
  await sendMapRich(
    message.chat.id,
    mapBody(user, villageBody()),
    villageKeyboard(user.id),
  );
}

export async function mapSweep(userId) {
  if (!MAP_ENABLED) return;
  try {
    if (userId) await applyBbqRecovery(userId);
  } catch (e) {
    console.error('[mapSweep]', e);
  }
}

function parseCb(data) {
  const parts = String(data || '').split(':');
  return { action: parts[0] || '', parts, ownerId: Number(parts[parts.length - 1]) || 0 };
}

export function isMapCallback(data) {
  return String(data || '').startsWith('map_');
}

export async function handleMapCallback(cb) {
  const data = String(cb.data || '');
  if (!data.startsWith('map_')) return false;
  if (!MAP_ENABLED) {
    await answer(cb, 'Map disabled.', true);
    return true;
  }

  const msg = cb.message;
  if (!msg) {
    await answer(cb);
    return true;
  }

  const { action, parts, ownerId } = parseCb(data);
  if (cb.from.id !== ownerId) {
    await answer(cb, "This menu isn't yours. Send /map to open your own.", true);
    return true;
  }

  const user = {
    ...cb.from,
    _mapHasRichPanel: !!msg.reply_to_message,
    _mapPhotoMessageId: msg.reply_to_message?.message_id || msg.message_id,
  };
  const chatId = msg.chat.id;
  const messageId = msg.message_id;

  try {
    if (action === 'map_village_sand') {
      await answer(cb, 'Coming soon', true);
      return true;
    }

    if (action === 'map_village_leaf') {
      await answer(cb);
      await showScreen(chatId, messageId, user, homeBody(), mapKeyboard(user.id), 'home');
      return true;
    }

    if (action === 'map_home') {
      await answer(cb);
      await showScreen(chatId, messageId, user, homeBody(), mapKeyboard(user.id), 'home');
      return true;
    }

    if (action === 'map_close') {
      await answer(cb);
      try { await api.deleteMessage({ chat_id: chatId, message_id: messageId }); } catch (_) {}
      // Also delete the map photo panel if this is a rich reply under it.
      const photoId = user._mapPhotoMessageId;
      if (photoId && photoId !== messageId) {
        try { await api.deleteMessage({ chat_id: chatId, message_id: photoId }); } catch (_) {}
      }
      return true;
    }

    const locActions = {
      map_loc_hokage: 'hokage',
      map_loc_ichiraku: 'ichiraku',
      map_loc_bbq: 'bbq',
      map_loc_gate: 'gate',
      map_loc_training: 'training',
      map_loc_hotsprings: 'hotsprings',
      map_loc_store: 'store',
    };
    if (locActions[action]) {
      const loc = locActions[action];
      await answer(cb);
      if (loc === 'bbq') {
        try {
          await applyBbqRecovery(user.id);
        } catch (_) {}
      }
      let body = locationBody(loc);
      let kb = kbFor(loc, user.id);
      if (loc === 'gate') {
        body = await gateBody(user.id);
      }
      await showScreen(chatId, messageId, user, body, kb, loc);
      return true;
    }

    // --- Stores ---
    if (action === 'map_store' && parts.length >= 3) {
      const screen = parts[1];
      await answer(cb);
      try {
        await editRichOr(
          msg,
          user,
          await storeContent(screen, user.id, { fromMap: true }),
          async () => {
            await editMapRich(chatId, messageId, style(screenText(screen)), screenKeyboard(screen, user.id, { fromMap: true }));
          },
        );
      } catch (e) {
        console.error('[map_store]', e);
      }
      return true;
    }

    if (action === 'map_open_shinobi_store') {
      await answer(cb);
      try {
        // Prefer rich table (compact) on the current message
        await editRichOr(
          msg,
          user,
          await storeContent('main', user.id, { fromMap: true }),
          async () => {
            await editMapRich(chatId, messageId, style(screenText('main')), screenKeyboard('main', user.id, { fromMap: true }));
          },
        );
      } catch (e) {
        console.error('[map shinobi store]', e);
        try {
          await richOr(
            chatId,
            user,
            await storeContent('main', user.id, { fromMap: true }),
            async () => {
              await sendMapRich(chatId, style(screenText('main')), screenKeyboard('main', user.id, { fromMap: true }));
            },
          );
        } catch (e2) {
          console.error('[map shinobi store send]', e2);
        }
      }
      return true;
    }

    if (action === 'map_open_gift_store') {
      await answer(cb);
      // Try edit current message into gift catalog; if that fails, delete map msg and open catalog
      try {
        const rich = (blocks) => ({ blocks });
        await api.editMessageText({
          chat_id: chatId,
          message_id: messageId,
          rich_message: rich(catalogBlocks()),
        });
        return true;
      } catch (e) {
        console.error('[map gift edit]', e?.description || e);
      }
      try {
        try {
          await api.deleteMessage({ chat_id: chatId, message_id: messageId });
        } catch (_) {}
        await showCatalog(chatId);
        return true;
      } catch (e2) {
        console.error('[map gift open]', e2?.description || e2);
        await showScreen(
          chatId,
          null,
          user,
          locBody('🎁 GIFT STORE', [
            'Catalog failed to open. Send /gift_store in chat.',
          ]),
          storeKeyboard(user.id),
          'store',
        );
        return true;
      }
    }

    // --- Hokage: mission hub ---
    if (action === 'map_mission_hub') {
      await answer(cb);
      await clearMissionSelection(user.id);
      const { available, busyNotes } = await getEligibleStatus(user.id, 'mission');
      if (!available.length) {
        await showScreen(
          chatId,
          messageId,
          user,
          locBody('🏯 SHINOBI MISSION', [
            "No mission-eligible shinobi available right now.",
            ...(busyNotes.length ? ['', '<b>Status:</b>', ...busyNotes] : ['Recruit Sasuke or Naruto from Stores.']),
          ]),
          hokageKeyboard(user.id),
          'hokage',
        );
        return true;
      }
      await showScreen(
        chatId,
        messageId,
        user,
        locBody('🏯 SELECT SHINOBI', [
          'Select mission-eligible shinobi to dispatch.',
          ...(busyNotes.length ? ['', '<b>Unavailable:</b>', ...busyNotes] : []),
        ]),
        missionPickKeyboard(user.id, available, new Set()),
        'hokage',
      );
      return true;
    }

    if (action === 'map_mtog' && parts.length >= 3) {
      const shinobi = parts[1];
      await toggleMissionSelection(user.id, shinobi);
      await answer(cb);
      const { available, busyNotes } = await getEligibleStatus(user.id, 'mission');
      const selected = await listMissionSelection(user.id);
      await showScreen(
        chatId,
        messageId,
        user,
        locBody('🏯 SELECT SHINOBI', [
          `Selected: ${selected.size}`,
          'Tap to toggle, then Send on Mission.',
          ...(busyNotes.length ? ['', '<b>Unavailable:</b>', ...busyNotes] : []),
        ]),
        missionPickKeyboard(user.id, available, selected),
        'hokage',
      );
      return true;
    }

    if (action === 'map_mall') {
      await answer(cb);
      const { available } = await getEligibleStatus(user.id, 'mission');
      const selected = await listMissionSelection(user.id);
      const allSelected = available.length > 0 && available.every((n) => selected.has(n));
      if (allSelected) {
        await clearMissionSelection(user.id);
      } else {
        await selectAllMission(user.id, available);
      }
      const newSel = await listMissionSelection(user.id);
      const { available: av2, busyNotes } = await getEligibleStatus(user.id, 'mission');
      await showScreen(
        chatId,
        messageId,
        user,
        locBody('🏯 SELECT SHINOBI', [
          `Selected: ${newSel.size}`,
          'Tap to toggle, then Send on Mission.',
          ...(busyNotes.length ? ['', '<b>Unavailable:</b>', ...busyNotes] : []),
        ]),
        missionPickKeyboard(user.id, av2, newSel),
        'hokage',
      );
      return true;
    }

    if (action === 'map_msend') {
      if (cb.message && cb.message.chat && cb.message.chat.type === 'private') {
        await answer(cb, 'Missions work in groups only.', true);
        return true;
      }
      const selected = [...(await listMissionSelection(user.id))];
      if (!selected.length) {
        await answer(cb, 'Select at least one shinobi.', true);
        return true;
      }
      await answer(cb);
      const results = [];
      for (const shinobi of selected) {
        const r = await runActivity(user, 'mission', shinobi, chatId);
        const label = r.status === 'ok'
          ? 'dispatched'
          : r.status === 'already_active'
            ? 'already on mission'
            : r.status === 'busy'
              ? 'on patrol'
              : r.status === 'cooldown'
                ? 'on cooldown'
                : r.status === 'exhausted'
                  ? 'exhausted — skipped'
                  : r.status === 'no_chakra'
                    ? 'not enough chakra'
                    : r.status === 'dead' ? 'dead — skipped' : 'not dispatched';
        results.push(`${EMO[shinobi] || '🥷'} ${escapeHtml(shinobi)}: ${label}`);
      }
      await clearMissionSelection(user.id);
      await showScreen(
        chatId,
        messageId,
        user,
        locBody('🏯 MISSION DISPATCHED', results),
        hokageKeyboard(user.id),
        'hokage',
      );
      return true;
    }

    if (action === 'map_msel' && parts.length >= 3) {
      const shinobi = parts[1];
      await answer(cb);
      if (chatId > 0) {
        await showScreen(
          chatId,
          messageId,
          user,
          locBody('GROUP COMMAND', ['Missions work in groups only. Use /mission in a group.']),
          hokageKeyboard(user.id),
          'hokage',
        );
        return true;
      }
      const r = await runActivity(user, 'mission', shinobi, chatId);
      await showScreen(
        chatId,
        messageId,
        user,
        p(style(r.body).replace(/\n/g, '<br>')),
        hokageKeyboard(user.id),
        'hokage',
      );
      return true;
    }

    if (action === 'map_daily') {
      await answer(cb, 'Daily Quest coming soon.', true);
      return true;
    }

    // --- Claim all rewards ---
    if (action === 'map_claim_rewards' || action === 'map_claim_patrol') {
      await answer(cb);
      const rows = await listPendingRewards(user.id);
      await showScreen(
        chatId,
        messageId,
        user,
        await claimRewardsBody(user.id),
        claimRewardsKeyboard(user.id, rows.length > 0),
        'hokage',
      );
      return true;
    }

    if (action === 'map_claim_confirm') {
      const result = await claimAllPendingRewards(user.id);
      if (result.code === 'none') {
        await answer(cb, 'Nothing to claim.', true);
        await showScreen(
          chatId,
          messageId,
          user,
          await claimRewardsBody(user.id),
          claimRewardsKeyboard(user.id, false),
          'hokage',
        );
        return true;
      }
      await answer(cb, `Claimed +${fmt(result.total)} 🍥`, true);
      const lines = [
        `+${fmt(result.total)} 🍥 added to your balance.`,
        result.missionTotal
          ? `Mission portion: +${fmt(result.missionTotal)} 🍥`
          : null,
        result.patrolTotal
          ? `Patrol portion: +${fmt(result.patrolTotal)} 🍥`
          : null,
      ].filter(Boolean);
      await showScreen(
        chatId,
        messageId,
        user,
        locBody('✅ REWARDS CLAIMED', lines),
        hokageKeyboard(user.id),
        'hokage',
      );
      return true;
    }

    // --- Gate: multi-select patrol ---
    if (action === 'map_patrol_pick' || action === 'map_patrol_select') {
      await answer(cb);
      await clearGateSelection(user.id);
      const { available, busyNotes } = await getEligibleStatus(user.id, 'patrol');
      if (!available.length) {
        await showScreen(
          chatId,
          messageId,
          user,
          locBody('🚪 PATROL', [
            'No patrol-eligible shinobi available right now.',
            ...(busyNotes.length ? ['', '<b>Status:</b>', ...busyNotes] : []),
          ]),
          gateKeyboard(user.id),
          'gate',
        );
        return true;
      }
      await showScreen(
        chatId,
        messageId,
        user,
        locBody('🚪 SELECT SHINOBI', [
          'Tap to toggle selection, then Send on Patrol.',
          ...(busyNotes.length ? ['', '<b>Unavailable:</b>', ...busyNotes] : []),
        ]),
        patrolPickKeyboard(user.id, available, new Set()),
        'gate',
      );
      return true;
    }

    if (action === 'map_ptog' && parts.length >= 3) {
      const shinobi = parts[1];
      await toggleGateSelection(user.id, shinobi);
      await answer(cb);
      const { available, busyNotes } = await getEligibleStatus(user.id, 'patrol');
      const selected = await listGateSelection(user.id);
      await showScreen(
        chatId,
        messageId,
        user,
        locBody('🚪 SELECT SHINOBI', [
          `Selected: ${selected.size}`,
          'Tap to toggle, then Send on Patrol.',
          ...(busyNotes.length ? ['', '<b>Unavailable:</b>', ...busyNotes] : []),
        ]),
        patrolPickKeyboard(user.id, available, selected),
        'gate',
      );
      return true;
    }

    if (action === 'map_pall') {
      await answer(cb);
      const { available } = await getEligibleStatus(user.id, 'patrol');
      const selected = await listGateSelection(user.id);
      const allSelected = available.length > 0 && available.every((n) => selected.has(n));
      if (allSelected) {
        await clearGateSelection(user.id);
      } else {
        await selectAllGate(user.id, available);
      }
      const newSel = await listGateSelection(user.id);
      const { available: av2, busyNotes } = await getEligibleStatus(user.id, 'patrol');
      await showScreen(
        chatId,
        messageId,
        user,
        locBody('🚪 SELECT SHINOBI', [
          `Selected: ${newSel.size}`,
          'Tap to toggle, then Send on Patrol.',
          ...(busyNotes.length ? ['', '<b>Unavailable:</b>', ...busyNotes] : []),
        ]),
        patrolPickKeyboard(user.id, av2, newSel),
        'gate',
      );
      return true;
    }

    if (action === 'map_psend') {
      // Patrol dispatch is group-only
      if (cb.message && cb.message.chat && cb.message.chat.type === 'private') {
        await answer(cb, 'Patrol works in groups only.', true);
        return true;
      }
      const selected = [...(await listGateSelection(user.id))];
      if (!selected.length) {
        await answer(cb, 'Select at least one shinobi.', true);
        return true;
      }
      await answer(cb);
      const results = [];
      for (const shinobi of selected) {
        const r = await runActivity(user, 'patrol', shinobi, chatId);
        const label = r.status === 'ok'
          ? 'dispatched'
          : r.status === 'already_active'
            ? 'already on patrol'
            : r.status === 'exhausted'
              ? 'exhausted — skipped'
              : r.status === 'dead' ? 'dead — skipped' : 'not dispatched';
        results.push(`${EMO[shinobi] || '🥷'} ${escapeHtml(shinobi)}: ${label}`);
      }
      await clearGateSelection(user.id);
      const body = locBody('🚪 PATROL DISPATCHED', results);
      // Return to gate roster with updated statuses
      const roster = await gateBody(user.id);
      await showScreen(chatId, messageId, user, roster, gateKeyboard(user.id), 'gate');
      return true;
    }

    if (action === 'map_psel' && parts.length >= 3) {
      // Legacy single-select
      const shinobi = parts[1];
      await answer(cb);
      const r = await runActivity(user, 'patrol', shinobi, chatId);
      await showScreen(
        chatId,
        messageId,
        user,
        p(style(r.body).replace(/\n/g, '<br>')),
        gateKeyboard(user.id),
        'gate',
      );
      return true;
    }

    // --- Ichiraku ---
    if (action === 'map_ichi_cat_ramen') {
      await answer(cb);
      await showScreen(
        chatId,
        messageId,
        user,
        locBody('🍜 RAMEN MENU', [
          `Restores chakra (capped at ${MAX_CHAKRA}).`,
          'You are not charged if chakra is already full.',
        ]),
        ramenKeyboard(user.id),
        'ichiraku',
      );
      return true;
    }
    if (action === 'map_ichi_cat_field') {
      await answer(cb);
      await showScreen(
        chatId,
        messageId,
        user,
        locBody('⚡ FIELD MEALS', ['Prepared for your next mission or patrol.']),
        fieldMealKeyboard(user.id),
        'ichiraku',
      );
      return true;
    }
    if (action === 'map_ramen' && parts.length >= 3) {
      const key = parts[1];
      const result = await buyRamen(user.id, key);
      if (result.code === 'unknown') {
        await answer(cb, 'Unknown item.', true);
        return true;
      }
      if (result.code === 'full_chakra') {
        await answer(cb, `Chakra already full (${result.chakra}/${result.max}).`, true);
        return true;
      }
      if (result.code === 'no_coins') {
        await answer(cb, `Not enough coins (${fmt(result.have)}/${fmt(result.need)}).`, true);
        return true;
      }
      await answer(cb);
      await showScreen(
        chatId,
        messageId,
        user,
        locBody(`✅ ${result.emoji} ${escapeHtml(result.name)}`, [
          `−${fmt(result.cost)} 🍥`,
          `+${result.chakraGained} ⚡ → ${result.chakra}/${MAX_CHAKRA}`,
        ]),
        ichirakuKeyboard(user.id),
        'ichiraku',
      );
      return true;
    }
    if (action === 'map_field' && parts.length >= 3) {
      const key = parts[1];
      const result = await prepareFieldMeal(user.id, key);
      if (result.code === 'unknown') {
        await answer(cb, 'Unknown item.', true);
        return true;
      }
      if (result.code === 'no_coins') {
        await answer(cb, `Not enough coins (${fmt(result.have)}/${fmt(result.need)}).`, true);
        return true;
      }
      await answer(cb);
      await showScreen(
        chatId,
        messageId,
        user,
        locBody(`✅ ${result.emoji} ${escapeHtml(result.name)} prepared`, [
          `−${fmt(result.cost)} 🍥`,
          'Applies to your next mission or patrol.',
        ]),
        ichirakuKeyboard(user.id),
        'ichiraku',
      );
      return true;
    }

    // --- BBQ ---
    if (action === 'map_bbq_select') {
      await answer(cb);
      const own = await ownedNames(user.id);
      const sessions = await listBbqSessions(user.id);
      const atBbq = new Set(sessions.map((s) => s.shinobi));
      const rows = [];
      for (const name of own) {
        if (atBbq.has(name)) continue;
        rows.push([{
          text: `${EMO[name] || '🥷'} ${name}`,
          callback_data: `map_bbq_go:${name}:${user.id}`,
        }]);
      }
      if (!rows.length) {
        await showScreen(
          chatId,
          messageId,
          user,
          locBody('🍖 BBQ', ['No free shinobi to send (or none owned).']),
          bbqKeyboard(user.id),
          'bbq',
        );
        return true;
      }
      rows.push([{ text: '← Back', callback_data: guard('map_loc_bbq', user.id) }]);
      await showScreen(
        chatId,
        messageId,
        user,
        locBody('🍖 SEND TO BBQ', ['Select a shinobi.']),
        { inline_keyboard: rows },
        'bbq',
      );
      return true;
    }

    if (action === 'map_bbq_go' && parts.length >= 3) {
      const shinobi = parts[1];
      const result = await startBbq(user.id, shinobi);
      if (result.code === 'busy') {
        await answer(cb, 'That shinobi is on a mission/patrol.', true);
        return true;
      }
      await answer(cb);
      await showScreen(
        chatId,
        messageId,
        user,
        locBody(`🍖 ${EMO[shinobi] || '🥷'} ${escapeHtml(shinobi)} at BBQ`, [
          'Chakra recovers +20 every 30 minutes (catch-up when you open the map).',
        ]),
        bbqKeyboard(user.id),
        'bbq',
      );
      return true;
    }

    if (action === 'map_bbq_recall') {
      await answer(cb);
      const sessions = await listBbqSessions(user.id);
      if (!sessions.length) {
        await showScreen(
          chatId,
          messageId,
          user,
          locBody('🍖 BBQ', ['No shinobi at the BBQ.']),
          bbqKeyboard(user.id),
          'bbq',
        );
        return true;
      }
      const rows = sessions.map((s) => [{
        text: `${EMO[s.shinobi] || '🥷'} ${s.shinobi}`,
        callback_data: `map_bbq_stop:${s.shinobi}:${user.id}`,
      }]);
      rows.push([{ text: '← Back', callback_data: guard('map_loc_bbq', user.id) }]);
      await showScreen(
        chatId,
        messageId,
        user,
        locBody('🏠 RECALL FROM BBQ', ['Select a shinobi.']),
        { inline_keyboard: rows },
        'bbq',
      );
      return true;
    }

    if (action === 'map_bbq_stop' && parts.length >= 3) {
      const shinobi = parts[1];
      await stopBbq(user.id, shinobi);
      await answer(cb);
      await showScreen(
        chatId,
        messageId,
        user,
        locBody(`🏠 ${EMO[shinobi] || '🥷'} ${escapeHtml(shinobi)} left BBQ`, []),
        bbqKeyboard(user.id),
        'bbq',
      );
      return true;
    }

    // --- BBQ: instant exhaustion recovery (200 🍥 per shinobi) ---
    if (action === 'map_bbq_heal') {
      await answer(cb);
      await clearGateSelection(user.id);
      const exhausted = await listExhausted(user.id);
      if (!exhausted.length) {
        await showScreen(
          chatId,
          messageId,
          user,
          locBody('🍖 BBQ — HEAL EXHAUSTION', [
            'No shinobi is exhausted right now.',
            'Exhaustion starts after two consecutive patrols (30 min recovery).',
          ]),
          bbqKeyboard(user.id),
          'bbq',
        );
        return true;
      }
      const selected = new Set();
      const rows = exhausted.map((s) => [{
        text: `⬜️ ${EMO[s.shinobi] || '🥷'} ${s.shinobi} — ready at ${dueText(s.exhausted_until)}`,
        callback_data: `map_bbq_htog:${s.shinobi}:${user.id}`,
      }]);
      rows.push([
        { text: `🍖 Recover (200 🍥 each)`, callback_data: guard('map_bbq_hpay', user.id) },
        { text: '✖️ Cancel', callback_data: guard('map_loc_bbq', user.id) },
      ]);
      rows.push(backToMapRow(user.id));
      await showScreen(
        chatId,
        messageId,
        user,
        locBody('🍖 BBQ — HEAL EXHAUSTION', ['Tap exhausted shinobi to select.']),
        { inline_keyboard: rows },
        'bbq',
      );
      return true;
    }

    if (action === 'map_bbq_htog' && parts.length >= 3) {
      const shinobi = parts[1];
      await toggleGateSelection(user.id, shinobi);
      await answer(cb);
      const exhausted = await listExhausted(user.id);
      const selected = await listGateSelection(user.id);
      const rows = exhausted.map((s) => [{
        text: `${selected.has(s.shinobi) ? '✅' : '⬜️'} ${EMO[s.shinobi] || '🥷'} ${s.shinobi} — ready at ${dueText(s.exhausted_until)}`,
        callback_data: `map_bbq_htog:${s.shinobi}:${user.id}`,
      }]);
      rows.push([
        { text: '🍖 Recover (200 🍥 each)', callback_data: guard('map_bbq_hpay', user.id) },
        { text: '✖️ Cancel', callback_data: guard('map_loc_bbq', user.id) },
      ]);
      rows.push(backToMapRow(user.id));
      await showScreen(
        chatId,
        messageId,
        user,
        locBody('🍖 BBQ — HEAL EXHAUSTION', [`Selected: ${selected.size}`]),
        { inline_keyboard: rows },
        'bbq',
      );
      return true;
    }

    if (action === 'map_bbq_hpay') {
      const selected = [...(await listGateSelection(user.id))];
      const result = await healExhaustedAtBbq(user.id, selected);
      await clearGateSelection(user.id);
      if (result.code === 'none') {
        await answer(cb, 'No selected shinobi needs recovery (already ready).', true);
        await showScreen(chatId, messageId, user, await gateBody(user.id), gateKeyboard(user.id), 'gate');
        return true;
      }
      if (result.code === 'no_coins') {
        await answer(cb, `Not enough coins: need ${fmt(result.cost)} 🍥, have ${fmt(result.have)} 🍥.`, true);
        return true;
      }
      await answer(cb, `Recovered ${result.healed.length} shinobi (−${fmt(result.cost)} 🍥)`, true);
      await showScreen(
        chatId,
        messageId,
        user,
        locBody('🍖 RECOVERED', result.healed.map((n) => `${EMO[n] || '🥷'} ${escapeHtml(n)} is ready again — −${fmt(result.cost)} 🍥`)),
        bbqKeyboard(user.id),
        'bbq',
      );
      return true;
    }

    if (action === 'map_open_ability') {
      await answer(cb);
      try {
        await editRichOr(
          msg,
          user,
          abilityContent(user.id, { fromMap: true }),
          async () => {
            await editMapRich(chatId, messageId, style(abilityText()), abilityKeyboardFromMap(user.id));
          },
        );
      } catch (e) {
        console.error('[map ability]', e);
        try {
          await richOr(
            chatId,
            user,
            abilityContent(user.id, { fromMap: true }),
            async () => {
              await sendMapRich(chatId, style(abilityText()), abilityKeyboardFromMap(user.id));
            },
          );
        } catch (_) {}
      }
      return true;
    }

    // --- Training Ground ---
    if (action === 'map_train_sakura') {
      await answer(cb);
      const r = await trainSession(user.id, 'Sakura', 'Tsunade');
      await showScreen(chatId, messageId, user, trainResultBody(r), trainingKeyboard(user.id), 'training');
      return true;
    }

    if (action === 'map_train_naruto') {
      await answer(cb);
      const r = await trainSession(user.id, 'Naruto', 'Jiraiya');
      await showScreen(chatId, messageId, user, trainResultBody(r), trainingKeyboard(user.id), 'training');
      return true;
    }

    if (action === 'map_sk_heal_view') {
      await answer(cb);
      await showScreen(chatId, messageId, user, sakuraHealBody(user.id), trainingKeyboard(user.id), 'training');
      return true;
    }

    if (action === 'map_sk_heal') {
      const r = await sakuraHeal(user.id);
      if (r.code === 'locked') {
        await answer(cb, `Sakura's Healing unlocks at Lv. 4 (now Lv. ${r.level}).`, true);
        return true;
      }
      if (r.code === 'cooldown') {
        await answer(cb, `Already used — ready at ${dueText(r.until)}.`, true);
        return true;
      }
      if (r.code === 'nothing') {
        await answer(cb, 'Nothing to heal — no dead or exhausted shinobi and no mission cooldown.', true);
        return true;
      }
      if (r.code === 'not_owned') {
        await answer(cb, 'Sakura is not on your roster.', true);
        return true;
      }
      if (r.code === 'duplicate') {
        await answer(cb);
        return true;
      }
      await answer(cb, sakuraHealSummary(r), true);
      await showScreen(chatId, messageId, user, sakuraHealBody(user.id), trainingKeyboard(user.id), 'training');
      return true;
    }

    // --- Katsuyu's Healing ---
    if (action === 'map_kat') {
      await answer(cb);
      await showScreen(chatId, messageId, user, katsuyuBody(user.id), katsuyuKeyboard(user.id), 'training');
      return true;
    }

    if (action === 'map_kat_use') {
      const r = await katsuyuHeal(user.id);
      if (r.code === 'locked') {
        await answer(cb, "Katsuyu's Healing unlocks after 3 uses of Sakura's Healing.", true);
        return true;
      }
      if (r.code === 'cooldown') {
        await answer(cb, `Already used — ready at ${dueText(r.until)}.`, true);
        return true;
      }
      if (r.code === 'duplicate') {
        await answer(cb);
        return true;
      }
      await answer(cb, `+${r.chakra} ⚡ chakra granted!`, true);
      r.restorable = await restorableTimers(user.id);
      await showScreen(chatId, messageId, user, katsuyuRestoreBody(user.id, r), katsuyuRestoreKeyboard(user.id, r), 'training');
      return true;
    }

    if (action === 'map_kat_restore' && parts.length >= 4) {
      const kind = parts[1];
      const shinobi = parts[2];
      const healKey = parts[3];
      const r = await katsuyuRestore(user.id, kind, shinobi, healKey);
      if (r.code === 'duplicate') {
        await answer(cb, 'This Katsuyu use already restored a timer.', true);
        return true;
      }
      if (r.code === 'nothing') {
        await answer(cb, 'That timer already expired.', true);
        return true;
      }
      await answer(cb, `${shinobi}'s ${kind === 'exhaustion' ? 'exhaustion' : 'mission cooldown'} cleared!`, true);
      await showScreen(chatId, messageId, user, katsuyuBody(user.id), katsuyuKeyboard(user.id), 'training');
      return true;
    }

    await answer(cb);
    return true;
  } catch (e) {
    console.error('[map callback]', e);
    try {
      await answer(cb, 'Something went wrong.', true);
    } catch (_) {}
    return true;
  }
}
