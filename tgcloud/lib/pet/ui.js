/**
 * Pet screens, keyboards and callback routing.
 *
 * Commands: /pet, /pet_store, /pet_rename
 * Pets are bought with /buy <name> and equipped with /equip <name> — the same
 * commands as shinobi (see buy.js / economy_handler.js).
 *
 * Callback shape is owner-first and every pet id is re-validated server-side:
 *   pet_menu:{uid}            pet list / active pet
 *   pet_me:{uid}:{petId}      detail menu
 *   pet_feed_menu:{uid}:{petId}  · pet_food:{uid}:{petId}:{foodKey}
 *   pet_play:{uid}:{petId}    → pet_start:{uid}:{petId}:play:{shinobi}
 *   pet_train:{uid}:{petId}   · pet_rest:{uid}:{petId} · pet_wake:{uid}:{petId}
 *   pet_stats:{uid}:{petId}   · pet_equip:{uid}:{petId} · pet_store:{uid}
 * A user can only ever address their own rows: the owner id in the callback
 * must match cb.from.id and the pet must exist in that user's collection.
 */

import { db } from 'sdk';
import { sql } from 'sdk/db';
import { BotApiError } from 'sdk';
import { api } from '../message_api.js';
import { editRichOr, richOr, P, table, row, btn } from '../rich.js';
import { keyboardToRichRows } from '../map/rich.js';
import { escapeHtml, style } from '../texts.js';
import { fmt } from '../store.js';
import { getPetPhotoFileId } from './media.js';
import {
  PETS, PET_MAX_LEVEL, PET_MAX_ENERGY, PET_ACTIVITIES, PET_FOOD_MENU,
  PET_NAMETAG_PRICE, PET_NAMETAG_MAX_LEN, PET_NAMETAG_KEY,
  PET_XP_THRESHOLDS, PET_XP_CAP, petXpForNextLevel, petAbilityUrl,
} from './defs.js';
import {
  listPets, getPet, getEquippedPet, getPetActivity, equipPet, renamePet,
  buyPetNametag, specialItemQty, buyPetFood, getPetStats, petAbilityLines,
  ownedShinobi, shinobiAvailability, startPetActivity, cancelPetActivity,
  petStateOf, listPetActivities,
} from './store.js';
import {
  PET_STATUS, STATUS_LABEL, NO_PETS_TEXT, PET_NOT_FOUND_TEXT, NOT_YOUR_PET_TEXT,
  NO_STARTER_TEXT, ITEM_NOT_FOUND_TEXT, feedMenuText, feedSuccessText,
  feedInsufficientText, petFullEnergyText, petCannotEatText, playStartedText,
  petBusyText, shinobiBusyText, playCompleteText, trainStartedText,
  trainCompleteText, restStartedText, restCompleteText, restRequiredText,
  alreadyReadyText, levelUpText, maxLevelText,
  SESSION_CANNOT_START_TEXT, STALE_MENU_TEXT, UNEXPECTED_ERROR_TEXT,
  WRONG_OWNER_TEXT, NOT_RESTING_TEXT, progressDots, timeLeftText, PET_ABILITY_URL,
  STORE_INSTRUCTION, insufficientCoinsText, equipSuccessText, notOwnedText,
  activityCompleteText, EQUIP_PET_FIRST_TEXT, EQUIP_TO_USE_TEXT,
  EQUIP_TO_INTERACT_TEXT, EQUIP_ONE_TEXT, RENAME_HINT_TEXT,
  RENAME_CALLBACK_HINT_TEXT, PET_WOKE_TEXT, SHINOBI_BUSY_TEXT, WRONG_LOCATION_TEXT,
  nametagBoughtText, renameSuccessText, renameUsageText, noNametagText,
  invalidPetNameText, petCommandsText, petCardLines, petNotHungryText,
  PET_FOOD_CAPTION, PET_FOOD_PRICE_LABEL, statusWord,
  petCurrentActivityText, ONE_PET_ONLY_TEXT, petSwitchedText,
} from './text.js';

const now = () => Math.floor(Date.now() / 1000);

const SHINOBI_EMOJI = {
  Sasuke: '⚔️', Sakura: '🌸', Naruto: '🍥', Itachi: '👁️',
  Hinata: '👁️', Jiraiya: '🐸', Tsunade: '🐌', 'Starter Shinobi': '🥷',
};

const ACTIVITY_LABEL = {
  play: 'ᴘʟᴀʏ', train: 'ᴛʀᴀɪɴ', rest: 'ʀᴇꜱᴛ', feed: 'ꜰᴇᴇᴅ',
};

function safe(value) {
  return escapeHtml(value == null ? '' : String(value));
}

function timeLeft(ts) {
  return timeLeftText(Math.max(0, Number(ts || 0) - now()));
}

export function petStatusText(pet) {
  const status = pet?.status || PET_STATUS.READY;
  const base = STATUS_LABEL[status] || STATUS_LABEL.READY;
  if (pet?.statusEndsAt) return `${base} · ${timeLeft(pet.statusEndsAt)}`;
  return base;
}

function petByIdOrName(raw) {
  const want = String(raw || '').trim().toLowerCase();
  if (!want) return null;
  return Object.values(PETS).find((p) => p.id === want || p.name.toLowerCase() === want) || null;
}

async function findOwnedPet(userId, raw) {
  const def = petByIdOrName(raw);
  if (def) return getPet(userId, def.id);
  const pets = await listPets(userId);
  const want = String(raw || '').trim().toLowerCase();
  return pets.find((p) => String(p.name || '').toLowerCase() === want) || null;
}

function xpStats(pet) {
  const level = pet.level;
  const max = PET_MAX_LEVEL;
  const nextThreshold = petXpForNextLevel(level);
  const levelStart = Number(PET_XP_THRESHOLDS[level] || 0);
  const currentLevelXp = Math.max(0, pet.xp - levelStart);
  const levelSpan = nextThreshold ? nextThreshold - levelStart : 0;
  return {
    level,
    max,
    nextThreshold,
    currentLevelXp,
    levelSpan,
    dots: progressDots(pet.xp, level, PET_XP_THRESHOLDS, max),
  };
}

/** Ability title + effect lines for the pet's own ability (stats screen). */
function abilityTitle(pet) {
  return pet.petId === 'capycorn' ? '👑 𝐑𝐎𝐘𝐀𝐋 𝐏𝐀𝐂𝐄' : '🦋 𝐅𝐋𝐔𝐓𝐓ᴇʀ 𝐅ᴏʀᴛᴜɴᴇ';
}

