/**
 * Daily Mission engine — serverless port of the reference map.py daily cycle.
 * One assignment per user per IST day, event-driven progress, one settlement.
 */

import { db } from 'sdk';
import { sql } from 'sdk/db';
import { escapeHtml } from './texts.js';
import { PET_XP_CAP } from './pet/defs.js';
import { ensurePetSchema } from './pet/store.js';

import { dailyCycleDate, DAILY_TEMPLATES, DAILY_DIFFICULTY } from './daily_defs.js';
export { dailyCycleDate, DAILY_TEMPLATES, DAILY_DIFFICULTY };

const nowSec = () => Math.floor(Date.now() / 1000);

async function ownsItem(userId, name) {
  const row = await db.get(sql`
    SELECT 1 AS ok FROM inventory
    WHERE telegram_id = ${userId} AND item_name = ${name} AND qty > 0
    LIMIT 1
  `);
  return !!row;
}

async function ownsAnyPet(userId) {
  const row = await db.get(sql`
    SELECT 1 AS ok FROM user_pets WHERE telegram_id = ${userId} LIMIT 1
  `);
  return !!row;
}

async function allPetsMaxed(userId) {
  const row = await db.get(sql`
    SELECT COUNT(*) AS total, SUM(CASE WHEN xp >= ${PET_XP_CAP} THEN 1 ELSE 0 END) AS maxed
    FROM user_pets WHERE telegram_id = ${userId}
  `);
  const total = Number(row?.total || 0);
  return total > 0 && Number(row?.maxed || 0) >= total;
}

async function isEligible(userId, template) {
  switch (template.requirementType) {
    case 'kill_success':
    case 'rob_success':
      return ownsItem(userId, 'Itachi');
    case 'patrol_complete':
      return (await ownsItem(userId, 'Naruto')) || (await ownsItem(userId, 'Starter Shinobi'))
        || (await ownsItem(userId, 'Hinata')) || (await ownsItem(userId, 'Sakura'));
    case 'mission_complete':
      return (await ownsItem(userId, 'Sasuke')) || (await ownsItem(userId, 'Naruto'));
    case 'shinobi_xp':
      return true;
    case 'pet_feed':
    case 'pet_play':
      return ownsAnyPet(userId);
    case 'pet_train':
      return (await ownsAnyPet(userId)) && !(await allPetsMaxed(userId));
    default:
      return false;
  }
}

async function chooseTemplate(userId, random) {
  const pool = [];
  for (const template of Object.values(DAILY_TEMPLATES)) {
    if (await isEligible(userId, template)) pool.push(template);
  }
  if (!pool.length) return null;
  return pool[Math.floor(random() * pool.length) % pool.length];
}

function rowToMission(row) {
  if (!row) return null;
  return {
    userId: Number(row.user_id),
    cycleDate: row.cycle_date,
    missionId: row.mission_id,
    requirementType: row.requirement_type,
    targetCount: Number(row.target_count || 1),
    progress: Number(row.progress || 0),
    rewardCoins: Number(row.reward_coins || 0),
    status: row.status,
    assignedAt: Number(row.assigned_at || 0),
    completedAt: row.completed_at == null ? 0 : Number(row.completed_at),
    rewardSettled: Number(row.reward_settled || 0),
    settlementKey: row.reward_settlement_key,
    name: row.mission_name || '',
    emoji: row.mission_emoji || '📜',
    description: row.mission_description || '',
    difficulty: row.difficulty || 'easy',
  };
}

export async function getDailyMission(userId, cycleDate = dailyCycleDate()) {
  await ensurePetSchema();
  const row = await db.get(sql`
    SELECT user_id, cycle_date, mission_id, requirement_type, target_count, progress,
           reward_coins, status, assigned_at, completed_at, reward_settled,
           reward_settlement_key, mission_name, mission_emoji, mission_description, difficulty
    FROM daily_missions
    WHERE user_id = ${userId} AND cycle_date = ${cycleDate}
  `);
  const mission = rowToMission(row);
  if (mission && mission.status === 'completed' && !mission.rewardSettled) {
    try { await settleDailyReward(userId, cycleDate); } catch (e) { console.error('[daily settle]', e); }
    return getDailyMission(userId, cycleDate);
  }
  return mission;
}

export async function ensureDailyMission(userId, sourceChatId = null, random = Math.random) {
  await ensurePetSchema();
  const cycle = dailyCycleDate();
  try {
    await db.run(sql`
      UPDATE daily_missions SET status = 'expired'
      WHERE user_id = ${userId} AND cycle_date < ${cycle} AND status = 'assigned'
    `);
  } catch (_) { /* fresh install before migration */ }
  let mission = await getDailyMission(userId, cycle);
  if (mission) return mission;

  const template = await chooseTemplate(userId, random);
  if (!template) return null;
  const t = nowSec();
  const key = `daily_mission_reward:${userId}:${cycle}`;
  const chat = sourceChatId != null && Number(sourceChatId) < 0 ? Number(sourceChatId) : null;
  await db.run(sql`
    INSERT OR IGNORE INTO daily_missions
      (user_id, cycle_date, mission_id, requirement_type, target_count, progress,
       reward_coins, status, assigned_at, completed_at, reward_settled,
       reward_settlement_key, source_chat_id, mission_name, mission_emoji,
       mission_description, difficulty)
    VALUES (${userId}, ${cycle}, ${template.id}, ${template.requirementType},
            ${template.targetCount}, 0, ${template.rewardCoins}, 'assigned', ${t}, NULL, 0,
            ${key}, ${chat}, ${template.name}, ${template.emoji},
            ${template.description}, ${template.difficulty})
  `);
  return getDailyMission(userId, cycle);
}

