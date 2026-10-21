/**
 * Persistent shinobi/user RPG state — the only place that touches
 * shinobi_state, user_skills, rpg_tx and users.equipped.
 * Everything is timestamp-based (restart-safe); no in-memory timers.
 */

import { db } from 'sdk';
import { sql } from 'sdk/db';
import {
  PATROLS_BEFORE_EXHAUSTION,
  EXHAUSTION_RECOVERY_SEC,
  DEATH_DURATION_SEC,
} from './levels.js';

const now = () => Math.floor(Date.now() / 1000);

// ---- rpg_tx: at-most-once effects ----

/** Returns true (and records the key) only for the first caller of `key`. */
export async function once(key) {
  try {
    const r = await db.run(
      sql`INSERT OR IGNORE INTO rpg_tx (key, created_at) VALUES (${key}, ${now()})`,
    );
    return r.rowsAffected > 0;
  } catch (e) {
    console.error('[rpg once]', e);
    return false;
  }
}

// ---- shinobi_state ----

export async function ensureShinobiState(telegramId, shinobi) {
  await db.run(sql`
    INSERT OR IGNORE INTO shinobi_state (telegram_id, shinobi)
    VALUES (${telegramId}, ${shinobi})
  `);
}

export async function getShinobiState(telegramId, shinobi) {
  await ensureShinobiState(telegramId, shinobi);
  return db.get(sql`
    SELECT level, patrol_streak AS patrolStreak, exhausted_until AS exhaustedUntil,
           dead_until AS deadUntil, last_robbed_at AS lastRobbedAt,
           train_sessions AS trainSessions, next_train_at AS nextTrainAt
    FROM shinobi_state
    WHERE telegram_id = ${telegramId} AND shinobi = ${shinobi}
  `);
}

export async function getAllShinobiState(telegramId) {
  const rows = await db.all(sql`
    SELECT shinobi, level, patrol_streak AS patrolStreak, exhausted_until AS exhaustedUntil,
           dead_until AS deadUntil, last_robbed_at AS lastRobbedAt,
           train_sessions AS trainSessions, next_train_at AS nextTrainAt
    FROM shinobi_state WHERE telegram_id = ${telegramId}
  `);
  return Object.fromEntries((rows || []).map((r) => [r.shinobi, r]));
}

export function isDead(state, t = now()) {
  if (state?.shinobi === 'Starter Shinobi') return false;
  return !!state && (state.deadUntil || 0) > t;
}
export function isExhausted(state, t = now()) {
  return !!state && (state.exhaustedUntil || 0) > t;
}

/** Mark dead for a 24h death cycle. Returns { ok, until }; ok=false when
 * the shinobi was already marked dead by a concurrent kill. */
export async function markDead(telegramId, shinobi) {
  const until = now() + DEATH_DURATION_SEC;
  await ensureShinobiState(telegramId, shinobi);
  const r = await db.run(sql`
    UPDATE shinobi_state SET dead_until = ${until}
    WHERE telegram_id = ${telegramId} AND shinobi = ${shinobi} AND dead_until <= ${now()}
  `);
  return { ok: r.rowsAffected > 0, until };
}

export async function revive(telegramId, shinobi) {
  await db.run(sql`
    UPDATE shinobi_state SET dead_until = 0
    WHERE telegram_id = ${telegramId} AND shinobi = ${shinobi}
  `);
}

/**
 * Record one completed patrol. When the consecutive-patrol limit is reached,
 * start the exhaustion timer and reset the streak.
 * Returns { exhausted: bool, exhaustedUntil } — exhausted is true for the
 * patrol that triggered the exhaustion.
 */
export async function recordPatrolCompletion(telegramId, shinobi) {
  await ensureShinobiState(telegramId, shinobi);
  const t = now();
  const state = await getShinobiState(telegramId, shinobi);
  const streak = (state.patrolStreak || 0) + 1;
  if (streak >= PATROLS_BEFORE_EXHAUSTION) {
    const until = t + EXHAUSTION_RECOVERY_SEC;
    await db.run(sql`
      UPDATE shinobi_state
      SET patrol_streak = 0, exhausted_until = ${until}
      WHERE telegram_id = ${telegramId} AND shinobi = ${shinobi}
    `);
    return { exhausted: true, exhaustedUntil: until };
  }
  await db.run(sql`
    UPDATE shinobi_state SET patrol_streak = ${streak}
    WHERE telegram_id = ${telegramId} AND shinobi = ${shinobi}
  `);
  return { exhausted: false, exhaustedUntil: 0 };
}