function abilityStatLines(pet) {
  const level = pet.level;
  if (pet.petId === 'capycorn') {
    const [dur, cd] = pet.def.timeReduction[level] || [0, 0];
    return [
      `⏱️ ᴅᴜʀᴀᴛɪᴏɴ: −${Math.round(dur * 100)}%`,
      `⏳ ᴄᴏᴏʟᴅᴏᴡɴ: −${Math.round(cd * 100)}%`,
    ];
  }
  const [chance, bonus] = pet.def.rewardBoost[level] || [0, 0];
  return [
    `🍀 ᴛʀɪɢɢᴇʀ ᴄʜᴀɴᴄᴇ: ${Math.round(chance * 100)}%`,
    `🎁 ʀᴇᴡᴀʀᴅ ʙᴏɴᴜꜱ: +${Math.round(bonus * 100)}%`,
    `✨ ꜱʜɪɴᴏʙɪ xᴘ: +${Math.round((pet.def.shinobiXpBonus[level] || 0) * 100)}%`,
  ];
}

/**
 * Pet stats screen (requested layout):
 *   stats → rich divider → the pet's own ability block.
 */
export function petStatsLines(pet, lifetimeXp) {
  const s = xpStats(pet);
  const xpText = s.nextThreshold
    ? `${fmt(s.currentLevelXp)} / ${fmt(s.levelSpan)}`
    : `${fmt(pet.xp)} / ${fmt(PET_XP_CAP)}`;
  return [
    '📊 𝐏𝐄𝐓 𝐒𝐓𝐀𝐓𝐒',
    `⭐ ʟᴇᴠᴇʟ: ${s.level}/${s.max}\u3000${s.dots}`,
    `✨ xᴘ: ${xpText}`,
    `⚡ ᴇɴᴇʀɢʏ: ${pet.energy}/${PET_MAX_ENERGY}`,
    `🏋️ ꜱᴛᴀᴛᴜꜱ: ${statusWord(pet.status, pet.statusEndsAt)}`,
    `🏆 ᴛᴏᴛᴀʟ xᴘ ᴇᴀʀɴᴇᴅ: ${fmt(Math.max(pet.xp, lifetimeXp || 0))}`,
  ];
}

/** Ability block — only the pet's own ability. */
function abilityLines(pet) {
  return [abilityTitle(pet), ...abilityStatLines(pet)];
}

/** Pet card caption: name / current status / ability (requested layout). */
export function petCardCaption(pet) {
  return petCardLines(pet).join('\n');
}

/** Card caption as rich HTML (the photo's figcaption). */
export function petCardCaptionHtml(pet) {
  const lines = petCardLines(pet);
  // Keep the pet's own name verbatim; the narrator lines use the bot style.
  return lines
    .map((line, i) => (line ? (i === 0 ? safe(line) : style(escapeHtml(line))) : ''))
    .join('<br/>');
}

// ---- content builders (rich blocks) ----

export async function petListContent(user) {
  const pets = await listPets(user.id);
  if (!pets.length) {
    return [
      P('🐾 𝐏𝐄𝐓𝐒'),
      P(NO_PETS_TEXT),
      row(btn('🛒 Pet Store', { callback_data: `pet_store:${user.id}`, style: 'success' })),
    ];
  }
  const blocks = [P('🐾 𝐏𝐄𝐓𝐒')];
  const active = pets.find((p) => p.equipped);
  if (active) {
    blocks.push(P(`${active.def.emoji} <b>${safe(active.name)}</b> · ${active.def.name} · ʟᴠ ${active.level}`));
    blocks.push(P(`⚡ ${active.energy}/${PET_MAX_ENERGY} · ${petStatusText(active)}`));
  } else {
    blocks.push(P('ᴇQᴜɪᴘ ᴏɴᴇ ᴛᴏ ᴜꜱᴇ ꜰᴇᴇᴅ / ᴘʟᴀʏ / ᴛʀᴀɪɴ / ʀᴇꜱᴛ.'));
  }
  for (const pet of pets) {
    const buttons = [btn(
      `${pet.def.emoji} ${pet.name}${pet.equipped ? ' ⭐' : ''} · ${STATUS_LABEL[pet.status] || ''}`,
      { callback_data: `pet_me:${user.id}:${pet.petId}`, style: pet.equipped ? 'success' : 'primary' },
    )];
    if (!pet.equipped) {
      buttons.push(btn('⭐ Equip', { callback_data: `pet_equip:${user.id}:${pet.petId}`, style: 'success' }));
    }
    blocks.push(row(...buttons));
  }
  blocks.push(row(
    btn('🛒 Pet Store', { callback_data: `pet_store:${user.id}`, style: 'success' }),
  ));
  return blocks;
}

/**
 * Pet card (/pet and every pet entry point): the pet photo with the menu as
 * its caption and the fixed action rows requested.
 */
export async function petDetailContent(user, pet) {
  if (!pet) {
    return [P(PET_NOT_FOUND_TEXT), row(btn('⬅️ Back', { callback_data: `pet_menu:${user.id}`, style: 'danger' }))];
  }
  const lines = petCardLines(pet);
  return [
    ...lines.filter(Boolean).map((line) => P(line)),
    ...petCardBlockRows(user.id, pet),
  ];
}

/**
 * The fixed three-row pet menu (spec): actions · profile · manage.
 * Rows never grow — feed/play/train/rest, stats/abilities/switch, rename/close.
 */
export function petCardRows(userId, pet) {
  return [
    [
      btn('🍖 Feed', { callback_data: `pet_feed_menu:${userId}:${pet.petId}`, style: 'primary' }),
      btn('🎾 Play', { callback_data: `pet_play:${userId}:${pet.petId}`, style: 'primary' }),
      btn('🏋️ Train', { callback_data: `pet_train:${userId}:${pet.petId}`, style: 'primary' }),
      btn('😴 Rest', { callback_data: `pet_rest:${userId}:${pet.petId}`, style: 'primary' }),
    ],
    [
      btn('📊 Pet stats', { callback_data: `pet_stats:${userId}:${pet.petId}`, style: 'primary' }),
      btn('🕸️ Pet abilities', { url: petAbilityUrl(pet.petId, PET_ABILITY_URL), style: 'primary' }),
    ],
    [
      // Switch is a one-tap auto-equip of the other owned pet (no picker).
      btn('🔄 Switch pet', { callback_data: `pet_switch:${userId}:${pet.petId}`, style: 'primary' }),
      btn('✏️ Rename pet', { callback_data: `pet_name:${userId}:${pet.petId}`, style: 'primary' }),
      btn('❌ Close', { callback_data: `pet_close:${userId}`, style: 'danger' }),
    ],
  ];
}

