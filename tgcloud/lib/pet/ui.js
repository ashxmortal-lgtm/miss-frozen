/**
 * Pet screens, keyboards and callback routing.
 * Mirrors the reference pet.py surface:
 *   /pet, /pet_store, /buy_pet NAME, /equip_pet [NAME], /pet_rename NAME
 *   pet_stats:{uid} · pet_ability:{uid} · pet_switch:{uid} · pet_rename:{uid}
 *   pet_act:{uid}:{type} → pet_start:{uid}:{type}:{shinobi}
 *   map_pet_feed|play|train|rest, map_pet_start:{uid}:{type}:{shinobi},
 *   map_pet_cancel_rest:{petId}:{uid}, map_pet_noop:{uid}
 * Feed/Play/Train always ask for a Shinobi; the Shinobi stays busy until the
 * activity completes. Feed at a group BBQ needs an owned BBQ property.
 */

import { db } from 'sdk';
import { sql } from 'sdk/db';
import { BotApiError } from 'sdk';
import { api } from '../message_api.js';
import { editRichOr, richOr, P, table, row, btn } from '../rich.js';
import { escapeHtml } from '../texts.js';
import { fmt } from '../store.js';
import { chargePetFeed, refundPetFeed } from '../property.js';
import {
  PETS, PET_MAX_LEVEL, PET_XP_CAP, PET_MAX_ENERGY, PET_ACTIVITIES,
  PET_FOOD_MENU, PET_NAMETAG_PRICE, PET_NAMETAG_MAX_LEN, PET_NAMETAG_KEY,
  petXpForNextLevel,
} from './defs.js';
import {
  listPets, getPet, buyPet, equipPet, getEquippedPet, getPetActivity,
  startPetActivity, cancelPetActivity, renamePet, buyPetNametag,
  specialItemQty, buyPetFood, getPetStats, petAbilityLines,
  ownedShinobi, shinobiAvailability,
} from './store.js';

const now = () => Math.floor(Date.now() / 1000);

const SHINOBI_EMOJI = {
  Sasuke: '⚔️', Sakura: '🌸', Naruto: '🍥', Itachi: '👁️',
  Hinata: '👁️', Jiraiya: '🐸', Tsunade: '🐌', 'Starter Shinobi': '🥷',
};

function fmtTime(ts) {
  if (!ts) return '—';
  return new Date(ts * 1000).toLocaleTimeString('en-IN', {
    timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: true,
  }) + ' IST';
}