/** A mission breaks the consecutive-patrol chain. */
export async function resetPatrolStreak(telegramId, shinobi) {
  await db.run(sql`
    UPDATE shinobi_state SET patrol_streak = 0
    WHERE telegram_id = ${telegramId} AND shinobi = ${shinobi}
  `);
}

/** Instantly clear exhaustion (BBQ / Katsuyu). Does not touch other timers. */
export async function clearExhaustion(telegramId, shinobi) {
  await db.run(sql`
    UPDATE shinobi_state SET exhausted_until = 0, patrol_streak = 0
    WHERE telegram_id = ${telegramId} AND shinobi = ${shinobi}
  `);
}

// ---- user_skills ----

export async function getUserSkills(telegramId) {
  await db.run(sql`INSERT OR IGNORE INTO user_skills (telegram_id) VALUES (${telegramId})`);
  return db.get(sql`
    SELECT protected_until AS protectedUntil,
           sakura_heal_at AS sakuraHealAt, sakura_heal_uses AS sakuraHealUses,
           katsuyu_heal_at AS katsuyuHealAt, byakugan_at AS byakuganAt
    FROM user_skills WHERE telegram_id = ${telegramId}
  `);
}

export async function setUserSkills(telegramId, fields) {
  await getUserSkills(telegramId);
  const map = {
    protectedUntil: 'protected_until',
    sakuraHealAt: 'sakura_heal_at',
    sakuraHealUses: 'sakura_heal_uses',
    katsuyuHealAt: 'katsuyu_heal_at',
    byakuganAt: 'byakugan_at',
  };
  for (const [k, v] of Object.entries(fields)) {
    const col = map[k];
    if (!col || !Number.isFinite(Number(v))) continue;
    await db.run(sql`UPDATE user_skills SET ${sql.raw(col)} = ${Math.floor(v)} WHERE telegram_id = ${telegramId}`);
  }
}

/** Jiraiya protection: 24h, never refreshed while still active. Guarded flip. */
export async function activateProtection(telegramId) {
  const t = now();
  const s = await getUserSkills(telegramId);
  if ((s.protectedUntil || 0) > t) {
    return { ok: false, protectedUntil: s.protectedUntil };
  }
  const until = t + 24 * 3600;
  const won = await db.run(sql`
    UPDATE user_skills SET protected_until = ${until}
    WHERE telegram_id = ${telegramId} AND protected_until <= ${t}
  `);
  if (won.rowsAffected === 0) {
    const s2 = await getUserSkills(telegramId);
    return { ok: false, protectedUntil: s2.protectedUntil };
  }
  return { ok: true, protectedUntil: until };
}

export async function isProtected(telegramId, t = now()) {
  const s = await getUserSkills(telegramId);
  return (s.protectedUntil || 0) > t;
}

// ---- equipped characters (max 3) ----
// users.equipped remains the primary (first) for kill-target / legacy reads.
// user_equipped table holds the full list (0–3).

const MAX_EQUIPPED = 3;

export async function getEquippedList(telegramId) {
  try {
    const rows = await db.all(sql`
      SELECT shinobi FROM user_equipped
      WHERE telegram_id = ${telegramId}
      ORDER BY slot ASC, shinobi ASC
    `);
    if (rows && rows.length) return rows.map((r) => r.shinobi);
  } catch (_) { /* table may not exist yet */ }
  // Fallback to legacy single column
  const u = await db.get(sql`SELECT equipped FROM users WHERE telegram_id = ${telegramId}`);
  if (u && u.equipped) return [u.equipped];
  return ['Starter Shinobi'];
}

/** Primary equipped (first slot) — used by kill targeting & life status. */
export async function getEquipped(telegramId) {
  const list = await getEquippedList(telegramId);
  return list[0] || 'Starter Shinobi';
}

export async function isEquipped(telegramId, shinobi) {
  const list = await getEquippedList(telegramId);
  return list.some((s) => s.toLowerCase() === String(shinobi).toLowerCase());
}

