/**
 * Pet System — every user-facing dialogue in one place.
 * Pure functions only: no SDK, no database, no Telegram calls.
 * Wording follows the Frozen Blooded small-caps catalogue.
 */

import { PET_NAMETAG_PRICE, PET_NAMETAG_MAX_LEN } from './defs.js';

export const PET_STATUS = {
  READY: 'READY',
  PLAYING: 'PLAYING',
  TRAINING: 'TRAINING',
  RESTING: 'RESTING',
  EXHAUSTED: 'EXHAUSTED',
};

/** Status shown in the pet stats screen. */
export const STATUS_LABEL = {
  READY: '🟢 ʀᴇᴀᴅʏ',
  PLAYING: '🎾 ᴘʟᴀʏɪɴɢ',
  TRAINING: '🏋️ ᴛʀᴀɪɴɪɴɢ',
  RESTING: '😴 ʀᴇꜱᴛɪɴɢ',
  EXHAUSTED: '⚠️ ᴇxʜᴀᴜꜱᴛᴇᴅ',
};

/** Compact one-liners used by /inventory and /gate. */
export const STATUS_INLINE = {
  READY: '🟢 ʀᴇᴀᴅʏ',
  PLAYING: '🎾 ᴘʟᴀʏɪɴɢ',
  TRAINING: '🏋️ ᴛʀᴀɪɴɪɴɢ',
  RESTING: '😴 ʀᴇꜱᴛɪɴɢ',
  EXHAUSTED: '⚠️ ᴇxʜᴀᴜꜱᴛᴇᴅ · ʀᴇꜱᴛ ʀᴇQᴜɪʀᴇᴅ',
};

const MINUTE = 60;

/** "29m", "1h 59m", "45s" — never negative. */
export function timeLeftText(value) {
  const seconds = Math.max(0, Math.trunc(Number(value) || 0));
  if (seconds < MINUTE) return `${seconds}s`;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.ceil((seconds % 3600) / MINUTE);
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  return `${minutes}m`;
}

export function statusInline(status, endsAt, nowSec = Math.floor(Date.now() / 1000)) {
  const key = PET_STATUS[status] || PET_STATUS.READY;
  const base = STATUS_INLINE[key];
  if (!endsAt || key === PET_STATUS.READY || key === PET_STATUS.EXHAUSTED) return base;
  return `${base} · ${timeLeftText(endsAt - nowSec)}`;
}

// ---- ownership / selection ----

export const NO_PETS_TEXT = "🐾 ʏᴏᴜ ᴅᴏɴ'ᴛ ᴏᴡɴ ᴀɴʏ ᴘᴇᴛꜱ ʏᴇᴛ.\nᴠɪꜱɪᴛ /pet_store ᴛᴏ ᴍᴇᴇᴛ ʏᴏᴜʀ ɴᴇᴡ ᴄᴏᴍᴘᴀɴɪᴏɴ!";
export const PET_NOT_FOUND_TEXT = '❌ ᴘᴇᴛ ɴᴏᴛ ꜰᴏᴜɴᴅ. ᴄʜᴏᴏꜱᴇ ᴏɴᴇ ᴏꜰ ʏᴏᴜʀ ᴏᴡɴᴇᴅ ᴘᴇᴛꜱ.';
export const NOT_YOUR_PET_TEXT = "🔒 ᴛʜɪꜱ ᴘᴇᴛ ᴅᴏᴇꜱɴ'ᴛ ʙᴇʟᴏɴɢ ᴛᴏ ʏᴏᴜ.";
export const NO_STARTER_TEXT = '🥷 ʏᴏᴜ ɴᴇᴇᴅ ᴀɴ ᴀᴠᴀɪʟᴀʙʟᴇ ꜱᴛᴀʀᴛᴇʀ ꜱʜɪɴᴏʙɪ ᴛᴏ ᴘʟᴀʏ ᴡɪᴛʜ ʏᴏᴜʀ ᴘᴇᴛ.';
export const EQUIP_PET_FIRST_TEXT = '⭐ ᴇǫᴜɪᴘ ᴛʜɪꜱ ᴘᴇᴛ ꜰɪʀꜱᴛ.';
export const EQUIP_TO_USE_TEXT = 'ᴇǫᴜɪᴘ ᴛʜɪꜱ ᴘᴇᴛ ᴛᴏ ᴜꜱᴇ ɪᴛꜱ ᴀᴄᴛɪᴏɴꜱ.';
export const EQUIP_TO_INTERACT_TEXT = 'ᴇǫᴜɪᴘ ᴛʜɪꜱ ᴘᴇᴛ ᴛᴏ ɪɴᴛᴇʀᴀᴄᴛ ᴡɪᴛʜ ɪᴛ.';
export const EQUIP_ONE_TEXT = '⭐ ᴇǫᴜɪᴘ ᴏɴᴇ ᴛᴏ ᴜꜱᴇ ꜰᴇᴇᴅ / ᴘʟᴀʏ / ᴛʀᴀɪɴ / ʀᴇꜱᴛ.';

