/**
 * Pending mission/patrol rewards — claim only at Hokage (not auto-added to balance).
 */

import { db } from 'sdk';
import { sql } from 'sdk/db';

const now = () => Math.floor(Date.now() / 1000);

/**
 * @param {number} telegramId
 * @param {string} shinobi
 * @param {number} reward
 * @param {'patrol'|'mission'} kind
 */
export async function addPendingReward(telegramId, shinobi, reward, kind = 'patrol') {
  const t = now();
  const existing = await db.get(sql`
    SELECT reward FROM pending_patrol_rewards
    WHERE telegram_id = ${telegramId}
      AND shinobi = ${shinobi}
      AND kind = ${kind}
      AND claimed = 0
  `);
  if (existing) {
    await db.run(sql`
      UPDATE pending_patrol_rewards
      SET reward = reward + ${reward}, completed_at = ${t}
      WHERE telegram_id = ${telegramId}
        AND shinobi = ${shinobi}
        AND kind = ${kind}
        AND claimed = 0
    `);
  } else {
    await db.run(sql`
      INSERT INTO pending_patrol_rewards
        (telegram_id, shinobi, kind, reward, completed_at, claimed)
      VALUES (${telegramId}, ${shinobi}, ${kind}, ${reward}, ${t}, 0)
    `);
  }
}

/** @deprecated use addPendingReward */
export async function addPendingPatrolReward(telegramId, shinobi, reward) {
  return addPendingReward(telegramId, shinobi, reward, 'patrol');
}

export async function listPendingRewards(telegramId) {
  return db.all(sql`
    SELECT shinobi, kind, reward, completed_at
    FROM pending_patrol_rewards
    WHERE telegram_id = ${telegramId} AND claimed = 0
    ORDER BY kind, completed_at
  `);
}

export async function listPendingPatrolRewards(telegramId) {
  return listPendingRewards(telegramId);
}

/** Sum of unclaimed rewards (mission + patrol). */
export async function pendingRewardTotal(telegramId) {
  const row = await db.get(sql`
    SELECT COALESCE(SUM(reward), 0) AS total
    FROM pending_patrol_rewards
    WHERE telegram_id = ${telegramId} AND claimed = 0
  `);
  return row ? Number(row.total) || 0 : 0;
}

/**
 * Claim all pending. Balance increases only here.
 * Returns { code, total, missionTotal, patrolTotal, details }.
 */
export async function claimAllPendingRewards(telegramId) {
  const rows = await listPendingRewards(telegramId);
  if (!rows.length) {
    return { code: 'none', total: 0, missionTotal: 0, patrolTotal: 0, details: [] };
  }

  let total = 0;
  let missionTotal = 0;
  let patrolTotal = 0;
  const details = [];

  for (const r of rows) {
    const won = await db.run(sql`
      UPDATE pending_patrol_rewards
      SET claimed = 1
      WHERE telegram_id = ${telegramId}
        AND shinobi = ${r.shinobi}
        AND kind = ${r.kind || 'patrol'}
        AND claimed = 0
    `);
    if (won.rowsAffected === 0) continue;
    total += r.reward;
    if ((r.kind || 'patrol') === 'mission') missionTotal += r.reward;
    else patrolTotal += r.reward;
    details.push({ shinobi: r.shinobi, kind: r.kind || 'patrol', reward: r.reward });
  }

  if (total <= 0) {
    return { code: 'none', total: 0, missionTotal: 0, patrolTotal: 0, details: [] };
  }

  await db.run(sql`
    INSERT OR IGNORE INTO users (telegram_id, balance) VALUES (${telegramId}, 0)
  `);
  await db.run(sql`
    UPDATE users SET balance = balance + ${total} WHERE telegram_id = ${telegramId}
  `);
  return { code: 'ok', total, missionTotal, patrolTotal, details };
}

export async function claimPendingPatrolRewards(telegramId) {
  return claimAllPendingRewards(telegramId);
}
