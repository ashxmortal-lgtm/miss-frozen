// MissFrozen gaming economy (independent of ExFrozen study coins).
import { db } from 'sdk';
import { eq, sql } from 'sdk/db';
import { users } from '../schema.js';
import { sakuraClaimBonus } from './rpg/levels.js';

export const DAILY_COINS = 500;
export const DAILY_CHAKRA = 100;
export const BONUS_COINS = 1000;   // day 7
export const BONUS_CHAKRA = 200;   // day 7
export const SAKURA_COINS = 100;   // Sakura owners
export const SAKURA_CHAKRA = 50;
export const DAILY_XP = 50;

// IST = UTC + 5:30, no daylight saving.
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

export function dayKey(offsetDays = 0) {
  return new Date(Date.now() + IST_OFFSET_MS + offsetDays * 86400000)
    .toISOString().slice(0, 10);
}
export const todayKey = () => dayKey(0);

export async function getBalance(telegramId) {
  const row = await db.select().from(users)
    .where(eq(users.telegramId, telegramId)).get();
  return row ? row.balance : 0;
}

/**
 * Adjust user balance by delta. Never goes below 0.
 * @param {number} telegramId
 * @param {number} delta positive or negative
 * @param {{ allowPartial?: boolean }} [opts] if true and not enough coins on deduct, deduct all remaining
 * @returns {{ before: number, after: number, applied: number }}
 */
export async function adjustBalance(telegramId, delta, opts = {}) {
  await db.run(sql`INSERT OR IGNORE INTO users (telegram_id, balance) VALUES (${telegramId}, 0)`);
  const before = await getBalance(telegramId);
  let applied = delta;
  if (delta < 0) {
    if (before + delta < 0) {
      if (opts.allowPartial) applied = -before;
      else applied = 0;
    }
  }
  if (applied === 0 && delta !== 0) return { before, after: before, applied: 0 };
  await db.run(sql`UPDATE users SET balance = balance + ${applied} WHERE telegram_id = ${telegramId}`);
  const after = await getBalance(telegramId);
  return { before, after, applied };
}


export async function claimDaily(id) {
  const today = dayKey(0);
  const yesterday = dayKey(-1);
  await db.run(sql`INSERT OR IGNORE INTO users (telegram_id, balance) VALUES (${id}, 0)`);

  const row = await db.get(sql`SELECT last_claim_date AS d, claim_streak AS s FROM users WHERE telegram_id = ${id}`);
  const d = row ? row.d : null;
  const s = row ? row.s : 0;
  if (d === today) return { claimed: false, streak: s, balance: await getBalance(id) };

  const streak = d === yesterday ? (s % 7) + 1 : 1;
  const bonus = streak === 7;
  const sak = await db.get(sql`SELECT 1 AS x FROM inventory WHERE telegram_id = ${id} AND item_name = 'Sakura'`);
  let sakura = !!sak;
  // Sakura's Boost scales with her level (from Tsunade training).
  let sakuraCoins = 0;
  let sakuraChakra = 0;
  if (sakura) {
    const lv = await db.get(sql`SELECT level FROM shinobi_state WHERE telegram_id = ${id} AND shinobi = 'Sakura'`);
    const b = sakuraClaimBonus(lv ? lv.level : 1);
    sakuraCoins = b.coins;
    sakuraChakra = b.chakra;
  }
  const coins = DAILY_COINS + (bonus ? BONUS_COINS : 0) + sakuraCoins;
  const chakra = DAILY_CHAKRA + (bonus ? BONUS_CHAKRA : 0) + sakuraChakra;

  // One guarded statement: only the first request of the day pays.
  const res = await db.run(sql`UPDATE users SET balance = balance + ${coins}, xp = xp + ${DAILY_XP}, last_claim_date = ${today}, claim_streak = ${streak} WHERE telegram_id = ${id} AND (last_claim_date IS NULL OR last_claim_date != ${today})`);
  if (res.rowsAffected === 0) {
    return { claimed: false, streak, balance: await getBalance(id) };
  }

  let chakraFailed = false;
  for (let i = 0; i < 2; i++) {
    try {
      await db.run(sql`INSERT INTO inventory (telegram_id, item_type, item_name, qty) VALUES (${id}, 'chakra', 'Chakra', ${chakra}) ON CONFLICT(telegram_id, item_name) DO UPDATE SET qty = qty + ${chakra}`);
      chakraFailed = false;
      break;
    } catch (e) {
      console.error(e);
      chakraFailed = true;
    }
  }
  return { claimed: true, streak, bonus, sakura, sakuraCoins, sakuraChakra, coins, chakra, xp: DAILY_XP, chakraFailed, balance: await getBalance(id) };
}