export function petCardKeyboard(userId, pet) {
  return { inline_keyboard: petCardRows(userId, pet) };
}

function petCardBlockRows(userId, pet) {
  return petCardRows(userId, pet).map((buttons) => row(...buttons));
}

/** Card HTML: the photo figure (or plain paragraphs) + the three button rows. */
export function petCardHtml(user, pet, fileId = null) {
  const caption = petCardCaptionHtml(pet);
  const body = fileId
    ? `<figure><img src="tg://photo?id=pet_card"/><figcaption>${caption}</figcaption></figure>`
    : caption;
  return body + keyboardToRichRows(petCardKeyboard(user.id, pet));
}

function petCardRichMessage(user, pet, fileId) {
  return {
    html: petCardHtml(user, pet, fileId),
    ...(fileId ? { media: [{ id: 'pet_card', media: { type: 'photo', media: fileId } }] } : {}),
  };
}

/** Send the pet card with its photo (classic fallback keeps the buttons). */
export async function sendPetCard(chatId, user, pet) {
  const fileId = await getPetPhotoFileId(chatId, pet.petId);
  const keyboard = petCardKeyboard(user.id, pet);
  try {
    return await api.sendRichMessage({
      chat_id: chatId,
      rich_message: petCardRichMessage(user, pet, fileId),
    });
  } catch (e) {
    console.error('[pet card]', e?.description || e);
  }
  if (fileId) {
    try {
      return await api.sendPhoto({
        chat_id: chatId,
        photo: fileId,
        caption: petCardCaption(pet),
        reply_markup: keyboard,
      });
    } catch (e) {
      console.error('[pet card photo]', e?.description || e);
    }
  }
  return api.sendMessage({
    chat_id: chatId,
    text: petCardCaption(pet),
    reply_markup: keyboard,
  });
}

/**
 * Re-render the pet card in place.
 * 1) rich edit with the photo (photo messages) · 2) rich edit without media
 * (text messages can never gain a photo) · 3) caption edit · 4) classic text.
 */
async function renderPetCard(msg, user, pet) {
  if (!pet) return;
  const fileId = await getPetPhotoFileId(msg.chat.id, pet.petId);
  const keyboard = petCardKeyboard(user.id, pet);
  if (fileId) {
    try {
      await api.editMessageText({
        chat_id: msg.chat.id,
        message_id: msg.message_id,
        rich_message: petCardRichMessage(user, pet, fileId),
      });
      return;
    } catch (e) {
      if (!(e instanceof BotApiError)) console.error('[pet card edit]', e);
    }
  }
  try {
    await api.editMessageText({
      chat_id: msg.chat.id,
      message_id: msg.message_id,
      rich_message: petCardRichMessage(user, pet, null),
    });
    return;
  } catch (e) {
    if (!(e instanceof BotApiError)) console.error('[pet card text edit]', e);
  }
  try {
    await api.editMessageCaption({
      chat_id: msg.chat.id,
      message_id: msg.message_id,
      caption: petCardCaption(pet),
      reply_markup: keyboard,
    });
    return;
  } catch (_) { /* not a photo message */ }
  try {
    await api.editMessageText({
      chat_id: msg.chat.id,
      message_id: msg.message_id,
      text: petCardCaption(pet),
      reply_markup: keyboard,
    });
  } catch (e) {
    console.error('[pet card fallback]', e?.description || e);
  }
}

/**
 * Latest `/pet` card in an existing message — used by every legacy entry point
 * (the old map pet menu, completion buttons) so they never render the retired
 * menu again. Falls back to the first owned pet when nothing is equipped.
 */
export async function showPetCard(msg, user, pet = null) {
  let target = pet;
  if (!target) {
    const pets = await listPets(user.id);
    target = pets.find((p) => p.equipped) || (pets.length === 1 ? pets[0] : null);
  }
  if (!target) return null;
  await renderPetCard(msg, user, target);
  return target;
}

/** Heading stays outside the quote; every stat line is quoted (requested). */
function statsHeadingAndLines(pet, lifetimeXp) {
  const [heading, ...lines] = petStatsLines(pet, lifetimeXp);
  return { heading, lines };
}

export async function petStatsContent(user, pet) {
  const target = pet || await getEquippedPet(user.id);
  if (!target) return petListContent(user);
  const stats = await getPetStats(user.id);
  const { heading, lines } = statsHeadingAndLines(target, stats.xpEarned);
  return [
    P(heading),
    { type: 'blockquote', blocks: lines.map((line) => P(line)) },
    { type: 'divider' },
    ...abilityLines(target).map((line) => P(line)),
    row(
      btn('⬅️ Back', { callback_data: `pet_me:${user.id}:${target.petId}`, style: 'danger' }),
      btn('🕸️ Pet abilities', {
        url: petAbilityUrl(target.petId, PET_ABILITY_URL), style: 'primary',
      }),
    ),
  ];
}

export async function petStoreContent(user, options = {}) {
  const pets = await listPets(user.id);
  const owned = new Set(pets.map((p) => p.petId));
  const balance = await db.get(sql`SELECT balance FROM users WHERE telegram_id = ${user.id}`);
  const rows = [['Pet', 'Price', 'Ability']];
  for (const def of Object.values(PETS)) {
    rows.push([`${def.emoji} ${def.name}${owned.has(def.id) ? ' ✓' : ''}`, `${fmt(def.price)} 🍥`, def.abilityName]);
  }
  return [
    P('🐾 𝐏𝐄𝐓 𝐒𝐓𝐎𝐑𝐄'),
    P(`🍥 Balance: ${fmt(Number(balance?.balance || 0))}`),
    table(rows),
    // Verbatim: the store line keeps its command examples in plain lowercase.
    { type: 'paragraph', text: STORE_INSTRUCTION },
    row(
      btn('🍖 Pet food', { callback_data: `pet_food_menu:${user.id}`, style: 'success' }),
      btn('🕸️ Pet abilities', { url: PET_ABILITY_URL, style: 'primary' }),
    ),
    row(btn('⬅️ Back', { callback_data: options.back || `pet_menu:${user.id}`, style: 'danger' })),
  ];
}

/**
 * Pet food screen: the three meals with their effect/price, a rich divider,
 * then the price buttons that buy the meal, and Back.
 */
export function petFoodBlocks(userId, petId) {
  const target = petId || '';
  const rows = Object.entries(PET_FOOD_MENU).map(([key]) => ({
    text: PET_FOOD_PRICE_LABEL[key],
    callback_data: `pet_food:${userId}:${target}:${key}`,
    style: 'success',
  }));
  return rows;
}

