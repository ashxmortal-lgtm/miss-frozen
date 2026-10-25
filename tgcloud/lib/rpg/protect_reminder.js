/**
 * Jiraiya protection reminder.
 *
 * Protection timers are private: nothing in a group message may print when a
 * shield (or a revive) ends — that is what /byakugan is for. The owner instead
 * gets ONE DM shortly before the shield drops, with a live countdown.
 *
 * There is no scheduler in this bot: `sweepProtectionReminders()` runs on the
 * same lazily-triggered path as the activity/clone sweeps.
 */

import { db } from 'sdk';
import { sql } from 'sdk/db';
import { api } from '../message_api.js';
import { style, mention } from '../texts.js';
import { ensureAccountSchema, once } from './state.js';

const now = () => Math.floor(Date.now() / 1000);

/** Reminder window: ~2–3 hours before the shield ends. */
export const PROTECTION_REMINDER_WINDOW_SEC = 3 * 3600;

/** "2 ʜᴏᴜʀꜱ 45 ᴍɪɴᴜᴛᴇꜱ" · "3 ʜᴏᴜʀꜱ" · "45 ᴍɪɴᴜᴛᴇꜱ". */
export function protectionCountdown(until, t = now()) {
  const left = Math.max(0, Number(until || 0) - t);
  let hours = Math.floor(left / 3600);
  let minutes = Math.floor((left % 3600) / 60);
  if (minutes >= 60) { hours += 1; minutes = 0; }
  const parts = [];
  if (hours > 0) parts.push(`${hours} ${hours === 1 ? 'ʜᴏᴜʀ' : 'ʜᴏᴜʀꜱ'}`);
  if (minutes > 0) parts.push(`${minutes} ${minutes === 1 ? 'ᴍɪɴᴜᴛᴇ' : 'ᴍɪɴᴜᴛᴇꜱ'}`);
  return parts.length ? parts.join(' ') : 'ʟᴇꜱꜱ ᴛʜᴀɴ ᴀ ᴍɪɴᴜᴛᴇ';
}

/** Exact reminder body (requested wording). */
export function protectionReminderText(user, until, t = now()) {
  return `🐸 ${mention(user)}\n\n`
    + `❄️ ʏᴏᴜʀ ᴊɪʀᴀɪʏᴀ ᴘʀᴏᴛᴇᴄᴛɪᴏɴ ᴡɪʟʟ ᴇxᴘɪʀᴇ ɪɴ ${protectionCountdown(until, t)} !\n\n`
    + '🛡️ ꜱᴛᴀʏ ᴀʟᴇʀᴛ!';
}

async function release(key) {
  try { await db.run(sql`DELETE FROM rpg_tx WHERE key = ${key}`); } catch (_) {}
}

/**
 * DM every user whose shield ends inside the reminder window, at most once per
 * protection window (the `protect_reminder:<id>:<until>` key makes it exactly
 * once even when several messages arrive at the same time).
 */
export async function sweepProtectionReminders(t = now()) {
  const sent = [];
  try {
    await ensureAccountSchema();
    const rows = await db.all(sql`
      SELECT telegram_id AS id, protected_until AS until
      FROM user_skills
      WHERE protected_until > ${t} AND protected_until <= ${t + PROTECTION_REMINDER_WINDOW_SEC}
      ORDER BY protected_until ASC
      LIMIT 10
    `);
    for (const row of rows || []) {
      const id = Number(row.id);
      const until = Number(row.until);
      if (!id || !until) continue;
      const key = `protect_reminder:${id}:${until}`;
      // If a previous DM bounced (bot never opened in private), retry at most
      // once every 15 minutes instead of on every single message.
      const attempt = `protect_reminder_try:${id}:${until}:${Math.floor(t / 900)}`;
      if (!(await once(key))) continue;
      if (!(await once(attempt))) { await release(key); continue; }
      const u = await db.get(sql`SELECT first_name, username FROM users WHERE telegram_id = ${id}`);
      const user = {
        id,
        first_name: (u && u.first_name) || 'Shinobi',
        username: u ? u.username : null,
      };
      try {
        await api.sendMessage({
          chat_id: id,
          text: style(protectionReminderText(user, until, t)),
          parse_mode: 'HTML',
        });
        sent.push({ id, until });
      } catch (e) {
        console.error('[protect reminder dm]', e?.description || e?.message || e);
        // The DM never reached them (bot never opened in private):
        // release the key so a later sweep can retry.
        await release(key);
      }
    }
  } catch (e) {
    console.error('[protect reminders]', e?.message || e);
  }
  return sent;
}
