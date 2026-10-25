// Round 10: the Jiraiya shield reminder.
//
// Timers are private knowledge — /byakugan is the only command allowed to
// reveal them, and even that prints only for the scanner. The owner gets ONE
// DM per protection window, roughly 2–3 hours before the shield drops, with a
// live hours/minutes countdown.
import assert from 'node:assert/strict';
import { api } from 'sdk';
import { db, sql } from './sdk_db_stub.mjs';
import {
  sweepProtectionReminders,
  protectionCountdown,
  protectionReminderText,
  PROTECTION_REMINDER_WINDOW_SEC,
} from '../../tgcloud/lib/rpg/protect_reminder.js';

const now = () => Math.floor(Date.now() / 1000);
const t = now();

const SOON = 4001;    // 2h30m left → reminder
const EDGE = 4002;    // 2h50m left → reminder
const LATER = 4003;   // 5h left → nothing yet
const ENDED = 4004;   // already over → nothing
const BOUNCER = 4005; // reminder window, but the DM fails → retry later

await db.run(sql`CREATE TABLE IF NOT EXISTS user_skills (
  telegram_id INTEGER PRIMARY KEY,
  protected_until INTEGER NOT NULL DEFAULT 0,
  byakugan_at INTEGER NOT NULL DEFAULT 0,
  sakura_heal_at INTEGER NOT NULL DEFAULT 0,
  sakura_heal_uses INTEGER NOT NULL DEFAULT 0,
  katsuyu_heal_at INTEGER NOT NULL DEFAULT 0,
  dead_until INTEGER NOT NULL DEFAULT 0,
  last_robbed_at INTEGER NOT NULL DEFAULT 0
)`);

const names = new Map([
  [SOON, 'Kakashi'],
  [EDGE, 'Sakura'],
  [LATER, 'Naruto'],
  [ENDED, 'Sasuke'],
  [BOUNCER, 'Hinata'],
]);
for (const [id, name] of names) {
  await db.run(sql`INSERT OR REPLACE INTO users (telegram_id, first_name) VALUES (${id}, ${name})`);
}
const until = (sec) => t + sec;
for (const [id, sec] of [[SOON, 2 * 3600 + 30 * 60], [EDGE, 2 * 3600 + 50 * 60], [LATER, 5 * 3600], [ENDED, -60], [BOUNCER, 2 * 3600 + 5 * 60]]) {
  await db.run(sql`INSERT OR REPLACE INTO user_skills (telegram_id, protected_until) VALUES (${id}, ${until(sec)})`);
}

const sent = [];
api.sendMessage = async (payload) => {
  if (payload.chat_id === BOUNCER) throw new Error('bot was blocked by the user');
  sent.push(payload);
  return { message_id: sent.length };
};
api.editMessageText = async () => ({});
api.answerCallbackQuery = async () => ({});

// ---- 1. countdown formatting ------------------------------------------------
assert.equal(protectionCountdown(t + 2 * 3600 + 37 * 60, t), '2 ʜᴏᴜʀꜱ 37 ᴍɪɴᴜᴛᴇꜱ');
assert.equal(protectionCountdown(t + 3 * 3600, t), '3 ʜᴏᴜʀꜱ');
assert.equal(protectionCountdown(t + 45 * 60, t), '45 ᴍɪɴᴜᴛᴇꜱ');
assert.equal(protectionCountdown(t + 20, t), 'ʟᴇꜱꜱ ᴛʜᴀɴ ᴀ ᴍɪɴᴜᴛᴇ');
assert.equal(protectionCountdown(t - 500, t), 'ʟᴇꜱꜱ ᴛʜᴀɴ ᴀ ᴍɪɴᴜᴛᴇ');

// ---- 2. exact requested wording --------------------------------------------
const body = protectionReminderText({ id: SOON, first_name: 'Kakashi' }, t + 2 * 3600 + 37 * 60, t);
assert.match(body, /🐸 <a href="tg:\/\/user\?id=4001">Kakashi<\/a>/);
assert.match(body, /❄️ ʏᴏᴜʀ ᴊɪʀᴀɪʏᴀ ᴘʀᴏᴛᴇᴄᴛɪᴏɴ ᴡɪʟʟ ᴇxᴘɪʀᴇ ɪɴ 2 ʜᴏᴜʀꜱ 37 ᴍɪɴᴜᴛᴇꜱ !/);
assert.match(body, /🛡️ ꜱᴛᴀʏ ᴀʟᴇʀᴛ!/);

// ---- 3. the sweep is windowed, private and idempotent ----------------------
assert.equal(PROTECTION_REMINDER_WINDOW_SEC, 3 * 3600);
const first = await sweepProtectionReminders(t);
const firstIds = first.map((r) => r.id).sort();
assert.deepEqual(firstIds, [SOON, EDGE].sort(), 'only shields ending within 3h are reminded');
assert.ok(!first.some((r) => r.id === LATER), 'a shield with 5h left waits');
assert.ok(!first.some((r) => r.id === ENDED), 'an expired shield is never reminded');
assert.ok(!first.some((r) => r.id === BOUNCER), 'an undeliverable DM is not reported as sent');

assert.ok(sent.length >= 2, 'reminders leave as DMs');
for (const p of sent) {
  assert.ok(names.has(p.chat_id), 'the DM goes to the shielded user themselves');
  assert.equal(p.parse_mode, 'HTML');
  assert.doesNotMatch(JSON.stringify(p), /protected_until|byakugan/i, 'no internal field leaks into the DM');
}

// Nobody else was told anything: no group chat id ever receives a reminder.
const known = new Set([...names.keys()]);
assert.ok(sent.every((p) => known.has(p.chat_id)), 'no group receives a protection timer');

// Second pass in the same window: nothing new.
const before = sent.length;
await sweepProtectionReminders(t);
assert.equal(sent.length, before, 'one reminder per protection window');

// A brand new protection window (fresh `protected_until`) reminds again — the
// key carries the expiry, so it is once per window, not once per user ever.
const newUntil = t + 2 * 3600 + 10 * 60;
await db.run(sql`UPDATE user_skills SET protected_until = ${newUntil} WHERE telegram_id = ${SOON}`);
await sweepProtectionReminders(t);
assert.equal(sent.filter((p) => p.chat_id === SOON).length, 2, 'a new shield window reminds again');

// The failed DM released its key, so the next sweep retries it.
const bounced = await db.get(sql`SELECT COUNT(*) AS n FROM rpg_tx WHERE key = ${`protect_reminder:${BOUNCER}:${until(2 * 3600 + 5 * 60)}`}`);
assert.equal(Number(bounced.n), 0, 'the failed DM is not marked as delivered');

console.log('protect reminder: OK');