export async function petFoodContent(user, petId = null) {
  const pet = petId ? await getPet(user.id, petId) : await getEquippedPet(user.id);
  // Keep the authored blank separators between meals (rich + classic).
  const blocks = PET_FOOD_CAPTION.map((line) => P(line));
  blocks.push({ type: 'divider' });
  blocks.push(row(...petFoodBlocks(user.id, pet ? pet.petId : null)
    .map((b) => btn(b.text, { callback_data: b.callback_data, style: b.style }))));
  blocks.push(row(btn('⬅️ Back', {
    callback_data: pet ? `pet_me:${user.id}:${pet.petId}` : `pet_menu:${user.id}`,
    style: 'danger',
  })));
  return blocks;
}

/** Pet food caption as one HTML string (Ramen Shop panel). */
export function petFoodCaptionHtml() {
  // Blank caption lines keep the requested spacing between the meal blocks.
  return PET_FOOD_CAPTION
    .map((line) => `<p>${line ? style(line) : ' '}</p>`)
    .join('') + '<hr/>';
}

/** Price buttons for the Ramen Shop panel (`map_pet_food_buy:{key}:{petId?}:{uid}`). */
export function petFoodPriceKeyboard(userId, petId = null) {
  const priceRow = Object.entries(PET_FOOD_MENU).map(([key]) => ({
    text: PET_FOOD_PRICE_LABEL[key],
    callback_data: `map_pet_food_buy:${key}${petId ? `:${petId}` : ''}:${userId}`,
    style: 'success',
  }));
  return {
    inline_keyboard: [
      priceRow,
      [{ text: '⬅️ Back', callback_data: `map_loc_ichiraku:${userId}`, style: 'danger' }],
    ],
  };
}

async function shinobiOptions(userId) {
  const names = await ownedShinobi(userId);
  const out = [];
  for (const name of names) out.push({ name, reason: await shinobiAvailability(userId, name) });
  return out;
}

export function shinobiOptionsText(options) {
  if (!options.length) return NO_STARTER_TEXT;
  return options.map((o) => `${SHINOBI_EMOJI[o.name] || '🥷'} ${o.name}`
    + `${o.reason ? ` — ${o.reason.replace(/_/g, ' ')}` : ' — available'}`).join('\n');
}

export async function playPickerContent(user, pet) {
  const options = await shinobiOptions(user.id);
  const available = options.filter((o) => !o.reason);
  if (!available.length) {
    return [
      P('🎾 𝐏𝐋𝐀𝐘'),
      P(NO_STARTER_TEXT),
      row(btn('⬅️ Back', { callback_data: `pet_me:${user.id}:${pet.petId}`, style: 'danger' })),
    ];
  }
  const blocks = [
    P('🎾 𝐂𝐇ᴏᴏꜱᴇ ᴀ ꜱʜɪɴᴏʙɪ'),
    P(`🐾 ${safe(pet.name)} · ⏱️ ${PET_ACTIVITIES.play.durationMinutes} ᴍɪɴᴜᴛᴇꜱ · +${PET_ACTIVITIES.play.xp} xᴘ`),
    P('ʙᴏᴛʜ ᴡɪʟʟ ʙᴇ ʙᴜꜱʏ ᴜɴᴛɪʟ ᴛʜᴇ ꜱᴇꜱꜱɪᴏɴ ᴇɴᴅꜱ.'),
  ];
  for (const option of options) {
    blocks.push(row(btn(
      `${SHINOBI_EMOJI[option.name] || '🥷'} ${option.name}${option.reason ? ' (busy)' : ''}`,
      {
        callback_data: option.reason
          ? `pet_noop:${user.id}`
          : `pet_start:${user.id}:${pet.petId}:play:${option.name}`,
        style: option.reason ? 'transparent' : 'primary',
      },
    )));
  }
  blocks.push(row(btn('⬅️ Back', { callback_data: `pet_me:${user.id}:${pet.petId}`, style: 'danger' })));
  return blocks;
}

export async function nametagContent(userId, back = null) {
  const balance = await db.get(sql`SELECT balance FROM users WHERE telegram_id = ${userId}`);
  const qty = await specialItemQty(userId, PET_NAMETAG_KEY);
  return [
    P('✏️ 𝐏𝐄𝐓 𝐍ᴀᴍᴇᴛᴀɢ'),
    P(`ᴘʀɪᴄᴇ: ${fmt(PET_NAMETAG_PRICE)} 🍥 · ᴍᴀx ${PET_NAMETAG_MAX_LEN} ᴄʜᴀʀᴀᴄᴛᴇʀꜱ`),
    P(`ʏᴏᴜʀ ɴᴀᴍᴇᴛᴀɢꜱ: ${qty} · ʙᴀʟᴀɴᴄᴇ: ${fmt(Number(balance?.balance || 0))} 🍥`),
    P(RENAME_HINT_TEXT),
    row(
      btn(`🛒 Buy Nametag — ${fmt(PET_NAMETAG_PRICE)} 🍥`, {
        callback_data: `pet_nametag_buy:${userId}`, style: 'success',
      }),
      btn('⬅️ Back', { callback_data: back || `pet_menu:${userId}`, style: 'danger' }),
    ),
  ];
}

// ---- start helpers ----

/**
 * Start a session for one owned pet. `shinobi` is only used by Play (the pet
 * and the shinobi are locked together); Train and Rest lock the pet alone.
 */
export async function performPetStart(userId, petId, type, options = {}) {
  const pet = petId ? await getPet(userId, petId) : await getEquippedPet(userId);
  if (!pet) return { code: 'no_pet' };
  const result = await startPetActivity(userId, pet.petId, type, {
    chatId: Number(options.chatId || 0),
    shinobi: options.shinobi || null,
    locationKey: options.locationKey || null,
  });
  return { ...result, pet: result.pet || pet };
}

/** Activity key currently running on a pet (null when it is not busy). */
function currentActivityKey(pet) {
  const status = String(pet?.status || '');
  if (status === PET_STATUS.PLAYING) return 'play';
  if (status === PET_STATUS.TRAINING) return 'train';
  if (status === PET_STATUS.RESTING) return 'rest';
  return null;
}

/**
 * Refusal text that always names the running activity + time left and the
 * action that was refused (requested: never a vague "activity running").
 */
export function busyActivityText(result, type) {
  const pet = result?.pet || null;
  const current = result?.activity || currentActivityKey(pet);
  const until = Number(result?.until || pet?.statusEndsAt || 0);
  return petCurrentActivityText(pet?.name || 'ʏᴏᴜʀ ᴘᴇᴛ', current, type, until);
}