// ---- shop / economy ----

export function buySuccessText(itemName) {
  return `🎉 ʏᴏᴜ ʙᴏᴜɢʜᴛ ${itemName}!`;
}

export function insufficientCoinsText(required, balance) {
  return `🍥 ɴᴏᴛ ᴇɴᴏᴜɢʜ ᴋᴏɴᴏʜᴀ ᴄᴏɪɴꜱ.\nʀᴇQᴜɪʀᴇᴅ: ${required} · ʙᴀʟᴀɴᴄᴇ: ${balance}`;
}

export function alreadyOwnedText(itemName) {
  return `⚠️ ʏᴏᴜ ᴀʟʀᴇᴀᴅʏ ᴏᴡɴ ${itemName}.`;
}

export const ITEM_NOT_FOUND_TEXT = '❌ ɪᴛᴇᴍ ɴᴏᴛ ꜰᴏᴜɴᴅ. ᴄʜᴇᴄᴋ ᴛʜᴇ ɴᴀᴍᴇ ᴀɴᴅ ᴛʀʏ ᴀɢᴀɪɴ.';

// ---- nametag / rename ----
export const RENAME_HINT_TEXT = 'ʀᴇɴᴀᴍᴇ ᴡɪᴛʜ /pet_rename NewName.';
export const RENAME_CALLBACK_HINT_TEXT = 'ʙᴜʏ ᴀ ᴘᴇᴛ ɴᴀᴍᴇᴛᴀɢ, ᴛʜᴇɴ ꜱᴇɴᴅ /pet_rename NewName.';

export function nametagBoughtText() {
  return '✅ ɴᴀᴍᴇᴛᴀɢ ᴘᴜʀᴄʜᴀꜱᴇᴅ. /pet_rename NewName ᴛᴏ ᴜꜱᴇ ɪᴛ.';
}

export function renameSuccessText(petName, newName) {
  return `✏️ ${petName} ɪꜱ ɴᴏᴡ “${newName}”.`;
}

export function renameUsageText() {
  return `ᴜꜱᴀɢᴇ: /pet_rename PetName NewName\nʀᴇǫᴜɪʀᴇꜱ ᴀ ᴘᴇᴛ ɴᴀᴍᴇᴛᴀɢ (${PET_NAMETAG_PRICE} 🍥) ꜰʀᴏᴍ /pet → ✏️.`;
}

export function noNametagText() {
  return `ʏᴏᴜ ᴅᴏɴ'ᴛ ᴏᴡɴ ᴀ ᴘᴇᴛ ɴᴀᴍᴇᴛᴀɢ (${PET_NAMETAG_PRICE} 🍥).`;
}

export function invalidPetNameText() {
  return `ɪɴᴠᴀʟɪᴅ ɴᴀᴍᴇ (1–${PET_NAMETAG_MAX_LEN} ᴄʜᴀʀᴀᴄᴛᴇʀꜱ).`;
}

export function equipSuccessText(itemName) {
  return `✅ ${itemName} ɪꜱ ɴᴏᴡ ᴇQᴜɪᴘᴘᴇᴅ.`;
}

export function notOwnedText(itemName) {
  return `❌ ʏᴏᴜ ᴅᴏɴ'ᴛ ᴏᴡɴ ${itemName}.`;
}

// ---- feeding ----

export function feedMenuText(petName) {
  return `🍖 ᴄʜᴏᴏꜱᴇ ꜰᴏᴏᴅ ꜰᴏʀ ${petName}.`;
}

export function feedSuccessText(petName, foodName, oldEnergy, newEnergy, xpGained) {
  return `🍖 ${petName} ᴇɴᴊᴏʏᴇᴅ ${foodName}!\n`
    + `⚡ ᴇɴᴇʀɢʏ: ${oldEnergy} → ${newEnergy}\n`
    + `✨ ᴘᴇᴛ xᴘ: +${xpGained}`;
}