/**
 * Equip a shinobi into an empty slot (max 3).
 * @returns {{ ok: boolean, code: string, list?: string[] }}
 */
export async function equipShinobi(telegramId, shinobi) {
  const raw = String(shinobi || '').trim();
  if (!raw) return { ok: false, code: 'invalid' };
  const own = await ownedSet(telegramId);
  // Resolve name: exact (case-insensitive) or unique partial match among owned + Starter
  const candidates = ['Starter Shinobi', ...own];
  const key = raw.toLowerCase();
  let name = candidates.find((s) => s.toLowerCase() === key);
  if (!name) {
    const partial = candidates.filter((s) => s.toLowerCase().includes(key));
    if (partial.length === 1) name = partial[0];
  }
  if (!name) return { ok: false, code: 'not_owned' };
  const list = await getEquippedList(telegramId);
  if (list.some((s) => s.toLowerCase() === name.toLowerCase())) {
    return { ok: false, code: 'already', list };
  }
  if (list.length >= MAX_EQUIPPED) return { ok: false, code: 'full', list };
  const slot = list.length;
  try {
    await db.run(sql`
      INSERT OR IGNORE INTO user_equipped (telegram_id, shinobi, slot)
      VALUES (${telegramId}, ${name}, ${slot})
    `);
  } catch (e) {
    // Create table on the fly if missing
    try {
      await db.run(sql`
        CREATE TABLE IF NOT EXISTS user_equipped (
          telegram_id INTEGER NOT NULL,
          shinobi TEXT NOT NULL,
          slot INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (telegram_id, shinobi)
        )
      `);
      await db.run(sql`
        INSERT OR IGNORE INTO user_equipped (telegram_id, shinobi, slot)
        VALUES (${telegramId}, ${name}, ${slot})
      `);
    } catch (e2) {
      console.error('[equipShinobi]', e2);
      return { ok: false, code: 'error' };
    }
  }
  // Keep legacy primary column in sync
  const next = await getEquippedList(telegramId);
  await db.run(sql`UPDATE users SET equipped = ${next[0] || name} WHERE telegram_id = ${telegramId}`);
  return { ok: true, code: 'ok', list: next };
}

/**
 * Unequip a shinobi.
 * @returns {{ ok: boolean, code: string, list?: string[] }}
 */
export async function unequipShinobi(telegramId, shinobi) {
  const raw = String(shinobi || '').trim();
  if (!raw) return { ok: false, code: 'invalid' };
  const list = await getEquippedList(telegramId);
  const key = raw.toLowerCase();
  let name = list.find((s) => s.toLowerCase() === key);
  if (!name) {
    const partial = list.filter((s) => s.toLowerCase().includes(key));
    if (partial.length === 1) name = partial[0];
  }
  if (!name) return { ok: false, code: 'not_equipped' };
  try {
    const won = await db.run(sql`
      DELETE FROM user_equipped
      WHERE telegram_id = ${telegramId} AND shinobi = ${name}
    `);
    if (won.rowsAffected === 0) {
      // Legacy: clear single equipped if matches
      const cur = await getEquipped(telegramId);
      if (cur.toLowerCase() === name.toLowerCase()) {
        await db.run(sql`UPDATE users SET equipped = NULL WHERE telegram_id = ${telegramId}`);
        return { ok: true, code: 'ok', list: [] };
      }
      return { ok: false, code: 'not_equipped' };
    }
  } catch (e) {
    console.error('[unequipShinobi]', e);
    return { ok: false, code: 'error' };
  }
  const next = await getEquippedList(telegramId);
  await db.run(sql`UPDATE users SET equipped = ${next[0] || null} WHERE telegram_id = ${telegramId}`);
  return { ok: true, code: 'ok', list: next };
}

/** @deprecated use equipShinobi */
export async function setEquipped(telegramId, shinobi) {
  return equipShinobi(telegramId, shinobi);
}

// ---- ownership helpers ----

export async function ownedSet(telegramId) {
  const rows = await db.all(sql`
    SELECT item_name FROM inventory
    WHERE telegram_id = ${telegramId} AND item_type = 'shinobi'
  `);
  return new Set((rows || []).map((r) => r.item_name));
}