export function startResultText(result, type) {
  const cfg = PET_ACTIVITIES[type] || {};
  const petName = result.pet?.name || 'ʏᴏᴜʀ ᴘᴇᴛ';
  if (result.code === 'ok') {
    if (type === 'rest') return restStartedText(petName, cfg.durationMinutes);
    if (type === 'train') return trainStartedText(petName, Math.round(cfg.durationMinutes / 60));
    return playStartedText(petName, result.shinobi || '—', cfg.durationMinutes);
  }
  // Busy: spell out the current activity instead of a generic sentence.
  if (result.code === 'busy' || result.code === 'duplicate_session') return busyActivityText(result, type);
  if (result.code === 'rest_required') return restRequiredText(petName);
  if (result.code === 'not_exhausted') return alreadyReadyText(petName);
  if (result.code === 'shinobi_busy') {
    return shinobiBusyText(result.shinobi || 'ꜱʜɪɴᴏʙɪ', ACTIVITY_LABEL[result.activity] || 'ᴘʟᴀʏ',
      timeLeftText(result.until ? result.until - now() : 0));
  }
  if (result.code === 'no_shinobi') return NO_STARTER_TEXT;
  if (result.code === 'no_energy') {
    return `⚡ ɴᴏᴛ ᴇɴᴏᴜɢʜ ᴇɴᴇʀɢʏ (${result.energy}/${PET_MAX_ENERGY}). ꜰᴇᴇᴅ ʏᴏᴜʀ ᴘᴇᴛ ꜰɪʀꜱᴛ.`;
  }
  if (result.code === 'not_equipped') return EQUIP_PET_FIRST_TEXT;
  if (result.code === 'no_pet') return NO_PETS_TEXT;
  if (result.code === 'wrong_location') return WRONG_LOCATION_TEXT;
  if (result.code === 'shinobi_unavailable' && result.reason === 'recovering') {
    return '♨️ ᴛʜᴀᴛ ꜱʜɪɴᴏʙɪ ɪꜱ ʀᴇᴄᴏᴠᴇʀɪɴɢ ᴄʜᴀᴋʀᴀ. ɪᴛ ɪꜱ ꜰʀᴇᴇ ᴏɴᴄᴇ ᴛʜᴇ ᴘᴏᴏʟ ɪꜱ ꜰᴜʟʟ.';
  }
  if (result.code === 'shinobi_unavailable') {
    const why = String(result.reason || 'unavailable').replace(/_/g, ' ');
    return `🥷 ᴛʜᴀᴛ ꜱʜɪɴᴏʙɪ ɪꜱ ᴜɴᴀᴠᴀɪʟᴀʙʟᴇ (${why}).`;
  }
  return SESSION_CANNOT_START_TEXT;
}

/** Completion text for a settled session (no duplicate XP messages). */
export function completionText(done) {
  return activityCompleteText(done);
}

// ---- HTML variants for the map screens ----

export async function petStoreHtml(userId) {
  const pets = await listPets(userId);
  const owned = new Set(pets.map((p) => p.petId));
  const bal = await db.get(sql`SELECT balance FROM users WHERE telegram_id = ${userId}`);
  const lines = ['🏪 <b>PET STORE</b>', `🍥 Balance: ${fmt(Number(bal?.balance || 0))}`];
  for (const def of Object.values(PETS)) {
    lines.push(`${def.emoji} <b>${def.name}</b> — ${fmt(def.price)} 🍥${owned.has(def.id) ? ' ✓' : ''}`);
    lines.push(`Ability: ${def.abilityName}`);
  }
  lines.push('', safe(STORE_INSTRUCTION));
  return lines.join('<br>');
}

export async function petStoreKeyboard(userId) {
  return {
    inline_keyboard: [
      [
        { text: '🍖 Pet food', callback_data: `map_pet_food:${userId}`, style: 'success' },
        { text: '🕸️ Pet abilities', url: PET_ABILITY_URL, style: 'primary' },
      ],
      [{ text: '⬅️ Back', callback_data: `map_loc_store:${userId}`, style: 'danger' }],
    ],
  };
}

export async function petStatsHtml(userId, pet = null) {
  const target = pet || await getEquippedPet(userId);
  if (!target) return `<b>🐾 PETS</b><br>${safe(EQUIP_ONE_TEXT)}`;
  const stats = await getPetStats(userId);
  const { heading, lines } = statsHeadingAndLines(target, stats.xpEarned);
  const quoted = `<blockquote>${lines.map((line) => `<p>${line}</p>`).join('')}</blockquote>`;
  const ability = [abilityTitle(target), ...abilityStatLines(target)]
    .map((line) => `<p>${line}</p>`).join('');
  return `<p>${heading}</p>${quoted}<hr/>${ability}`;
}

export async function petDetailHtml(userId, petId) {
  const pet = await getPet(userId, petId);
  if (!pet) return `<p><b>🐾 PET</b></p><p>${safe(PET_NOT_FOUND_TEXT)}</p>`;
  return petCardCaption(pet)
    .split('\n')
    .map((line) => (line ? `<p>${safe(line)}</p>` : ''))
    .join('');
}

/** Same rows as the /pet card — every action is handled by the pet router. */
export function petDetailKeyboard(userId, petId, opts = {}) {
  const pet = opts.pet || { petId, equipped: true };
  return petCardKeyboard(userId, pet);
}

export async function shinobiPickerHtml(userId, type = 'play', pet = null) {
  const options = await shinobiOptions(userId);
  const cfg = PET_ACTIVITIES[type] || {};
  const petName = pet?.name || 'ʏᴏᴜʀ ᴘᴇᴛ';
  const lines = [
    `${cfg.emoji || '🎾'} <b>CHOOSE A SHINOBI</b>`,
    `🐾 ${safe(petName)} · ⏱️ ${cfg.durationMinutes} ᴍɪɴᴜᴛᴇꜱ · +${cfg.xp} xᴘ`,
  ];
  lines.push(options.length
    ? 'ʙᴏᴛʜ ᴘᴇᴛ ᴀɴᴅ ꜱʜɪɴᴏʙɪ ʀᴇᴍᴀɪɴ ʙᴜꜱʏ ᴜɴᴛɪʟ ᴛʜᴇ ꜱᴇꜱꜱɪᴏɴ ᴇɴᴅꜱ.'
    : safe(NO_STARTER_TEXT));
  return lines.join('<br>');
}