export function feedInsufficientText(foodName, price, balance) {
  return `🍥 ɴᴏᴛ ᴇɴᴏᴜɢʜ ᴋᴏɴᴏʜᴀ ᴄᴏɪɴꜱ ᴛᴏ ʙᴜʏ ${foodName}.\nᴘʀɪᴄᴇ: ${price} · ʙᴀʟᴀɴᴄᴇ: ${balance}`;
}

export function petFullEnergyText(petName) {
  return `⚡ ${petName} ɪꜱ ᴀʟʀᴇᴀᴅʏ ᴀᴛ ꜰᴜʟʟ ᴇɴᴇʀɢʏ.`;
}

const BUSY_LABEL = {
  PLAYING: 'ᴘʟᴀʏɪɴɢ', TRAINING: 'ᴛʀᴀɪɴɪɴɢ', RESTING: 'ʀᴇꜱᴛɪɴɢ', EXHAUSTED: 'ᴇxʜᴀᴜꜱᴛᴇᴅ',
};

export function petCannotEatText(petName, status) {
  const label = BUSY_LABEL[String(status || '').toUpperCase()] || 'ʙᴜꜱʏ';
  return `⏳ ${petName} ɪꜱ ${label}. ᴡᴀɪᴛ ᴜɴᴛɪʟ ᴛʜᴇ ᴄᴜʀʀᴇɴᴛ ᴀᴄᴛɪᴠɪᴛʏ ᴇɴᴅꜱ.`;
}

// ---- play ----

export function playConfirmText(petName, shinobiName, minutes) {
  return '🎾 ʀᴇᴀᴅʏ ᴛᴏ ᴘʟᴀʏ!\n'
    + `🐾 ᴘᴇᴛ: ${petName}\n`
    + `🥷 ꜱʜɪɴᴏʙɪ: ${shinobiName}\n`
    + `⏱️ ᴅᴜʀᴀᴛɪᴏɴ: ${minutes} ᴍɪɴᴜᴛᴇꜱ\n`
    + 'ʙᴏᴛʜ ᴡɪʟʟ ʙᴇ ʙᴜꜱʏ ᴜɴᴛɪʟ ᴛʜᴇ ꜱᴇꜱꜱɪᴏɴ ᴇɴᴅꜱ.';
}

export function playStartedText(petName, shinobiName, minutes) {
  return `🎾 ${petName} ɪꜱ ᴘʟᴀʏɪɴɢ ᴡɪᴛʜ ${shinobiName}!\n⏳ ᴛɪᴍᴇ ʟᴇꜰᴛ: ${minutes} ᴍɪɴᴜᴛᴇꜱ`;
}

export function petBusyText(petName, activityLabel, left) {
  return `⏳ ${petName} ɪꜱ ʙᴜꜱʏ ᴡɪᴛʜ ${activityLabel}.\n`
    + `ᴛɪᴍᴇ ʟᴇꜰᴛ: ${left}\n`
    + 'ᴛʀʏ ᴀɢᴀɪɴ ᴀꜰᴛᴇʀ ᴛʜᴇ ꜱᴇꜱꜱɪᴏɴ.';
}

export function shinobiBusyText(shinobiName, activityLabel, left) {
  return `🥷 ${shinobiName} ɪꜱ ʙᴜꜱʏ ᴡɪᴛʜ ${activityLabel}.\nᴛɪᴍᴇ ʟᴇꜰᴛ: ${left}`;
}

export function playCompleteText(petName, shinobiName, xpGained, leftover = '') {
  return '🎾 ᴘʟᴀʏᴛɪᴍᴇ ᴄᴏᴍᴘʟᴇᴛᴇ!\n'
    + `🐾 ${petName} ʜᴀᴅ ꜰᴜɴ ᴡɪᴛʜ ${shinobiName}.\n`
    + `✨ ᴘᴇᴛ xᴘ: +${xpGained}${leftover}\n`
    + `😴 ${petName} ɪꜱ ᴇxʜᴀᴜꜱᴛᴇᴅ ɴᴏᴡ. ꜱᴇɴᴅ ʏᴏᴜʀ ᴘᴇᴛ ᴛᴏ ʀᴇꜱᴛ ꜰᴏʀ 30 ᴍɪɴᴜᴛᴇꜱ.`;
}

// ---- train ----