function timeLeft(ts) {
  const s = Math.max(0, Number(ts || 0) - now());
  if (s <= 0) return 'ready';
  const h = Math.floor(s / 3600);
  const m = Math.ceil((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export function petStatusText(pet, activity) {
  if (activity?.status === 'active') {
    if (activity.activityType === 'rest') return '♨️ Resting';
    return `⏳ ${PET_ACTIVITIES[activity.activityType]?.label || 'Activity'} ${timeLeft(activity.endsAt)}`;
  }
  const cds = pet?.cooldowns || {};
  const parts = [];
  for (const type of ['feed', 'play', 'train']) {
    if ((cds[type] || 0) > now()) parts.push(`${PET_ACTIVITIES[type].emoji} ${timeLeft(cds[type])}`);
  }
  return parts.length ? `⏱️ ${parts.join(' · ')}` : '🟢 Ready';
}

function petCardLines(pet, activity) {
  const next = petXpForNextLevel(pet.level);
  return [
    `${pet.def.emoji} <b>${escapeHtml(pet.name)}</b> — ${pet.def.name}`,
    `Level ${pet.level}/${PET_MAX_LEVEL} · XP ${pet.xp.toLocaleString('en-US')} / ${PET_XP_CAP.toLocaleString('en-US')}`
      + (next ? ` · next ${next.toLocaleString('en-US')}` : ' · MAX'),
    `Energy ${pet.energy}/${PET_MAX_ENERGY} ⚡ · ${petStatusText(pet, activity)}`,
    `${pet.def.abilityName}: ${petAbilityLines(pet).join(' · ')}`,
    pet.equipped ? '⭐ Equipped' : 'Not equipped — only the equipped pet can act',
    activity?.shinobiName ? `🥷 Shinobi: ${escapeHtml(activity.shinobiName)}` : '',
  ].filter(Boolean);
}

async function activePetContent(user) {
  const pets = await listPets(user.id);
  const active = pets.find((p) => p.equipped);
  if (!active) return null;
  const activity = await getPetActivity(user.id, active.petId);
  const stats = await getPetStats(user.id);
  const blocks = [
    P('🐾 𝐏𝐄𝐓 𝐏𝐑𝐎𝐅𝐈𝐋𝐄'),
    ...petCardLines(active, activity).map((line) => P(line)),
    P(`Feed ${stats.feedCount} · Play ${stats.playCount} · Train ${stats.trainCount}`
      + ` · Fortune ${stats.rewardTriggers}`),
  ];
  if (activity?.status === 'active' && activity.activityType !== 'rest') {
    blocks.push(P(`Ready ${fmtTime(activity.endsAt)} · cooldown starts when it completes`));
  }
  blocks.push(row(
    btn('🍖 Feed', { callback_data: `pet_act:${user.id}:feed`, style: 'primary' }),
    btn('🎾 Play', { callback_data: `pet_act:${user.id}:play`, style: 'primary' }),
  ));
  blocks.push(row(
    btn('🏋️ Train', { callback_data: `pet_act:${user.id}:train`, style: 'primary' }),
    btn('♨️ Rest', { callback_data: `pet_act:${user.id}:rest`, style: 'primary' }),
  ));
  if (activity?.status === 'active' && activity.activityType === 'rest') {
    blocks.push(row(btn('☀️ Wake Pet', { callback_data: `pet_stop:${user.id}`, style: 'danger' })));
  }
  blocks.push(row(
    btn('📊 Stats', { callback_data: `pet_stats:${user.id}` }),
    btn('✨ Ability', { callback_data: `pet_ability:${user.id}` }),
  ));
  blocks.push(row(
    btn('🔄 Switch Pet', { callback_data: `pet_switch:${user.id}`, style: 'success' }),
    btn('✏️ Nametag', { callback_data: `pet_rename:${user.id}`, style: 'danger' }),
  ));
  blocks.push(row(btn('🛒 Pet Store', { callback_data: `pet_store:${user.id}`, style: 'success' })));
  return blocks;
}

export async function petContent(user) {
  const blocks = await activePetContent(user);
  if (blocks) return blocks;
  const pets = await listPets(user.id);
  if (!pets.length) {
    return [
      P('🐾 𝐏𝐄𝐓𝐒'),
      P('You do not own a pet yet.'),
      P('🦋 Axofly — 30,000 🍥 · Flutter Fortune (reward + Shinobi XP)'),
      P('🦄 Capycorn — 40,000 🍥 · Royal Pace (shorter missions & patrols)'),
      row(btn('🛒 Pet Store', { callback_data: `pet_store:${user.id}`, style: 'success' })),
    ];
  }
  return [
    P('🐾 𝐏𝐄𝐓𝐒'),
    P('You have pets but none equipped. Equip one to use Feed / Play / Train / Rest.'),
    ...pets.map((pet) => row(btn(`${pet.def.emoji} ${escapeHtml(pet.name)} — Lv. ${pet.level}`, {
      callback_data: `pet_equip:${user.id}:${pet.petId}`, style: 'success',
    }))),
    row(btn('🛒 Pet Store', { callback_data: `pet_store:${user.id}`, style: 'primary' })),
  ];
}

export async function petStoreContent(user) {
  const pets = await listPets(user.id);
  const owned = new Set(pets.map((p) => p.petId));
  const balance = await db.get(sql`SELECT balance FROM users WHERE telegram_id = ${user.id}`);
  const rows = [['Pet', 'Price', 'Ability']];
  for (const def of Object.values(PETS)) {
    rows.push([`${def.emoji} ${def.name}`, `${fmt(def.price)} 🍥`, def.abilityName]);
  }
  const blocks = [
    P('🐾 𝐏𝐄𝐓 𝐒𝐓𝐎𝐑𝐄'),
    P(`🍥 Balance: ${fmt(Number(balance?.balance || 0))}`),
    table(rows),
    P('Buy with /buy_pet &lt;name&gt; · equip with /equip_pet.'),
  ];
  for (const def of Object.values(PETS)) {
    blocks.push(row(btn(
      owned.has(def.id)
        ? `✅ ${def.emoji} ${def.name} — equip`
        : `Buy ${def.emoji} ${def.name} — ${fmt(def.price)} 🍥`,
      {
        callback_data: owned.has(def.id) ? `pet_equip:${user.id}:${def.id}` : `pet_buy:${user.id}:${def.id}`,
        style: owned.has(def.id) ? 'primary' : 'success',
      },
    )));
  }
  blocks.push(row(
    btn('🍱 Pet Food', { callback_data: `pet_food_menu:${user.id}`, style: 'primary' }),
    btn('← Pets', { callback_data: `pet_menu:${user.id}`, style: 'danger' }),
  ));
  return blocks;
}

export async function petSwitchContent(user) {
  const pets = await listPets(user.id);
  const blocks = [P('🔄 𝐒𝐖𝐈𝐓𝐂𝐇 𝐏𝐄𝐓'), P('Choose your active companion.')];
  for (const pet of pets) {
    blocks.push(row(btn(
      `${pet.def.emoji} ${escapeHtml(pet.name)} — Lv. ${pet.level}${pet.equipped ? ' ⭐' : ''}`,
      { callback_data: `pet_equip:${user.id}:${pet.petId}`, style: pet.equipped ? 'success' : 'primary' },
    )));
  }
  if (!pets.length) blocks.push(P('You do not own a pet yet.'));
  blocks.push(row(btn('← Pets', { callback_data: `pet_menu:${user.id}`, style: 'danger' })));
  return blocks;
}

export async function petStatsContent(user) {
  const pet = await getEquippedPet(user.id);
  if (!pet) return petContent(user);
  const activity = await getPetActivity(user.id, pet.petId);
  const stats = await getPetStats(user.id);
  return [
    P('📊 𝐏𝐄𝐓 𝐒𝐓𝐀𝐓𝐒'),
    ...petCardLines(pet, activity).map((line) => P(line)),
    P(`🔄 Feed ${stats.feedCount} · Play ${stats.playCount} · Train ${stats.trainCount}`),
    P(`✨ Fortune triggers ${stats.rewardTriggers} · XP earned ${fmt(stats.xpEarned)}`),
    row(btn('← Pets', { callback_data: `pet_menu:${user.id}`, style: 'danger' })),
  ];
}

export async function petAbilityContent(user) {
  const pet = await getEquippedPet(user.id);
  const blocks = [P('✨ 𝐏𝐄𝐓 𝐀𝐁𝐈𝐋𝐈𝐓𝐘')];
  if (!pet) {
    blocks.push(P('No active pet. Equip one with /equip_pet.'));
  } else {
    blocks.push(P(`${pet.def.emoji} ${escapeHtml(pet.name)} — Lv. ${pet.level}`));
    blocks.push(P(`${pet.def.abilityName}: ${pet.def.abilityDesc}`));
    for (const line of petAbilityLines(pet)) blocks.push(P(line));
    blocks.push(P('Only the equipped pet\'s ability is active.'));
  }
  blocks.push(row(btn('← Pets', { callback_data: `pet_menu:${user.id}`, style: 'danger' })));
  return blocks;
}

async function shinobiOptions(userId) {
  const names = await ownedShinobi(userId);
  const out = [];
  for (const name of names) out.push({ name, reason: await shinobiAvailability(userId, name) });
  return out;
}

export function shinobiOptionsText(options) {
  if (!options.length) return 'No Shinobi owned. Buy one from /shinobi_store first.';
  const lines = options.map((o) => `${SHINOBI_EMOJI[o.name] || '🥷'} ${o.name}${o.reason ? ` — ${o.reason.replace(/_/g, ' ')}` : ' — available'}`);
  return lines.join('\n');
}

export async function shinobiPickerContent(userId, type) {
  const cfg = PET_ACTIVITIES[type] || {};
  const options = await shinobiOptions(userId);
  const blocks = [
    P(`${cfg.emoji || '🐾'} 𝐂𝐇𝐎𝐎𝐒𝐄 𝐀 𝐒𝐇𝐈𝐍𝐎𝐁𝐈`),
    P(`Activity: ${cfg.label || type} · ${cfg.durationMinutes}m · +${cfg.xp} XP · −${cfg.energyCost} energy`),
    P(shinobiOptionsText(options)),
  ];
  for (const option of options) {
    blocks.push(row(btn(
      `${SHINOBI_EMOJI[option.name] || '🥷'} ${option.name}${option.reason ? ' (busy)' : ''}`,
      {
        callback_data: option.reason
          ? `pet_noop:${userId}`
          : `pet_start:${userId}:${type}:${option.name}`,
        style: option.reason ? 'transparent' : 'primary',
      },
    )));
  }
  blocks.push(row(btn('← Pets', { callback_data: `pet_menu:${userId}`, style: 'danger' })));
  return blocks;
}

export async function petFoodContent(user) {
  const pet = await getEquippedPet(user.id);
  const blocks = [
    P('🍱 𝐈𝐂𝐇𝐈𝐑𝐀𝐊𝐔 𝐏𝐄𝐓 𝐅𝐎𝐎𝐃'),
    P('Instant pet XP · no energy · no cooldown.'),
  ];
  if (!pet) blocks.push(P('Equip a pet first (/equip_pet).'));
  const rows = [['Food', 'Cost', 'Pet XP']];
  for (const food of Object.values(PET_FOOD_MENU)) {
    rows.push([`${food.emoji} ${food.name}`, `${fmt(food.cost)} 🍥`, `+${food.petXp}`]);
  }
  blocks.push(table(rows));
  for (const [key, food] of Object.entries(PET_FOOD_MENU)) {
    blocks.push(row(btn(`${food.emoji} ${food.name} — ${fmt(food.cost)} 🍥`, {
      callback_data: `pet_food:${user.id}:${key}`, style: 'success',
    })));
  }
  blocks.push(row(btn('← Pets', { callback_data: `pet_menu:${user.id}`, style: 'danger' })));
  return blocks;
}

export async function petFoodHtml(user) {
  const pet = await getEquippedPet(user.id);
  const lines = ['🍱 <b>ICHIRAKU PET FOOD</b>', 'Instant pet XP · no energy · no cooldown.'];
  for (const food of Object.values(PET_FOOD_MENU)) {
    lines.push(`${food.emoji} ${escapeHtml(food.name)} — ${fmt(food.cost)} 🍥 → +${food.petXp} XP`);
  }
  if (!pet) lines.push('', 'Equip a pet first (/equip_pet).');
  return lines;
}

export function petFoodKeyboard(userId, prefix = 'pet_food') {
  const mapMode = prefix === 'map_pet_food_buy';
  const rows = Object.entries(PET_FOOD_MENU).map(([key, food]) => [{
    text: `${food.emoji} ${food.name} — ${fmt(food.cost)} 🍥`,
    callback_data: mapMode ? `${prefix}:${key}:${userId}` : `${prefix}:${userId}:${key}`,
    style: 'success',
  }]);
  rows.push([{ text: '← Back', callback_data: mapMode ? `map_loc_ichiraku:${userId}` : `pet_menu:${userId}`, style: 'danger' }]);
  return { inline_keyboard: rows };
}

export async function nametagContent(userId) {
  const balance = await db.get(sql`SELECT balance FROM users WHERE telegram_id = ${userId}`);
  const qty = await specialItemQty(userId, PET_NAMETAG_KEY);
  return [
    P('✏️ 𝐏𝐄𝐓 𝐍𝐀𝐌𝐄𝐓𝐀𝐆'),
    P(`Price: ${fmt(PET_NAMETAG_PRICE)} 🍥 · max ${PET_NAMETAG_MAX_LEN} characters`),
    P(`Your nametags: ${qty} · Balance: ${fmt(Number(balance?.balance || 0))} 🍥`),
    P('Rename with /pet_rename NewName (uses the equipped pet).'),
    row(
      btn(`🛒 Buy Nametag — ${fmt(PET_NAMETAG_PRICE)} 🍥`, {
        callback_data: `pet_nametag_buy:${userId}`, style: 'success',
      }),
      btn('← Pets', { callback_data: `pet_menu:${userId}`, style: 'danger' }),
    ),
  ];
}

// ---- start / cancel ----

/**
 * Optional BBQ fee (group map only) → start the activity for the equipped pet.
 * A failed start refunds the fee and reverses the property earnings split.
 */
export async function performPetStart(
  userId, type, shinobi, chatId = 0, locationKey = null, chargeFee = false,
) {
  const cfg = PET_ACTIVITIES[type];
  if (!cfg) return { code: 'invalid_activity' };
  const pet = await getEquippedPet(userId);
  if (!pet) return { code: 'no_pet' };
  let fee = 0;
  if (chargeFee && cfg.key === 'feed' && Number(chatId) < 0) {
    const charge = await chargePetFeed(chatId, userId, `feed:${userId}:${Date.now()}`);
    if (charge.code === 'no_property') return { code: 'no_property', fee: charge.fee };
    if (charge.code === 'insufficient') return { code: 'insufficient_fee', fee: charge.fee };
    if (charge.code !== 'ok' && charge.code !== 'duplicate') {
      return { code: 'fee_failed', fee: charge.fee };
    }
    if (charge.code === 'ok') fee = charge.fee;
  }
  const result = await startPetActivity(userId, pet.petId, cfg.key, {
    chatId, shinobi, locationKey,
  });
  if (result.code !== 'ok') {
    if (fee > 0) await refundPetFeed(chatId, userId, fee);
    return { ...result, fee: 0, pet };
  }
  return { ...result, fee, pet };
}

export function startResultText(result, type) {
  const cfg = PET_ACTIVITIES[type] || {};
  if (result.code === 'ok') {
    const lines = [`${cfg.emoji || '🐾'} ${cfg.label || type} started for ${result.pet?.name || 'your pet'}.`];
    if (type === 'rest') {
      lines.push('Energy restores +15 per hour until you wake it up.');
      lines.push('Use /pet → ☀️ Wake Pet to stop.');
    } else {
      lines.push(`+${cfg.xp} XP on completion · ready ${fmtTime(result.until)}.`);
      lines.push(`Cooldown ${cfg.cooldownHours}h starts when it completes.`);
      lines.push(`Shinobi: ${result.shinobi} (busy until then).`);
    }
    if (result.fee) lines.push(`BBQ feed fee: −${fmt(result.fee)} 🍥 → property owners`);
    return lines.join('\n');
  }
  if (result.code === 'no_pet') return 'Equip a pet first (/equip_pet).';
  if (result.code === 'not_equipped') return 'Only the equipped pet can take an activity. Use /equip_pet.';
  if (result.code === 'busy') return `Your pet is already busy${result.activity ? ` (${result.activity})` : ''}.`;
  if (result.code === 'cooldown') return `On cooldown. Try again in ${timeLeft(result.until)}.`;
  if (result.code === 'no_energy') return `Not enough energy (${result.energy}/${PET_MAX_ENERGY}). Rest at Hot Springs.`;
  if (result.code === 'no_shinobi') return 'Choose a Shinobi for this activity.';
  if (result.code === 'shinobi_busy') return 'That Shinobi is already busy. Pick another.';
  if (result.code === 'shinobi_unavailable') {
    const why = String(result.reason || 'unavailable').replace(/_/g, ' ');
    return `That Shinobi is unavailable (${why}).`;
  }
  if (result.code === 'wrong_location') return 'Wrong location for that activity.';
  if (result.code === 'no_property') return `Nobody owns the BBQ in this group yet. Feeding needs the BBQ property — the ${fmt(result.fee)} 🍥 fee goes to its owners.`;
  if (result.code === 'insufficient_fee') return `Not enough coins for the ${fmt(result.fee)} 🍥 BBQ feed fee.`;
  if (result.code === 'fee_failed') return 'Could not process the feed payment.';
  return `Could not start (${result.code}).`;
}

// ---- map body helpers ----

export async function petMenuHtml(userId) {
  const pet = await getEquippedPet(userId);
  if (!pet) {
    const pets = await listPets(userId);
    return pets.length
      ? '<b>🐾 PETS</b><br>You have pets but none equipped.<br>Use /equip_pet to choose one.'
      : '<b>🐾 PETS</b><br>You do not own a pet yet.<br>Buy one in the Pet Store.';
  }
  const activity = await getPetActivity(userId, pet.petId);
  return `<b>🐾 PET</b><br>${petCardLines(pet, activity).join('<br>')}`;
}

export function petMenuKeyboard(userId) {
  return {
    inline_keyboard: [
      [
        { text: '🍖 Feed', callback_data: `map_pet_feed:${userId}`, style: 'primary' },
        { text: '🎾 Play', callback_data: `map_pet_play:${userId}`, style: 'primary' },
      ],
      [
        { text: '🏋️ Train', callback_data: `map_pet_train:${userId}`, style: 'primary' },
        { text: '♨️ Rest', callback_data: `map_pet_rest:${userId}`, style: 'primary' },
      ],
      [{ text: '🛒 Pet Store', callback_data: `map_pet_store:${userId}`, style: 'success' }],
      [{ text: '← Back', callback_data: `map_loc_store:${userId}`, style: 'danger' }],
    ],
  };
}

export async function petStoreHtml(userId) {
  const pets = await listPets(userId);
  const owned = new Set(pets.map((p) => p.petId));
  const bal = await db.get(sql`SELECT balance FROM users WHERE telegram_id = ${userId}`);
  const lines = ['🏪 <b>PET STORE</b>', `🍥 Balance: ${fmt(Number(bal?.balance || 0))}`];
  for (const def of Object.values(PETS)) {
    lines.push(`${def.emoji} <b>${def.name}</b> — ${fmt(def.price)} 🍥${owned.has(def.id) ? ' ✓' : ''}`);
    lines.push(`Ability: ${def.abilityName}`);
  }
  lines.push('', 'Buy with /buy_pet &lt;name&gt; · equip with /equip_pet.');
  return lines.join('<br>');
}

export async function petStoreKeyboard(userId) {
  const pets = await listPets(userId);
  const owned = new Set(pets.map((p) => p.petId));
  const rows = [];
  for (const def of Object.values(PETS)) {
    rows.push([{
      text: owned.has(def.id)
        ? `${def.emoji} ${def.name} — equip`
        : `Buy ${def.emoji} ${def.name} — ${fmt(def.price)} 🍥`,
      callback_data: owned.has(def.id) ? `map_pet_equip:${def.id}:${userId}` : `map_pet_buy:${def.id}:${userId}`,
      style: owned.has(def.id) ? 'primary' : 'success',
    }]);
  }
  rows.push([{ text: '🍱 Pet Food', callback_data: `map_pet_food:${userId}`, style: 'primary' }]);
  rows.push([{ text: '← Back', callback_data: `map_loc_store:${userId}`, style: 'danger' }]);
  return { inline_keyboard: rows };
}

export async function petStatsHtml(userId) {
  const pet = await getEquippedPet(userId);
  if (!pet) return petMenuHtml(userId);
  const activity = await getPetActivity(userId, pet.petId);
  const stats = await getPetStats(userId);
  return [
    '<b>📊 PET STATS</b>',
    ...petCardLines(pet, activity),
    `Feed ${stats.feedCount} · Play ${stats.playCount} · Train ${stats.trainCount}`,
    `Fortune triggers ${stats.rewardTriggers}`,
  ].join('<br>');
}

export async function petDetailHtml(userId, petId) {
  const pet = await getPet(userId, petId);
  if (!pet) return '<b>🐾 PET</b><br>Pet not found.';
  const activity = await getPetActivity(userId, pet.petId);
  return [
    '<b>🐾 PET DETAIL</b>',
    ...petCardLines(pet, activity),
    pet.equipped ? '' : 'Equip this pet with /equip_pet to use its activity buttons.',
  ].filter(Boolean).join('<br>');
}

export function petDetailKeyboard(userId, petId, opts = {}) {
  const rows = [];
  if (!opts.onlyEquipped) {
    rows.push([
      { text: '🍖 Feed', callback_data: `map_pet_feed:${userId}`, style: 'primary' },
      { text: '🎾 Play', callback_data: `map_pet_play:${userId}`, style: 'primary' },
    ]);
    rows.push([
      { text: '🏋️ Train', callback_data: `map_pet_train:${userId}`, style: 'primary' },
      { text: '♨️ Rest', callback_data: `map_pet_rest:${userId}`, style: 'primary' },
    ]);
  }
  if (opts.resting) rows.push([{ text: '☀️ Wake Pet', callback_data: `map_pet_cancel_rest:${petId}:${userId}`, style: 'danger' }]);
  rows.push([{ text: '← Pets', callback_data: `map_pet_menu:${userId}`, style: 'danger' }]);
  return { inline_keyboard: rows };
}

export async function shinobiPickerHtml(userId, type) {
  const options = await shinobiOptions(userId);
  const cfg = PET_ACTIVITIES[type] || {};
  const lines = [
    `${cfg.emoji || '🐾'} <b>CHOOSE A SHINOBI</b>`,
    `Activity: ${cfg.label || type} · ${cfg.durationMinutes}m · +${cfg.xp} XP · −${cfg.energyCost} energy`,
  ];
  if (cfg.energyCost) lines.push(`Activity cost: ${cfg.energyCost} energy · cooldown ${cfg.cooldownHours}h after completion`);
  lines.push(options.length
    ? 'The chosen Shinobi stays busy until the activity completes.'
    : 'No Shinobi owned. Buy one from the Shinobi Store first.');
  return lines.join('<br>');
}

export async function shinobiPickerKeyboard(userId, type) {
  const options = await shinobiOptions(userId);
  const rows = options.map((option) => [{
    text: `${SHINOBI_EMOJI[option.name] || '🥷'} ${option.name}${option.reason ? ' (busy)' : ''}`,
    callback_data: option.reason
      ? `map_pet_noop:${userId}`
      : `map_pet_start:${userId}:${type}:${option.name}`,
  }]);
  rows.push([{ text: '← Back', callback_data: `map_loc_${type === 'train' ? 'training' : 'bbq'}:${userId}`, style: 'danger' }]);
  return { inline_keyboard: rows };
}

// ---- callback router ----

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
    } else if (block?.type === 'paragraph' && block.text) {
      lines.push(typeof block.text === 'string' ? block.text : JSON.stringify(block.text));
    }
  }
  const buttons = blocks.filter((b) => b?.type === 'buttons')
    .flatMap((b) => b.buttons || [])
    .filter((b) => b.callback_data)
    .map((b) => ({ text: b.text, callback_data: b.callback_data }));
  return { text: lines.join('\n') || '🐾', keyboard: buttons.length ? { inline_keyboard: [buttons] } : undefined };
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
    } catch (_) { /* best-effort classic fallback */ }
  });
}