export async function shinobiPickerKeyboard(userId, type = 'play', pet = null) {
  const options = await shinobiOptions(userId);
  const petId = pet?.petId || '';
  const rows = options.map((option) => [{
    text: `${SHINOBI_EMOJI[option.name] || '🥷'} ${option.name}${option.reason ? ' (busy)' : ''}`,
    // Owner right after the action; pet id omitted for the legacy 4-part shape.
    callback_data: option.reason
      ? `map_pet_noop:${userId}`
      : [`map_pet_start:${userId}:${type}`, petId, option.name].filter(Boolean).join(':'),
  }]);
  rows.push([{
    text: '⬅️ Back',
    callback_data: petId ? `map_pet_detail:${userId}:${petId}` : `map_pet_menu:${userId}`,
    style: 'danger',
  }]);
  return { inline_keyboard: rows };
}

// ---- rendering ----

async function answer(cb, text, alert = false) {
  try {
    await api.answerCallbackQuery({
      callback_query_id: cb.id, ...(text ? { text, show_alert: alert } : {}),
    });
  } catch (_) {}
}

function blocksToClassic(blocks) {
  const lines = [];
  for (const block of blocks) {
    if (block?.type === 'table' && Array.isArray(block.cells)) {
      for (const cells of block.cells) {
        lines.push(cells.map((c) => (typeof c?.text === 'string' ? c.text : String(c?.text ?? c ?? ''))).join(' · '));
      }
    } else if (block?.type === 'paragraph' && block.text != null) {
      lines.push(typeof block.text === 'string' ? block.text : JSON.stringify(block.text));
    } else if (block?.type === 'blockquote' && Array.isArray(block.blocks)) {
      // Classic has no quote mark: keep the quoted lines 1:1, never the raw tag.
      for (const inner of block.blocks) {
        if (inner?.text != null) lines.push(typeof inner.text === 'string' ? inner.text : JSON.stringify(inner.text));
      }
    } else if (block?.type === 'divider') {
      // Classic fallback for `{ type: 'divider' }` — never the raw marker.
      lines.push('──────────');
    }
  }
  // Preserve the authored rows (store = [food | abilities] then [Back]).
  const keyboard = blocks.filter((b) => b?.type === 'buttons')
    .map((b) => (b.buttons || [])
      .filter((button) => button.callback_data || button.url)
      .map((button) => ({
        text: button.text,
        ...(button.callback_data ? { callback_data: button.callback_data } : {}),
        ...(button.url ? { url: button.url } : {}),
      })))
    .filter((row) => row.length);
  return {
    text: lines.join('\n') || '🐾',
    keyboard: keyboard.length ? { inline_keyboard: keyboard } : undefined,
  };
}

async function render(msg, user, blocks) {
  const classic = blocksToClassic(blocks);
  await editRichOr(msg, user, blocks, async () => {
    try {
      await api.editMessageText({
        chat_id: msg.chat.id,
        message_id: msg.message_id,
        text: classic.text,
        parse_mode: 'HTML',
        ...(classic.keyboard ? { reply_markup: classic.keyboard } : {}),
      });
    } catch (_) {
      // A photo/caption message cannot be edited into text; edit the caption.
      try {
        await api.editMessageCaption({
          chat_id: msg.chat.id,
          message_id: msg.message_id,
          caption: classic.text,
          parse_mode: 'HTML',
          ...(classic.keyboard ? { reply_markup: classic.keyboard } : {}),
        });
      } catch (_) { /* message is gone or unchanged */ }
    }
  });
}

export function isPetCallback(data) {
  return String(data || '').startsWith('pet_');
}

/** Owned-pet guard: returns the pet row or null. */
async function ownedPet(userId, petId) {
  if (!petId) return null;
  return getPet(userId, String(petId).toLowerCase());
}