async function settleDailyReward(userId, cycleDate) {
  const row = await db.get(sql`
    SELECT user_id, cycle_date, mission_id, requirement_type, target_count, progress,
           reward_coins, status, assigned_at, completed_at, reward_settled,
           reward_settlement_key, mission_name, mission_emoji, mission_description, difficulty
    FROM daily_missions
    WHERE user_id = ${userId} AND cycle_date = ${cycleDate}
  `);
  const mission = rowToMission(row);
  if (!mission || mission.status !== 'completed' || mission.rewardSettled) return null;
  const won = await db.run(sql`
    UPDATE daily_missions SET reward_settled = 1
    WHERE user_id = ${userId} AND cycle_date = ${cycleDate}
      AND status = 'completed' AND reward_settled = 0
  `);
  if (won.rowsAffected === 0) return null;
  await db.run(sql`INSERT OR IGNORE INTO users (telegram_id, balance) VALUES (${userId}, 0)`);
  await db.run(sql`UPDATE users SET balance = balance + ${mission.rewardCoins} WHERE telegram_id = ${userId}`);
  return { amount: mission.rewardCoins, key: mission.settlementKey };
}

/**
 * Apply one successful event. `eventKey` is required for exactly-once progress:
 * the same completion retried must not increment twice.
 */
export async function notifyDailyProgress(userId, requirementType, eventKey, amount = 1) {
  const value = Math.max(0, Math.trunc(Number(amount) || 0));
  if (!requirementType || value <= 0) return null;
  const key = String(eventKey || `${requirementType}:${userId}:${nowSec()}`);
  const mission = await ensureDailyMission(userId);
  if (!mission) return null;
  if (mission.status !== 'assigned' || mission.requirementType !== requirementType) return null;

  const t = nowSec();
  const updated = await db.run(sql`
    UPDATE daily_missions
    SET progress = MIN(target_count, progress + ${value}), last_event_key = ${key}
    WHERE user_id = ${userId} AND cycle_date = ${mission.cycleDate}
      AND status = 'assigned' AND reward_settled = 0
      AND (last_event_key IS NULL OR last_event_key != ${key})
  `);
  if (updated.rowsAffected === 0) return null;

  const after = await getDailyMission(userId, mission.cycleDate);
  if (!after) return null;
  let awarded = false;
  if (after.progress >= after.targetCount) {
    const completed = await db.run(sql`
      UPDATE daily_missions
      SET status = 'completed', completed_at = ${t}
      WHERE user_id = ${userId} AND cycle_date = ${mission.cycleDate}
        AND status = 'assigned'
    `);
    if (completed.rowsAffected > 0) {
      const settled = await settleDailyReward(userId, mission.cycleDate);
      awarded = !!settled;
    }
  }
  return {
    completed: after.progress >= after.targetCount,
    awarded,
    progress: after.progress,
    targetCount: after.targetCount,
    rewardCoins: after.rewardCoins,
    name: after.name,
    emoji: after.emoji,
    missionId: after.missionId,
    cycleDate: after.cycleDate,
  };
}

export function dailyMissionBody(user, mission) {
  if (!mission) {
    return `<p><b>🗺️ KONOHA MAP</b></p>`
      + '<p><b>🎯 DAILY QUEST</b></p>'
      + '<p>No daily quest could be assigned right now. Check back later.</p>';
  }
  const name = escapeHtml(mission.name || 'Daily Quest');
  const template = DAILY_TEMPLATES[mission.missionId] || {};
  const objective = template.objective || escapeHtml(mission.description || 'Complete the daily quest.');
  const coins = `${Number(mission.rewardCoins || 0).toLocaleString('en-US')} Konoha coins`;
  const status = mission.status === 'completed' ? 'ᴄᴏᴍᴘʟᴇᴛᴇᴅ' : 'ᴘᴇɴᴅɪɴɢ';
  const expires = mission.status === 'expired' ? 'ᴇxᴘɪʀᴇᴅ' : 'ᴛᴏᴅᴀʏ';
  return '<p><b>🗺️ KONOHA MAP</b></p>'
    + '<p><b>🎯 DAILY QUEST</b></p>'
    + `<p>📜 ǫᴜᴇꜱᴛ: ${name}</p>`
    + `<p>🥷 ᴏʙᴊᴇᴄᴛɪᴠᴇ: ${objective}</p>`
    + `<p>🍥 ʀᴇᴡᴀʀᴅ: ${coins}</p>`
    + `<p>📊 ꜱᴛᴀᴛᴜꜱ: ${status}</p>`
    + `<p>⌛ ᴇxᴘɪʀᴇꜱ: ${expires}</p>`;
}

