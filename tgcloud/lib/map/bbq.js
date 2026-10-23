/**
 * BBQ chakra recovery — catch-up on open / sweep (no background loop).
 */

import { db } from 'sdk';
import { sql } from 'sdk/db';
import {
  BBQ_RECOVERY_INTERVAL_SEC,
  BBQ_RECOVERY_AMOUNT,
  MAX_CHAKRA,
  BBQ_HEAL_COST,
} from './constants.js';
import { clearExhaustion } from '../rpg/state.js';

const now = () => Math.floor(Date.now() / 1000);

let schemaPromise = null;

/**
 * Rest sessions live in `bbq_sessions` for both the BBQ and the Hot Springs;
 * the additive `location` column separates them. Runtime safety net only —
 * `tgcloud migrate` remains the canonical migration.
 */
export function ensureRestSchema() {
  if (schemaPromise) return schemaPromise;
  schemaPromise = (async () => {
    try {
      await db.run(sql.raw(`CREATE TABLE IF NOT EXISTS bbq_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_id INTEGER NOT NULL,
        shinobi TEXT NOT NULL,
        bbq_start INTEGER NOT NULL DEFAULT 0,
        last_recovery_at INTEGER NOT NULL DEFAULT 0,
        location TEXT NOT NULL DEFAULT 'bbq'
      )`));
    } catch (e) { console.error('[rest schema]', e?.message || e); }
    try {
      await db.run(sql.raw("ALTER TABLE bbq_sessions ADD COLUMN location TEXT NOT NULL DEFAULT 'bbq'"));
    } catch (_) { /* column already exists */ }
    try {
      await db.run(sql.raw(`CREATE UNIQUE INDEX IF NOT EXISTS uidx_bbq_sessions_owner_shinobi
        ON bbq_sessions (telegram_id, shinobi)`));
    } catch (e) { console.error('[rest schema index]', e?.message || e); }
  })();
  return schemaPromise;
}

async function chakraQty(id) {
  const r = await db.get(
    sql`SELECT qty FROM inventory WHERE telegram_id = ${id} AND item_name = 'Chakra'`,
  );
  return r ? r.qty : 0;
}

async function addChakra(id, amount) {
  if (amount <= 0) return;
  await db.run(sql`
    INSERT INTO inventory (telegram_id, item_type, item_name, qty)
    VALUES (${id}, 'chakra', 'Chakra', ${amount})
    ON CONFLICT(telegram_id, item_name) DO UPDATE SET qty = qty + ${amount}
  `);
  // Cap at MAX_CHAKRA
  const q = await chakraQty(id);
  if (q > MAX_CHAKRA) {
    await db.run(sql`
      UPDATE inventory SET qty = ${MAX_CHAKRA}
      WHERE telegram_id = ${id} AND item_name = 'Chakra'
    `);
  }
}

/** Rest sessions, optionally filtered by location ('bbq' | 'hotsprings'). */
export async function listBbqSessions(telegramId, location = null) {
  await ensureRestSchema();
  if (location) {
    return db.all(sql`
      SELECT shinobi, bbq_start, last_recovery_at, location
      FROM bbq_sessions WHERE telegram_id = ${telegramId} AND location = ${location}
    `);
  }
  return db.all(sql`
    SELECT shinobi, bbq_start, last_recovery_at, location
    FROM bbq_sessions WHERE telegram_id = ${telegramId}
  `);
}

/** Shinobi names currently recovering at any rest location. */
export async function restingShinobi(telegramId) {
  const rows = await listBbqSessions(telegramId);
  return new Set((rows || []).map((r) => r.shinobi));
}

export async function isAtBbq(telegramId, shinobi) {
  await ensureRestSchema();
  const r = await db.get(sql`
    SELECT 1 FROM bbq_sessions
    WHERE telegram_id = ${telegramId} AND shinobi = ${shinobi}
  `);
  return !!r;
}

export async function startBbq(telegramId, shinobi, location = 'bbq') {
  await ensureRestSchema();
  const t = now();
  // Block if on mission/patrol or playing with a pet.
  const act = await db.get(sql`
    SELECT status FROM activities
    WHERE telegram_id = ${telegramId} AND shinobi = ${shinobi}
  `);
  if (act && act.status === 'active') return { code: 'busy' };
  // A full chakra pool means nothing left to recover — stay free.
  if ((await chakraQty(telegramId)) >= MAX_CHAKRA) return { code: 'full' };

  await db.run(sql`
    INSERT INTO bbq_sessions (telegram_id, shinobi, bbq_start, last_recovery_at, location)
    VALUES (${telegramId}, ${shinobi}, ${t}, ${t}, ${location})
    ON CONFLICT(telegram_id, shinobi) DO UPDATE SET
      bbq_start = excluded.bbq_start,
      last_recovery_at = excluded.last_recovery_at,
      location = excluded.location
  `);
  return { code: 'ok' };
}