export async function handlePetCallback(cb) {
  const data = String(cb.data || '');
  if (!isPetCallback(data)) return false;
  const parts = data.split(':');
  const action = parts[0];
  const ownerId = Number(parts[1]) || 0;
  const userId = cb.from.id;
  const msg = cb.message;
  if (!msg) { await answer(cb); return true; }
  if (!ownerId) { await answer(cb, STALE_MENU_TEXT, true); return true; }
  if (ownerId !== userId) { await answer(cb, WRONG_OWNER_TEXT, true); return true; }

  try {
    if (action === 'pet_close') {
      await answer(cb);
      try { await api.deleteMessage({ chat_id: msg.chat.id, message_id: msg.message_id }); } catch (_) {}
      return true;
    }
    if (action === 'pet_noop') {
      await answer(cb, 'ᴛʜᴀᴛ ꜱʜɪɴᴏʙɪ ɪꜱ ʙᴜꜱʏ ᴡɪᴛʜ ᴀɴᴏᴛʜᴇʀ ᴀᴄᴛɪᴠɪᴛʏ.', true);
      return true;
    }
    if (action === 'pet_rename') {
      await answer(cb, RENAME_CALLBACK_HINT_TEXT, true);
      return true;
    }
    if (action === 'pet_menu') {
      await answer(cb);
      await render(msg, cb.from, await petListContent(cb.from));
      return true;
    }
    if (action === 'pet_store') {
      await answer(cb);
      await render(msg, cb.from, await petStoreContent(cb.from));
      return true;
    }

    if (action === 'pet_food_menu' && !parts[2]) {
      await answer(cb);
      await render(msg, cb.from, await petFoodContent(cb.from));
      return true;
    }

    // Switch pet: no picker — auto-equip the other owned pet and open its card.
    if (action === 'pet_switch') {
      const pets = await listPets(userId);
      if (!pets.length) { await answer(cb, NO_PETS_TEXT, true); return true; }
      const currentId = String(parts[2] || '').toLowerCase();
      const current = pets.find((p) => p.petId === currentId)
        || pets.find((p) => p.equipped)
        || pets[0];
      const other = pets.find((p) => p.petId !== current.petId);
      if (!other) { await answer(cb, ONE_PET_ONLY_TEXT, true); return true; }
      const r = await equipPet(userId, other.petId);
      if (r.code !== 'ok' && r.code !== 'already_equipped') {
        await answer(cb, notOwnedText(other.name), true);
        return true;
      }
      await answer(cb, petSwitchedText(other.name, other.def.name));
      await renderPetCard(msg, cb.from, await getPet(userId, other.petId));
      return true;
    }

    const petId = parts[2];
    if (['pet_me', 'pet_stats', 'pet_feed_menu', 'pet_play', 'pet_train', 'pet_rest',
      'pet_wake', 'pet_equip', 'pet_food', 'pet_name'].includes(action)) {
      const pet = petId ? await ownedPet(userId, petId) : await getEquippedPet(userId);
      if (!pet) {
        await answer(cb, PET_NOT_FOUND_TEXT, true);
        await render(msg, cb.from, await petListContent(cb.from));
        return true;
      }

      if (action === 'pet_equip') {
        const r = await equipPet(userId, pet.petId);
        if (r.code === 'ok') await answer(cb, equipSuccessText(r.pet.name));
        else if (r.code === 'already_equipped') await answer(cb, equipSuccessText(r.pet.name));
        else await answer(cb, notOwnedText(pet.name), true);
        await renderPetCard(msg, cb.from, await getPet(userId, pet.petId));
        return true;
      }
      if (action === 'pet_me') {
        await answer(cb);
        await renderPetCard(msg, cb.from, pet);
        return true;
      }
      if (action === 'pet_stats') {
        await answer(cb);
        await render(msg, cb.from, await petStatsContent(cb.from, pet));
        return true;
      }
      if (action === 'pet_feed_menu') {
        if (!pet.equipped) { await answer(cb, EQUIP_PET_FIRST_TEXT, true); return true; }
        if (pet.status === PET_STATUS.EXHAUSTED) {
          await answer(cb, restRequiredText(pet.name), true);
          return true;
        }
        if (pet.status !== PET_STATUS.READY) {
          await answer(cb, busyActivityText({ pet }, 'feed'), true);
          return true;
        }
        // Rule: a pet can only be fed while it is hungry (energy not full).
        if (pet.energy >= PET_MAX_ENERGY) {
          await answer(cb, petNotHungryText(pet.name), true);
          return true;
        }
        await answer(cb);
        await render(msg, cb.from, await petFoodContent(cb.from, pet.petId));
        return true;
      }
      if (action === 'pet_food') {
        const foodKey = parts[3];
        const r = await buyPetFood(userId, foodKey, `cb:${cb.id}`, msg.chat.id, pet.petId);
        if (r.code === 'ok') {
          await answer(cb, feedSuccessText(r.petName, r.name, r.energyBefore, r.energyAfter, r.petXp));
        } else if (r.code === 'insufficient') {
          await answer(cb, feedInsufficientText(PET_FOOD_MENU[foodKey]?.name || 'food', fmt(r.cost), fmt(r.balance)), true);
        } else if (r.code === 'full_energy') {
          await answer(cb, petNotHungryText(pet.name), true);
        } else if (r.code === 'busy') {
          await answer(cb, busyActivityText({ pet, activity: r.activity }, 'feed'), true);
        } else if (r.code !== 'duplicate') {
          await answer(cb, SESSION_CANNOT_START_TEXT, true);
        }
        await render(msg, cb.from, await petFoodContent(cb.from, pet.petId));
        return true;
      }
      if (action === 'pet_play') {
        if (!pet.equipped) { await answer(cb, EQUIP_PET_FIRST_TEXT, true); return true; }
        if (pet.status === PET_STATUS.EXHAUSTED) {
          await answer(cb, restRequiredText(pet.name), true);
          return true;
        }
        if (pet.status !== PET_STATUS.READY) {
          await answer(cb, busyActivityText({ pet }, 'play'), true);
          return true;
        }
        await answer(cb);
        await render(msg, cb.from, await playPickerContent(cb.from, pet));
        return true;
      }
      if (action === 'pet_train') {
        const r = await performPetStart(userId, pet.petId, 'train', { chatId: msg.chat.id });
        if (r.code === 'ok') await answer(cb, startResultText(r, 'train'));
        else await answer(cb, startResultText(r, 'train'), true);
        await renderPetCard(msg, cb.from, await getPet(userId, pet.petId));
        return true;
      }
      if (action === 'pet_rest') {
        if (pet.status === PET_STATUS.RESTING) {
          const woke = await cancelPetActivity(userId, pet.petId);
          await answer(cb, woke.code === 'ok' ? PET_WOKE_TEXT : NOT_RESTING_TEXT, woke.code !== 'ok');
          await renderPetCard(msg, cb.from, await getPet(userId, pet.petId));
          return true;
        }
        const r = await performPetStart(userId, pet.petId, 'rest', { chatId: msg.chat.id });
        await answer(cb, startResultText(r, 'rest'), r.code !== 'ok');
        await renderPetCard(msg, cb.from, await getPet(userId, pet.petId));
        return true;
      }
      if (action === 'pet_wake') {
        const r = await cancelPetActivity(userId, pet.petId);
        await answer(cb, r.code === 'ok' ? PET_WOKE_TEXT : NOT_RESTING_TEXT, r.code !== 'ok');
        await renderPetCard(msg, cb.from, await getPet(userId, pet.petId));
        return true;
      }
      if (action === 'pet_name') {
        await answer(cb);
        await render(msg, cb.from, await nametagContent(userId, `pet_me:${userId}:${pet.petId}`));
        return true;
      }
      return true;
    }

    if (action === 'pet_start') {
      const type = parts[3];
      const shinobi = parts.slice(4).join(':');
      const pet = await ownedPet(userId, petId);
      if (!pet) { await answer(cb, PET_NOT_FOUND_TEXT, true); return true; }
      const r = await performPetStart(userId, pet.petId, type, { shinobi, chatId: msg.chat.id });
      if (r.code === 'ok') await answer(cb, startResultText(r, type));
      else await answer(cb, startResultText(r, type), true);
      await renderPetCard(msg, cb.from, await getPet(userId, pet.petId));
      return true;
    }

    if (action === 'pet_nametag_buy') {
      const r = await buyPetNametag(userId, `cb:${cb.id}`);
      if (r.code === 'ok') await answer(cb, nametagBoughtText(), true);
      else if (r.code === 'insufficient') await answer(cb, insufficientCoinsText(fmt(PET_NAMETAG_PRICE), fmt(r.balance)), true);
      else if (r.code !== 'duplicate') await answer(cb, UNEXPECTED_ERROR_TEXT, true);
      await render(msg, cb.from, await nametagContent(userId));
      return true;
    }

    if (action === 'pet_food_menu') {
      await answer(cb);
      await render(msg, cb.from, await petFoodContent(cb.from));
      return true;
    }

    await answer(cb, STALE_MENU_TEXT, true);
    return true;
  } catch (e) {
    if (e instanceof BotApiError && e.code === 400) { await answer(cb); return true; }
    console.error('[pet callback]', e);
    await answer(cb, UNEXPECTED_ERROR_TEXT, true);
    return true;
  }
}

// ---- /pet family commands ----

async function sendBlocks(message, blocks) {
  const classic = blocksToClassic(blocks);
  try {
    return await richOr(message.chat.id, message.from, blocks, () => api.sendMessage({
      chat_id: message.chat.id,
      text: classic.text,
      parse_mode: 'HTML',
      ...(classic.keyboard ? { reply_markup: classic.keyboard } : {}),
    }));
  } catch (e) {
    console.error('[pet command send]', e);
    return null;
  }
}