/**
 * Source callbacks put the owner at parts[1] (`pet_equip:UID:PID`,
 * `pet_start:UID:TYPE:SID`, `pet_act:UID:TYPE`, …). `map_pet_*` callbacks are
 * handled by the map router.
 */
export function isPetCallback(data) {
  return String(data || '').startsWith('pet_');
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
  if (ownerId && ownerId !== userId) {
    await answer(cb, "This menu isn't yours.", true);
    return true;
  }
  try {
    if (action === 'pet_noop') {
      await answer(cb, 'That Shinobi is busy with another activity.', true);
      return true;
    }
    if (action === 'pet_rename') {
      await answer(cb, 'Buy a Pet Nametag, then send /pet_rename NewName.', true);
      return true;
    }
    if (action === 'pet_stop') {
      const pet = await getEquippedPet(userId);
      const r = pet ? await cancelPetActivity(userId, pet.petId) : { code: 'no_pet' };
      await answer(cb, r.code === 'ok' ? 'Your pet woke up.' : 'Your pet is not resting.', r.code !== 'ok');
      await render(msg, cb.from, await petContent(cb.from));
      return true;
    }
    if (action === 'pet_equip' && parts[2]) {
      const r = await equipPet(userId, parts[2]);
      if (r.code === 'ok') await answer(cb, `${r.pet.name} is now your active companion. ⭐`);
      else if (r.code === 'already_equipped') await answer(cb, `${r.pet.name} is already equipped.`);
      else await answer(cb, "You don't own that pet.", true);
      await render(msg, cb.from, await petContent(cb.from));
      return true;
    }
    if (action === 'pet_switch') {
      await answer(cb);
      await render(msg, cb.from, await petSwitchContent(cb.from));
      return true;
    }
    if (action === 'pet_ability') {
      await answer(cb);
      await render(msg, cb.from, await petAbilityContent(cb.from));
      return true;
    }
    if (action === 'pet_stats' || action === 'pet_menu') {
      await answer(cb);
      await render(msg, cb.from, await petStatsContent(cb.from));
      return true;
    }
    if (action === 'pet_store') {
      await answer(cb);
      await render(msg, cb.from, await petStoreContent(cb.from));
      return true;
    }
    if (action === 'pet_buy' && parts[2]) {
      const r = await buyPet(userId, parts[2], `cb:${cb.id}`);
      if (r.code === 'ok') await answer(cb, `${r.pet.def.emoji} ${r.pet.name} adopted! Use /equip_pet.`, true);
      else if (r.code === 'already_owned') await answer(cb, 'You already own this pet — no coins charged.', true);
      else if (r.code === 'insufficient') await answer(cb, `Not enough coins: need ${fmt(r.price)} 🍥, have ${fmt(r.balance)} 🍥.`, true);
      else if (r.code !== 'duplicate') await answer(cb, 'Purchase failed — no coins were charged.', true);
      await render(msg, cb.from, await petStoreContent(cb.from));
      return true;
    }
    if (action === 'pet_act' && parts[2]) {
      const type = parts[2];
      await answer(cb);
      if (type === 'rest') {
        const pet = await getEquippedPet(userId);
        const activity = pet ? await getPetActivity(userId, pet.petId) : null;
        if (activity?.status === 'active' && activity.activityType === 'rest') {
          await cancelPetActivity(userId, pet.petId);
          if (pet) await answer(cb, 'Your pet woke up.');
          await render(msg, cb.from, await petContent(cb.from));
          return true;
        }
        const r = await performPetStart(userId, 'rest', null, msg.chat.id);
        await render(msg, cb.from, await petContent(cb.from));
        if (r.code !== 'ok') {
          try { await api.sendMessage({ chat_id: msg.chat.id, text: startResultText(r, 'rest') }); } catch (_) {}
        }
        return true;
      }
      await render(msg, cb.from, await shinobiPickerContent(userId, type));
      return true;
    }
    if (action === 'pet_start' && parts[2]) {
      const type = parts[2];
      const shinobi = parts.slice(3).join(':');
      const r = await performPetStart(cb.from.id, type, shinobi, msg.chat.id);
      if (r.code === 'ok') await answer(cb, `${PET_ACTIVITIES[type]?.label || type} started.`);
      else await answer(cb, startResultText(r, type), true);
      await render(msg, cb.from, await petContent(cb.from));
      return true;
    }
    if (action === 'pet_food_menu') {
      await answer(cb);
      await render(msg, cb.from, await petFoodContent(cb.from));
      return true;
    }
    if (action === 'pet_food' && parts[2]) {
      const r = await buyPetFood(userId, parts[2], `cb:${cb.id}`, msg.chat.id);
      if (r.code === 'ok') {
        await answer(cb, `${r.emoji} ${r.name}: +${r.petXp} pet XP${r.levelUp ? ` · Lv. ${r.level}!` : ''}`, true);
      } else if (r.code === 'no_pet') await answer(cb, 'Equip a pet first (/equip_pet).', true);
      else if (r.code === 'insufficient') await answer(cb, `Not enough coins: need ${fmt(r.cost)} 🍥, have ${fmt(r.balance)} 🍥.`, true);
      else if (r.code !== 'duplicate') await answer(cb, 'Purchase failed — no coins charged.', true);
      await render(msg, cb.from, await petFoodContent(cb.from));
      return true;
    }
    if (action === 'pet_nametag_buy') {
      const r = await buyPetNametag(userId, `cb:${cb.id}`);
      if (r.code === 'ok') await answer(cb, 'Nametag purchased. /pet_rename NewName to use it.', true);
      else await answer(cb, `Not enough coins for a Nametag (${fmt(PET_NAMETAG_PRICE)} 🍥).`, true);
      await render(msg, cb.from, await nametagContent(userId));
      return true;
    }
    await answer(cb);
    return true;
  } catch (e) {
    if (e instanceof BotApiError && e.code === 400) { await answer(cb); return true; }
    console.error('[pet callback]', e);
    await answer(cb, 'Something went wrong. Try again.', true);
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

function petByName(raw) {
  const want = String(raw || '').trim().toLowerCase();
  if (!want) return null;
  return Object.values(PETS).find((p) => p.id === want || p.name.toLowerCase() === want) || null;
}

function usageText() {
  return [
    '🐾 𝐏𝐄𝐓 𝐂𝐎𝐌𝐌𝐀𝐍𝐃𝐒',
    '/pet — pet profile & activities',
    '/pet_store — adopt Axofly or Capycorn',
    '/buy_pet <name> — buy a pet',
    '/equip_pet <name> — set the active pet',
    '/pet_rename <name> — rename the equipped pet (needs Nametag)',
  ].join('\n');
}

export async function handlePetCommand(message) {
  const text = String(message.text || '');
  const head = text.split(/\s+/)[0].toLowerCase().replace(/@\w+$/, '');
  const allowed = ['/pet', '/pet_store', '/buy_pet', '/equip_pet', '/pet_rename'];
  if (!allowed.includes(head)) return false;
  const user = message.from;
  if (!user || user.is_bot) return true;
  const parts = text.trim().split(/\s+/);
  try {
    if (head === '/pet_store') {
      await sendBlocks(message, await petStoreContent(user));
      return true;
    }
    if (head === '/buy_pet') {
      const def = petByName(parts[1]);
      if (!def) return sendText(message, `Usage: /buy_pet Axofly · /buy_pet Capycorn\nOr open /pet_store.`);
      const r = await buyPet(user.id, def.id, `cmd:${message.message_id || 0}`);
      if (r.code === 'ok') return sendText(message, `${def.emoji} ${def.name} adopted for ${fmt(def.price)} 🍥!\nUse /equip_pet ${def.name} to make it active.`);
      if (r.code === 'already_owned') return sendText(message, 'You already own that pet — no coins charged.');
      if (r.code === 'insufficient') return sendText(message, `Not enough coins: need ${fmt(r.price)} 🍥, have ${fmt(r.balance)} 🍥.`);
      return sendText(message, 'Could not buy that pet. Nothing was charged.');
    }
    if (head === '/equip_pet') {
      if (!parts[1]) {
        await sendBlocks(message, await petSwitchContent(user));
        return true;
      }
      const def = petByName(parts[1]);
      if (!def) return sendText(message, "You don't own that pet.");
      const r = await equipPet(user.id, def.id);
      if (r.code === 'ok' || r.code === 'already_equipped') {
        return sendText(message, `${def.emoji} ${def.name} is now your active companion.`);
      }
      return sendText(message, "You don't own that pet.");
    }
    if (head === '/pet_rename') {
      // Source form: /pet_rename PetName NewName (also accepts just NewName
      // for the equipped pet).
      let pet = await getEquippedPet(user.id);
      let nameParts = parts.slice(1);
      if (parts.length >= 3) {
        const named = petByName(parts[1]);
        if (named) {
          const owned = await getPet(user.id, named.id);
          if (!owned) return sendText(message, "You don't own that pet.");
          pet = owned;
          nameParts = parts.slice(2);
        }
      }
      const newName = nameParts.join(' ').trim();
      if (!pet) return sendText(message, 'Equip a pet first (/equip_pet).');
      if (!newName) return sendText(message, `Usage: /pet_rename PetName NewName\nRequires a Pet Nametag (${fmt(PET_NAMETAG_PRICE)} 🍥) from /pet → Nametag.`);
      const r = await renamePet(user.id, pet.petId, newName);
      if (r.code === 'ok') return sendText(message, `✏️ ${pet.def.emoji} ${pet.def.name} is now “${r.name}”.`);
      if (r.code === 'no_nametag') {
        return sendText(message, `You don't own a Pet Nametag. Buy one from /pet → Nametag (${fmt(PET_NAMETAG_PRICE)} 🍥).`);
      }
      if (r.code === 'invalid_name') return sendText(message, `Invalid name (1–${PET_NAMETAG_MAX_LEN} characters).`);
      return sendText(message, 'Could not rename that pet.');
    }
    // /pet
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
    if (sub === 'ability') {
      await sendBlocks(message, await petAbilityContent(user));
      return true;
    }
    if (sub === 'stats') {
      await sendBlocks(message, await petStatsContent(user));
      return true;
    }
    if (sub === 'help') {
      return sendText(message, usageText());
    }
    if (sub === 'rest') {
      const r = await performPetStart(user.id, 'rest', null, message.chat.id);
      return sendText(message, startResultText(r, 'rest'));
    }
    if (sub === 'feed' || sub === 'play' || sub === 'train') {
      if (parts[2]) {
        const r = await performPetStart(user.id, sub, parts[2], message.chat.id);
        return sendText(message, startResultText(r, sub));
      }
      await sendBlocks(message, await shinobiPickerContent(user.id, sub));
      return true;
    }
    await sendBlocks(message, await petContent(user));
    return true;
  } catch (e) {
    console.error('[pet command]', e);
    try {
      await api.sendMessage({ chat_id: message.chat.id, text: 'Pet command failed. Try again.' });
    } catch (_) {}
    return true;
  }
}