export function trainStartedText(petName, hours) {
  return `🏋️ ${petName} ꜱᴛᴀʀᴛᴇᴅ ᴛʀᴀɪɴɪɴɢ!\n`
    + `⏱️ ᴅᴜʀᴀᴛɪᴏɴ: ${hours} ʜᴏᴜʀꜱ\n`
    + '⏳ ʏᴏᴜ ᴄᴀɴ ᴄʜᴇᴄᴋ ᴘʀᴏɢʀᴇꜱꜱ ɪɴ /pet ᴍᴇ.';
}

export function trainCompleteText(petName, xpGained, leftover = '') {
  return '🏋️ ᴛʀᴀɪɴɪɴɢ ᴄᴏᴍᴘʟᴇᴛᴇ!\n'
    + `🐾 ${petName} ᴇᴀʀɴᴇᴅ +${xpGained} xᴘ${leftover}.\n`
    + `😴 ${petName} ɪꜱ ᴇxʜᴀᴜꜱᴛᴇᴅ ᴀɴᴅ ɴᴇᴇᴅꜱ 30 ᴍɪɴᴜᴛᴇꜱ ᴏꜰ ʀᴇꜱᴛ.`;
}

// ---- rest ----

export function restStartedText(petName, minutes) {
  return `😴 ${petName} ɪꜱ ʀᴇꜱᴛɪɴɢ.\n⏱️ ʀᴇᴄᴏᴠᴇʀʏ ᴛɪᴍᴇ: ${minutes} ᴍɪɴᴜᴛᴇꜱ.`;
}

export function restCompleteText(petName, energy, maxEnergy) {
  return `🌿 ${petName} ɪꜱ ʀᴇꜰʀᴇꜱʜᴇᴅ ᴀɴᴅ ʀᴇᴀᴅʏ ᴛᴏ ɢᴏ!\n⚡ ᴇɴᴇʀɢʏ: ${energy}/${maxEnergy}`;
}

export function restRequiredText(petName) {
  return `😴 ${petName} ɪꜱ ᴇxʜᴀᴜꜱᴛᴇᴅ.\n`
    + 'ꜱᴛᴀʀᴛ ᴀ 30-ᴍɪɴᴜᴛᴇ ʀᴇꜱᴛ ꜱᴇꜱꜱɪᴏɴ ʙᴇꜰᴏʀᴇ ᴛʜᴇ ɴᴇxᴛ ᴀᴄᴛɪᴠɪᴛʏ.';
}

export function alreadyReadyText(petName) {
  return `🟢 ${petName} ɪꜱ ᴀʟʀᴇᴀᴅʏ ʀᴇᴀᴅʏ. ɴᴏ ʀᴇꜱᴛ ɴᴇᴇᴅᴇᴅ.`;
}

// ---- xp / levels ----

export function xpEarnedText(petName, xpGained) {
  return `✨ ${petName} ᴇᴀʀɴᴇᴅ +${xpGained} ᴘᴇᴛ xᴘ!`;
}

export function levelUpText(petName, level, totalXp) {
  return `🎉 ʟᴇᴠᴇʟ ᴜᴘ!\n🐾 ${petName} ʀᴇᴀᴄʜᴇᴅ ʟᴇᴠᴇʟ ${level}!\n✨ ᴛᴏᴛᴀʟ xᴘ: ${totalXp}`;
}

export function maxLevelText(petName) {
  return `👑 ${petName} ʜᴀꜱ ʀᴇᴀᴄʜᴇᴅ ᴍᴀx ʟᴇᴠᴇʟ!`;
}

/** One completion message per settled session (XP + level-up combined). */
export function activityCompleteText(done) {
  const levelLine = done.levelUp
    ? `\n${levelUpText(done.petName, done.level, done.totalXp)}`
    : (done.maxLevel ? `\n${maxLevelText(done.petName)}` : '');
  if (done.activityType === 'rest') {
    return restCompleteText(done.petName, done.energy ?? 100, done.maxEnergy ?? 100);
  }
  if (done.activityType === 'train') return trainCompleteText(done.petName, done.xp, levelLine);
  if (done.activityType === 'play') {
    return playCompleteText(done.petName, done.shinobiName || '—', done.xp, levelLine);
  }
  return `🐾 ${done.petName} ꜰɪɴɪꜱʜᴇᴅ ${done.activityType}.\n✨ ᴘᴇᴛ xᴘ: +${done.xp}${levelLine}`;
}

// ---- session / callback errors ----