export async function stopBbq(telegramId, shinobi) {
  await ensureRestSchema();
  await db.run(sql`
    DELETE FROM bbq_sessions
    WHERE telegram_id = ${telegramId} AND shinobi = ${shinobi}
  `);
  return { code: 'ok' };
}

/**
 * Apply offline catch-up recovery for one user (or all if telegramId omitted).
 * Returns total chakra granted this call.
 */
export async function applyBbqRecovery(telegramId = null) {
  await ensureRestSchema();
  const t = now();
  const rows = telegramId
    ? await db.all(sql`
        SELECT telegram_id, shinobi, last_recovery_at, location
        FROM bbq_sessions WHERE telegram_id = ${telegramId}
      `)
    : await db.all(sql`
        SELECT telegram_id, shinobi, last_recovery_at, location FROM bbq_sessions LIMIT 50
      `);

  let granted = 0;
  for (const row of rows) {
    const before = await chakraQty(row.telegram_id);
    // Chakra is full: everyone has recovered — free them automatically.
    if (before >= MAX_CHAKRA) {
      await db.run(sql`DELETE FROM bbq_sessions WHERE telegram_id = ${row.telegram_id}`);
      continue;
    }
    const last = row.last_recovery_at || t;
    const ticks = Math.floor((t - last) / BBQ_RECOVERY_INTERVAL_SEC);
    if (ticks <= 0) continue;
    const amount = ticks * BBQ_RECOVERY_AMOUNT;
    const room = Math.max(0, MAX_CHAKRA - before);
    const give = Math.min(amount, room);
    if (give > 0) {
      await addChakra(row.telegram_id, give);
      granted += give;
    }
    if (before + give >= MAX_CHAKRA) {
      // Recovery complete — the shinobi is free again.
      await db.run(sql`DELETE FROM bbq_sessions WHERE telegram_id = ${row.telegram_id}`);
      continue;
    }
    const advanced = last + ticks * BBQ_RECOVERY_INTERVAL_SEC;
    await db.run(sql`
      UPDATE bbq_sessions SET last_recovery_at = ${advanced}
      WHERE telegram_id = ${row.telegram_id} AND shinobi = ${row.shinobi}
    `);
  }
  return granted;
}

// ---- Instant exhaustion recovery (200 🍥 per shinobi who needs it) ----

/** Shinobi currently exhausted (persisted timestamps). */
export async function listExhausted(telegramId) {
  const t = now();
  const rows = await db.all(sql`
    SELECT shinobi, exhausted_until FROM shinobi_state
    WHERE telegram_id = ${telegramId} AND exhausted_until > ${t}
  `);
  return rows || [];
}

/**
 * Instantly recover the selected exhausted shinobi at BBQ_HEAL_COST each.
 * Server-side enforcement: only shinobi who are ACTUALLY exhausted right now
 * are charged and cleared; ready shinobi are skipped without charge.
 */
export async function healExhaustedAtBbq(telegramId, selected) {
  const t = now();
  const names = [...new Set(selected || [])];
  if (!names.length) return { code: 'none', healed: [], cost: 0 };

  // Re-check server-side: who still needs recovery at this moment?
  const need = [];
  for (const name of names) {
    const r = await db.get(sql`
      SELECT shinobi FROM shinobi_state
      WHERE telegram_id = ${telegramId} AND shinobi = ${name} AND exhausted_until > ${t}
    `);
    if (r) need.push(name);
  }
  if (!need.length) return { code: 'none', healed: [], cost: 0 };

  const cost = BBQ_HEAL_COST * need.length;
  await db.run(sql`INSERT OR IGNORE INTO users (telegram_id, balance) VALUES (${telegramId}, 0)`);
  const charged = await db.run(sql`
    UPDATE users SET balance = balance - ${cost}
    WHERE telegram_id = ${telegramId} AND balance >= ${cost}
  `);
  if (charged.rowsAffected === 0) {
    const u = await db.get(sql`SELECT balance FROM users WHERE telegram_id = ${telegramId}`);
    return { code: 'no_coins', cost, have: u ? u.balance : 0, need };
  }

  const healed = [];
  for (const name of need) {
    // Conditional clear: if the state changed mid-loop the charge is refunded.
    const r = await db.run(sql`
      UPDATE shinobi_state SET exhausted_until = 0, patrol_streak = 0
      WHERE telegram_id = ${telegramId} AND shinobi = ${name} AND exhausted_until > ${t}
    `);
    if (r.rowsAffected === 0) {
      await db.run(sql`UPDATE users SET balance = balance + ${BBQ_HEAL_COST} WHERE telegram_id = ${telegramId}`);
      continue;
    }
    healed.push(name);
  }
  if (!healed.length) return { code: 'none', healed: [], cost: 0 };
  return { code: 'ok', healed, cost: BBQ_HEAL_COST * healed.length };
}
