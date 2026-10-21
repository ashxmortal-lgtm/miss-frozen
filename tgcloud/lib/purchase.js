import { db } from 'sdk';
import { sql } from 'sdk/db';
import { getBalance } from './economy.js';

export async function purchase(userId, updateId, { type, name, qty, cost }) {
  const unique = type !== 'chakra';

  await db.run(sql`INSERT OR IGNORE INTO users (telegram_id, balance) VALUES (${userId}, 0)`);

  const log = await db.run(sql`INSERT OR IGNORE INTO purchases (update_id, telegram_id, item_name, qty, cost) VALUES (${updateId ?? null}, ${userId}, ${name}, ${qty}, ${cost})`);
  if (updateId != null && log.rowsAffected === 0) return { status: 'duplicate' };
  const logId = log.lastInsertRowid;

  const dropLog = () => db.run(sql`DELETE FROM purchases WHERE id = ${logId}`);
  const dropItem = () => db.run(sql`DELETE FROM inventory WHERE telegram_id = ${userId} AND item_name = ${name}`);

  let granted = false;
  let deductSent = false;
  let deducted = false;
  try {
    if (unique) {
      const g = await db.run(sql`INSERT OR IGNORE INTO inventory (telegram_id, item_type, item_name, qty) VALUES (${userId}, ${type}, ${name}, 1)`);
      if (g.rowsAffected === 0) { await dropLog(); return { status: 'owned' }; }
      granted = true;
    }

    deductSent = true;
    const d = await db.run(sql`UPDATE users SET balance = balance - ${cost} WHERE telegram_id = ${userId} AND balance >= ${cost}`);
    if (d.rowsAffected === 0) {
      if (granted) await dropItem();
      await dropLog();
      return { status: 'insufficient', balance: await getBalance(userId) };
    }
    deducted = true;

    if (type === 'chakra') {
      await db.run(sql`INSERT INTO inventory (telegram_id, item_type, item_name, qty) VALUES (${userId}, ${type}, ${name}, ${qty}) ON CONFLICT(telegram_id, item_name) DO UPDATE SET qty = qty + ${qty}`);
    }
  } catch (e) {
    console.error(e);
    if (deductSent && !deducted) return { status: 'failed', safe: false };
    try {
      if (deducted) await db.run(sql`UPDATE users SET balance = balance + ${cost} WHERE telegram_id = ${userId}`);
      if (granted) await dropItem();
      await dropLog();
      return { status: 'failed', safe: true };
    } catch (e2) {
      console.error(e2);
      return { status: 'failed', safe: false };
    }
  }
  return { status: 'ok', balance: await getBalance(userId) };
}