export const DUPLICATE_SESSION_TEXT = '⏳ ᴀɴ ᴀᴄᴛɪᴠɪᴛʏ ɪꜱ ᴀʟʀᴇᴀᴅʏ ʀᴜɴɴɪɴɢ.';
export const PET_WOKE_TEXT = '☀️ ʏᴏᴜʀ ᴘᴇᴛ ᴡᴏᴋᴇ ᴜᴘ.';
export const SHINOBI_BUSY_TEXT = '🥷 ᴛʜᴀᴛ ꜱʜɪɴᴏʙɪ ɪꜱ ʙᴜꜱʏ. ᴛʀʏ ᴀɢᴀɪɴ ʟᴀᴛᴇʀ.';
export const WRONG_LOCATION_TEXT = '❌ ᴡʀᴏɴɢ ʟᴏᴄᴀᴛɪᴏɴ ꜰᴏʀ ᴛʜɪꜱ ᴀᴄᴛɪᴠɪᴛʏ.';
export const SESSION_CANNOT_START_TEXT = "❌ ᴛʜɪꜱ ᴀᴄᴛɪᴠɪᴛʏ ᴄᴀɴ'ᴛ ꜱᴛᴀʀᴛ ʀɪɢʜᴛ ɴᴏᴡ.\nᴄʜᴇᴄᴋ ʏᴏᴜʀ ᴘᴇᴛ'ꜱ ꜱᴛᴀᴛᴜꜱ ᴀɴᴅ ᴛʀʏ ᴀɢᴀɪɴ.";
export const STALE_MENU_TEXT = '⚠️ ᴛʜɪꜱ ᴍᴇɴᴜ ɪꜱ ᴏᴜᴛᴅᴀᴛᴇᴅ. ᴏᴘᴇɴ /pet ᴍᴇ ᴀɢᴀɪɴ.';
export const UNEXPECTED_ERROR_TEXT = '❌ ꜱᴏᴍᴇᴛʜɪɴɢ ᴡᴇɴᴛ ᴡʀᴏɴɢ. ᴘʟᴇᴀꜱᴇ ᴛʀʏ ᴀɢᴀɪɴ.';
export const WRONG_OWNER_TEXT = "🔒 ᴛʜɪꜱ ᴍᴇɴᴜ ɪꜱɴ'ᴛ ʏᴏᴜʀꜱ.";
export const NOT_RESTING_TEXT = '☀️ ᴛʜɪꜱ ᴘᴇᴛ ɪꜱ ɴᴏᴛ ʀᴇꜱᴛɪɴɢ.';

/**
 * Dot progress between the current and next level.
 * Five positions, resets at every level, full at max level.
 */
export function progressDots(currentXp, level, thresholds, maxLevel) {
  if (level >= maxLevel) return '●'.repeat(5);
  const start = Number(thresholds[level] || 0);
  const end = Number(thresholds[level + 1] || 0);
  const span = Math.max(1, end - start);
  const fraction = Math.max(0, Math.min(1, (Number(currentXp) - start) / span));
  const filled = Math.min(5, Math.max(0, Math.round(fraction * 5)));
  return '●'.repeat(filled) + '○'.repeat(5 - filled);
}

export const PET_ABILITY_URL = 'https://t.me/frozenblooded/23';

/** `/pet help` — command list; commands stay plain so they can be copied. */
export function petCommandsText() {
  return [
    '🐾 𝐏𝐄𝐓 𝐂ᴏᴍᴍᴀɴᴅꜱ',
    '/pet — pet list & profile',
    '/pet me [name] — pet menu (feed · play · train · rest · stats)',
    '/pet_store — Axofly & Capycorn',
    '/buy <pet name> — buy a pet',
    '/equip <pet name> — set the active pet',
    '/pet_rename <name> — rename the equipped pet (needs Nametag)',
  ].join('\n');
}

/**
 * Store instruction line:
 *   ʙᴜʏ ᴡɪᴛʜ: "/buy pet name" ᴇǫᴜɪᴘ ᴡɪᴛʜ: /equip pet name
 * The placeholders are written in the bot's small-caps style because every
 * outgoing message is styled anyway — this way the constant equals exactly what
 * the player sees (commands keep their real `/buy` / `/equip` spelling).
 */
export const STORE_INSTRUCTION = 'ʙᴜʏ ᴡɪᴛʜ: "/buy ᴘᴇᴛ ɴᴀᴍᴇ" ᴇǫᴜɪᴘ ᴡɪᴛʜ: /equip ᴘᴇᴛ ɴᴀᴍᴇ';
