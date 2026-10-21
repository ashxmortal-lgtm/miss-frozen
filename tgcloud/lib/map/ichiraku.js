/**
 * Ichiraku: ramen (chakra restore) + field meals (prep for next mission/patrol).
 * Pet food omitted.
 */

import { db } from 'sdk';
import { sql } from 'sdk/db';
import { RAMEN_MENU, FIELD_MEAL_MENU, MAX_CHAKRA } from './constants.js';
import { fmt } from '../store.js';

const now = () => Math.floor(Date.now() / 1000);

async function balanceOf(id) {
  const r = await db.get(sql`SELECT balance FROM users WHERE telegram_id = ${id}`);
  return r ? r.balance : 0;
}

async function chakraQty(id) {
  const r = await db.get(
    sql`SELECT qty FROM inventory WHERE telegram_id = ${id} AND item_name = 'Chakra'`,
  );
  return r ? r.qty : 0;
}

export function ramenKeyboard(userId) {
  const rows = Object.entries(RAMEN_MENU).map(([key, item]) => [
    {
      text: `${item.emoji} ${item.name} — ${fmt(item.cost)} 🍥 (+${item.chakra}⚡)`,
      callback_data: `map_ramen:${key}:${userId}`,
    },
  ]);
  rows.push([{ text: '🔙 ʙᴀᴄᴋ', callback_data: `map_loc_ichiraku:${userId}` }]);
  return { inline_keyboard: rows };
}

export function fieldMealKeyboard(userId) {
  const rows = Object.entries(FIELD_MEAL_MENU).map(([key, item]) => {
    const bits = [];
    if (item.duration_pct) bits.push(`time ${item.duration_pct}%`);
    if (item.reward_pct) bits.push(`reward +${item.reward_pct}%`);
    const extra = bits.length ? ` (${bits.join(', ')})` : '';
    return [
      {
        text: `${item.emoji} ${item.name} — ${fmt(item.cost)} 🍥${extra}`,
        callback_data: `map_field:${key}:${userId}`,
      },
    ];
  });
  rows.push([{ text: '🔙 ʙᴀᴄᴋ', callback_data: `map_loc_ichiraku:${userId}` }]);
  return { inline_keyboard: rows };
}

export function ramenMenuText(mentionHtml) {
  const lines = Object.values(RAMEN_MENU).map(
    (i) => `${i.emoji} <b>${i.name}</b> — ${fmt(i.cost)} 🍥 · +${i.chakra} ⚡`,
  );
  return (
    `🍜 <b>RAMEN MENU</b>\n\n🍃 ${mentionHtml}\n\n` +
    lines.join('\n') +
    `\n\nRestores your chakra (capped at ${MAX_CHAKRA}).`
  );
}

export function fieldMenuText(mentionHtml) {
  const lines = Object.values(FIELD_MEAL_MENU).map((i) => {
    const bits = [];
    if (i.duration_pct) bits.push(`duration ${i.duration_pct}%`);
    if (i.reward_pct) bits.push(`reward +${i.reward_pct}%`);
    return `${i.emoji} <b>${i.name}</b> — ${fmt(i.cost)} 🍥 · ${bits.join(', ')}`;
  });
  return (
    `⚡ <b>FIELD MEALS</b>\n\n🍃 ${mentionHtml}\n\n` +
    lines.join('\n') +
    `\n\nPrepared for your <b>next</b> mission or patrol.`
  );
}

/** Buy ramen → pay coins, add chakra (capped). Never charge if already full. */
export async function buyRamen(telegramId, key) {
  const item = RAMEN_MENU[key];
  if (!item) return { code: 'unknown' };

  await db.run(sql`INSERT OR IGNORE INTO users (telegram_id, balance) VALUES (${telegramId}, 0)`);
  const before = await chakraQty(telegramId);
  const room = Math.max(0, MAX_CHAKRA - before);
  if (room <= 0) {
    return { code: 'full_chakra', chakra: before, max: MAX_CHAKRA };
  }

  const bal = await balanceOf(telegramId);
  if (bal < item.cost) return { code: 'no_coins', have: bal, need: item.cost };

  const paid = await db.run(sql`
    UPDATE users SET balance = balance - ${item.cost}
    WHERE telegram_id = ${telegramId} AND balance >= ${item.cost}
  `);
  if (paid.rowsAffected === 0) return { code: 'no_coins', have: bal, need: item.cost };

  const give = Math.min(item.chakra, room);
  if (give > 0) {
    await db.run(sql`
      INSERT INTO inventory (telegram_id, item_type, item_name, qty)
      VALUES (${telegramId}, 'chakra', 'Chakra', ${give})
      ON CONFLICT(telegram_id, item_name) DO UPDATE SET qty = qty + ${give}
    `);
  }
  const after = await chakraQty(telegramId);
  return {
    code: 'ok',
    cost: item.cost,
    chakraGained: give,
    chakra: after,
    name: item.name,
    emoji: item.emoji,
  };
}

/** Prepare a field meal (one slot per user for "next any" shinobi_id=0). */
export async function prepareFieldMeal(telegramId, key) {
  const item = FIELD_MEAL_MENU[key];
  if (!item) return { code: 'unknown' };

  await db.run(sql`INSERT OR IGNORE INTO users (telegram_id, balance) VALUES (${telegramId}, 0)`);
  const bal = await balanceOf(telegramId);
  if (bal < item.cost) return { code: 'no_coins', have: bal, need: item.cost };

  const paid = await db.run(sql`
    UPDATE users SET balance = balance - ${item.cost}
    WHERE telegram_id = ${telegramId} AND balance >= ${item.cost}
  `);
  if (paid.rowsAffected === 0) return { code: 'no_coins', have: bal, need: item.cost };

  const t = now();
  // shinobi = '*' means next any mission/patrol
  await db.run(sql`
    INSERT INTO field_meals (telegram_id, shinobi, meal_key, prepared_at)
    VALUES (${telegramId}, '*', ${key}, ${t})
    ON CONFLICT(telegram_id, shinobi) DO UPDATE SET
      meal_key = excluded.meal_key,
      prepared_at = excluded.prepared_at
  `);
  return { code: 'ok', cost: item.cost, name: item.name, emoji: item.emoji, item };
}

export async function getPreparedFieldMeal(telegramId) {
  return db.get(sql`
    SELECT meal_key, prepared_at FROM field_meals
    WHERE telegram_id = ${telegramId} AND shinobi = '*'
  `);
}