async function sendText(message, text) {
  try {
    await api.sendMessage({ chat_id: message.chat.id, text });
  } catch (e) { console.error('[pet command text]', e); }
  return true;
}

/** Resolve the pet addressed by `/pet me [name]`. */
async function commandPet(user, rawName) {
  if (rawName) return findOwnedPet(user.id, rawName);
  const equipped = await getEquippedPet(user.id);
  if (equipped) return equipped;
  const pets = await listPets(user.id);
  return pets.length === 1 ? pets[0] : null;
}

export async function handlePetCommand(message) {
  const text = String(message.text || '');
  const head = text.split(/\s+/)[0].toLowerCase().replace(/@\w+$/, '');
  const allowed = ['/pet', '/pet_store', '/pet_rename'];
  if (!allowed.includes(head)) return false;
  const user = message.from;
  if (!user || user.is_bot) return true;
  const parts = text.trim().split(/\s+/);
  try {
    if (head === '/pet_store') {
      await sendBlocks(message, await petStoreContent(user));
      return true;
    }
    if (head === '/pet_rename') {
      let pet = await getEquippedPet(user.id);
      let nameParts = parts.slice(1);
      if (parts.length >= 3) {
        const named = petByIdOrName(parts[1]);
        if (named) {
          const owned = await getPet(user.id, named.id);
          if (!owned) return sendText(message, notOwnedText(named.name));
          pet = owned;
          nameParts = parts.slice(2);
        }
      }
      const newName = nameParts.join(' ').trim();
      if (!pet) return sendText(message, NO_PETS_TEXT);
      if (!newName) return sendText(message, renameUsageText());
      const r = await renamePet(user.id, pet.petId, newName);
      if (r.code === 'ok') return sendText(message, renameSuccessText(pet.def.name, r.name));
      if (r.code === 'no_nametag') return sendText(message, noNametagText());
      if (r.code === 'invalid_name') return sendText(message, invalidPetNameText());
      return sendText(message, UNEXPECTED_ERROR_TEXT);
    }

    const sub = String(parts[1] || '').toLowerCase();
    if (sub === 'store' || sub === 'buy') {
      await sendBlocks(message, await petStoreContent(user));
      return true;
    }
    if (sub === 'name' || sub === 'nametag') {
      await sendBlocks(message, await nametagContent(user.id));
      return true;
    }
    if (sub === 'food') {
      await sendBlocks(message, await petFoodContent(user));
      return true;
    }
    if (sub === 'help') {
      return sendText(message, petCommandsText());
    }

    const pets = await listPets(user.id);
    if (!pets.length) return sendText(message, NO_PETS_TEXT);

    // `/pet` (and `/pet <pet name>`) opens the equipped pet card directly.
    if (!sub) {
      const equipped = pets.find((p) => p.equipped) || (pets.length === 1 ? pets[0] : null);
      if (equipped) {
        await sendPetCard(message.chat.id, user, equipped);
        return true;
      }
      await sendBlocks(message, await petListContent(user));
      return true;
    }
    const namedPet = petByIdOrName(sub);
    if (namedPet) {
      const owned = pets.find((p) => p.petId === namedPet.id);
      if (!owned) return sendText(message, notOwnedText(namedPet.name));
      await sendPetCard(message.chat.id, user, owned);
      return true;
    }

    let pet = null;
    let rest = [];
    if (sub === 'me') {
      rest = parts.slice(2);
      pet = rest.length ? await findOwnedPet(user.id, rest.join(' ')) : await commandPet(user, null);
      if (!pet) {
        if (!rest.length) {
          await sendBlocks(message, await petListContent(user));
          return true;
        }
        return sendText(message, rest.length ? notOwnedText(rest.join(' ')) : PET_NOT_FOUND_TEXT);
      }
    } else if (['feed', 'play', 'train', 'rest', 'stats', 'ability'].includes(sub)) {
      rest = parts.slice(2);
      pet = rest.length ? await findOwnedPet(user.id, rest.join(' ')) : await commandPet(user, null);
      if (!pet) {
        if (!rest.length) {
          await sendBlocks(message, await petListContent(user));
          return true;
        }
        return sendText(message, PET_NOT_FOUND_TEXT);
      }
    }

    if (sub === 'me') {
      await sendPetCard(message.chat.id, user, pet);
      return true;
    }
    if (sub === 'stats') {
      await sendBlocks(message, await petStatsContent(user, pet));
      return true;
    }
    if (sub === 'ability') {
      await sendBlocks(message, [
        P('🕸️ 𝐏𝐄𝐓 ᴀʙɪʟɪᴛɪᴇꜱ'),
        P(`ʏᴏᴜʀ ᴘᴇᴛ'ꜱ ᴀʙɪʟɪᴛʏ: ${pet.def.abilityName} — ${pet.def.abilityDesc}`),
        row(btn('🕸️ Pet abilities', { url: PET_ABILITY_URL, style: 'primary' })),
        row(btn('⬅️ Back', { callback_data: `pet_me:${user.id}:${pet.petId}`, style: 'danger' })),
      ]);
      return true;
    }
    if (sub === 'feed') {
      if (!pet.equipped) return sendText(message, EQUIP_PET_FIRST_TEXT);
      if (pet.status === PET_STATUS.EXHAUSTED) return sendText(message, restRequiredText(pet.name));
      if (pet.status !== PET_STATUS.READY) return sendText(message, busyActivityText({ pet }, 'feed'));
      await sendBlocks(message, await petFoodContent(user, pet.petId));
      return true;
    }
    if (sub === 'play') {
      if (!pet.equipped) return sendText(message, EQUIP_PET_FIRST_TEXT);
      if (pet.status === PET_STATUS.EXHAUSTED) return sendText(message, restRequiredText(pet.name));
      if (pet.status !== PET_STATUS.READY) return sendText(message, busyActivityText({ pet }, 'play'));
      await sendBlocks(message, await playPickerContent(user, pet));
      return true;
    }
    if (sub === 'train') {
      const r = await performPetStart(user.id, pet.petId, 'train', { chatId: message.chat.id });
      return sendText(message, startResultText(r, 'train'));
    }
    if (sub === 'rest') {
      const r = await performPetStart(user.id, pet.petId, 'rest', { chatId: message.chat.id });
      return sendText(message, startResultText(r, 'rest'));
    }

    await sendBlocks(message, await petListContent(user));
    return true;
  } catch (e) {
    console.error('[pet command]', e);
    try {
      await api.sendMessage({ chat_id: message.chat.id, text: UNEXPECTED_ERROR_TEXT });
    } catch (_) {}
    return true;
  }
}
