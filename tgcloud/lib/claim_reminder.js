/**
 * Daily-reward reminder for groups.
 *
 * People who have not claimed today are mentioned in the group with the claim
 * message and the same button `/claim` uses there (📩 Open bot DM). There is no
 * scheduler in this bot, so the sweep rides the existing per-message path and
 * uses `once()` to keep it to ONE message per group per IST day.
 */

import { db } from 'sdk';
import { sql } from 'sdk/db';
import { send } from './chat.js';
import { mention } from './texts.js';
import { todayKey } from './economy.js';
import { once } from './rpg/state.js';
import { istHour } from './rpg/time.js';
import { BOT_USERNAME } from './config.js';

/**
 * No pings at 00:00 — the IST day starts then, so a reminder is only useful
 * once the day is actually running. Change this one constant to move it.
 */
export const CLAIM_REMINDER_START_HOUR_IST = 10;

/**
 * One message per group per IST day, pinging up to this many members. The group
 * itself still sees the message, so a big roster is not left out.
 */
export const CLAIM_REMINDER_MAX_USERS = 12;

/** The group `/claim` button — shared with replyClaimPrompt so they never drift. */
export const CLAIM_GROUP_BUTTON = {
  text: '📩 Open bot DM',
  url: `https://t.me/${BOT_USERNAME}?start=mini_claim`,
};
export const claimGroupKeyboard = () => ({ inline_keyboard: [[{ ...CLAIM_GROUP_BUTTON }]] });

/** Exact reminder body; `people` are `{ id, first_name }` mention targets. */
export function claimReminderText(people) {
  const who = people.map(mention).join(', ');
  return `❄️ ${who}\n\n🎁 ᴄʟᴀɪᴍ ʏᴏᴜʀ ᴅᴀɪʟʏ ʀᴇᴡᴀʀᴅ ɴᴏᴡ! 👀`;
}

const isGroupChat = (chat) => chat && (chat.type === 'group' || chat.type === 'supergroup');

async function economyLocked(chatId) {
  try {
    const row = await db.get(sql`
      SELECT economy_enabled AS enabled FROM group_settings WHERE chat_id = ${chatId}
    `);
    return !!row && Number(row.enabled) === 0;
  } catch (_) {
    return false; // no settings row / older database: economy is on
  }
}

/**
 * Remind this group's members who have not claimed today.
 * Safe to call on every incoming message: it is a no-op in private chats, in
 * groups with the economy off, before CLAIM_REMINDER_START_HOUR_IST, and for
 * anyone already reminded today.
 *
 * @param {{ skip?: number[] }} [options] ids never reminded in this pass
 *   (e.g. the member who just typed the command that triggered the sweep).
 * @returns {Promise<Array<{id:number, first_name:string}>>} people reminded now
 */
export async function sweepClaimReminders(
  chat,
  t = Math.floor(Date.now() / 1000),
  { skip = [] } = {},
) {
  const reminded = [];
  if (!isGroupChat(chat)) return reminded;
  const skipIds = new Set((skip || []).map(Number).filter(Boolean));
  if (istHour(t) < CLAIM_REMINDER_START_HOUR_IST) return reminded;
  if (await economyLocked(chat.id)) return reminded;

  const day = todayKey();
  let rows = [];
  try {
    rows = await db.all(sql`
      SELECT m.telegram_id AS id, u.first_name AS first_name
      FROM group_members m
      JOIN users u ON u.telegram_id = m.telegram_id
      WHERE m.chat_id = ${chat.id}
        AND (u.blocked IS NULL OR u.blocked = 0)
        AND (u.last_claim_date IS NULL OR u.last_claim_date <> ${day})
      ORDER BY m.id ASC
      LIMIT 40
    `);
  } catch (e) {
    console.error('[claim reminder query]', e?.message || e);
    return reminded;
  }

  for (const row of rows || []) {
    if (reminded.length >= CLAIM_REMINDER_MAX_USERS) break;
    const id = Number(row.id);
    if (!id || skipIds.has(id)) continue;
    reminded.push({ id, first_name: row.first_name || 'Shinobi' });
  }
  if (!reminded.length) return reminded;

  // ONE message for the whole group per IST day — otherwise a busy group would
  // get a fresh batch on every message that arrives.
  if (!(await once(`claim_reminder_chat:${chat.id}:${day}`))) return [];

  try {
    await send(chat.id, {
      text: claimReminderText(reminded),
      parse_mode: 'HTML',
      reply_markup: claimGroupKeyboard(),
      disable_reply_target: true,
    });
  } catch (e) {
    // Removed from the group, throttled, ...: keep the marks so a dead chat is
    // not retried on every message. Tomorrow's reminder is a fresh key.
    console.error('[claim reminder send]', e?.description || e?.message || e);
    return [];
  }
  return reminded;
}
