// Daily-reward reminder: members of a group who have not claimed today get
// mentioned once per IST day with the claim message and the same button the
// group `/claim` uses. No scheduler — it rides the per-message sweep.
import assert from 'node:assert/strict';
import { api } from 'sdk';
import { db, sql } from './sdk_db_stub.mjs';
import {
  sweepClaimReminders, claimReminderText, claimGroupKeyboard, CLAIM_GROUP_BUTTON,
  CLAIM_REMINDER_START_HOUR_IST, CLAIM_REMINDER_MAX_USERS,
} from '../../tgcloud/lib/claim_reminder.js';
import { todayKey } from '../../tgcloud/lib/economy.js';
import { istHour } from '../../tgcloud/lib/rpg/time.js';
import { BOT_USERNAME } from '../../tgcloud/lib/config.js';

await db.run(sql.raw(`CREATE TABLE IF NOT EXISTS group_members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  telegram_id INTEGER NOT NULL
)`));
await db.run(sql.raw('CREATE UNIQUE INDEX IF NOT EXISTS uidx_group_members ON group_members (chat_id, telegram_id)'));
await db.run(sql.raw(`CREATE TABLE IF NOT EXISTS group_settings (
  chat_id INTEGER PRIMARY KEY,
  economy_enabled INTEGER NOT NULL DEFAULT 1
)`));
// chat.send() schedules group messages for cleanup — the sweep must not throw.
await db.run(sql.raw(`CREATE TABLE IF NOT EXISTS cleanup (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  message_id INTEGER NOT NULL,
  delete_at INTEGER NOT NULL
)`));

const GROUP = -1001;
const LOCKED = -1002;
const QUIET = -1003;
const CLAIMED = 8001;
const UNCLAIMED_A = 8002;
const UNCLAIMED_B = 8003;
const NEVER = 8004;   // no users row at all

const sent = [];
api.sendMessage = async (payload) => { sent.push(payload); return { message_id: sent.length + 1 }; };
api.sendRichMessage = async (payload) => { sent.push(payload); return { message_id: 200 + sent.length }; };
api.editMessageText = async () => ({});
api.answerCallbackQuery = async () => ({});

const textOf = (p) => p.text ?? p.rich_message?.html ?? JSON.stringify(p);

await db.run(sql`INSERT INTO users (telegram_id, first_name, last_claim_date)
  VALUES (${CLAIMED}, 'Kakashi', ${todayKey()})`);
for (const [id, name] of [[UNCLAIMED_A, 'Naruto'], [UNCLAIMED_B, 'Sakura']]) {
  await db.run(sql`INSERT INTO users (telegram_id, first_name) VALUES (${id}, ${name})`);
}
for (const id of [CLAIMED, UNCLAIMED_A, UNCLAIMED_B, NEVER]) {
  await db.run(sql`INSERT INTO group_members (chat_id, telegram_id) VALUES (${GROUP}, ${id})`);
}
await db.run(sql`INSERT INTO group_members (chat_id, telegram_id) VALUES (${LOCKED}, ${UNCLAIMED_A})`);
await db.run(sql`INSERT INTO group_settings (chat_id, economy_enabled) VALUES (${LOCKED}, 0)`);

// 10:00 IST = 04:30 UTC; 09:00 IST = 03:30 UTC (before the reminder hour).
const at = (hh, mm = 0) => Math.floor(Date.UTC(2026, 9, 25, hh, mm) / 1000);
const IST_9AM = at(3, 30);
const IST_10AM = at(4, 30);

// ---- 1. exact wording + shared /claim button --------------------------------
assert.equal(CLAIM_REMINDER_START_HOUR_IST, 10);
assert.equal(istHour(IST_10AM), 10);
const body = claimReminderText([{ id: UNCLAIMED_A, first_name: 'Naruto' }]);
assert.equal(
  body,
  '❄️ <a href="tg://user?id=8002">Naruto</a>\n\n🎁 ᴄʟᴀɪᴍ ʏᴏᴜʀ ᴅᴀɪʟʏ ʀᴇᴡᴀʀᴅ ɴᴏᴡ! 👀',
);
assert.deepEqual(claimGroupKeyboard(), {
  inline_keyboard: [[{ text: '📩 Open bot DM', url: `https://t.me/${BOT_USERNAME}?start=mini_claim` }]],
});
assert.deepEqual(CLAIM_GROUP_BUTTON, claimGroupKeyboard().inline_keyboard[0][0]);

// ---- 2. it never fires in private chats or before 10:00 IST ------------------
assert.deepEqual(await sweepClaimReminders({ id: 9001, type: 'private' }, IST_10AM), []);
assert.deepEqual(await sweepClaimReminders({ id: GROUP, type: 'supergroup' }, IST_9AM), []);
assert.equal(sent.length, 0, 'silent so far');

// ---- 3. the group reminder --------------------------------------------------
const first = await sweepClaimReminders({ id: GROUP, type: 'supergroup' }, IST_10AM);
assert.deepEqual(first.map((u) => u.id).sort(), [UNCLAIMED_A, UNCLAIMED_B].sort(),
  'only members who have not claimed today are reminded');
assert.equal(sent.length, 1, 'one message per group, not one per user');
const payload = sent[0];
assert.equal(payload.chat_id, GROUP);
const text = textOf(payload);
for (const name of ['Naruto', 'Sakura']) assert.match(text, new RegExp(name), 'each member is mentioned');
assert.match(text, /tg:\/\/user\?id=8002/);
assert.match(text, /tg:\/\/user\?id=8003/);
assert.doesNotMatch(text, /Kakashi|8001/, 'the member who already claimed is not mentioned');
assert.match(text, /ᴄʟᴀɪᴍ ʏᴏᴜʀ ᴅᴀɪʟʏ ʀᴇᴡᴀʀᴅ ɴᴏᴡ! 👀/);
assert.match(text, /start=mini_claim/, 'the same button as /claim');
assert.ok(!('reply_parameters' in payload), 'background reminder is not a reply');

// ---- 4. one message per group per IST day ------------------------------------
const second = await sweepClaimReminders({ id: GROUP, type: 'supergroup' }, IST_10AM + 3600);
assert.deepEqual(second, []);
assert.equal(sent.length, 1, 'no second ping on the same IST day');
const groupKey = await db.get(sql`
  SELECT COUNT(*) AS n FROM rpg_tx WHERE key = ${`claim_reminder_chat:${GROUP}:${todayKey()}`}
`);
assert.equal(Number(groupKey.n), 1, 'the group is marked for today');

// A member who claims later changes nothing: the group already had its message.
await db.run(sql`UPDATE users SET last_claim_date = ${todayKey()} WHERE telegram_id = ${UNCLAIMED_A}`);
await sweepClaimReminders({ id: GROUP, type: 'supergroup' }, IST_10AM + 7200);
assert.equal(sent.length, 1);

// ---- 5. economy off → no claim pings ---------------------------------------
assert.deepEqual(await sweepClaimReminders({ id: LOCKED, type: 'supergroup' }, IST_10AM), []);
assert.equal(sent.length, 1);
// ...and an idle group with nothing to say stays silent.
assert.deepEqual(await sweepClaimReminders({ id: QUIET, type: 'supergroup' }, IST_10AM), []);
assert.equal(sent.length, 1);

// ---- 6. the member typing /claim is not double-tapped -----------------------
const SKIP_GROUP = -1004;
await db.run(sql`INSERT INTO users (telegram_id, first_name) VALUES (8101, 'Itachi'), (8102, 'Hinata')`);
await db.run(sql`INSERT INTO group_members (chat_id, telegram_id) VALUES (${SKIP_GROUP}, 8101), (${SKIP_GROUP}, 8102)`);
const skipping = await sweepClaimReminders({ id: SKIP_GROUP, type: 'group' }, IST_10AM, { skip: [8101] });
assert.deepEqual(skipping.map((u) => u.id), [8102], 'the claimer is skipped, everyone else is reminded');

// A group whose only unclaimed member is the one typing /claim must not burn
// its one message for the day.
const SOLO_GROUP = -1005;
await db.run(sql`INSERT INTO users (telegram_id, first_name) VALUES (8103, 'Solo')`);
await db.run(sql`INSERT INTO group_members (chat_id, telegram_id) VALUES (${SOLO_GROUP}, 8103)`);
const before = sent.length;
assert.deepEqual(await sweepClaimReminders({ id: SOLO_GROUP, type: 'group' }, IST_10AM, { skip: [8103] }), []);
assert.equal(sent.length, before, 'nothing is sent when the only candidate is skipped');
const later = await sweepClaimReminders({ id: SOLO_GROUP, type: 'group' }, IST_10AM + 60);
assert.deepEqual(later.map((u) => u.id), [8103], 'a later sweep still reminds them');

// ---- 7. batching keeps messages small --------------------------------------
assert.equal(CLAIM_REMINDER_MAX_USERS, 12);
for (let i = 0; i < 30; i += 1) {
  const id = 9100 + i;
  await db.run(sql`INSERT INTO users (telegram_id, first_name) VALUES (${id}, ${`U${i}`})`);
  await db.run(sql`INSERT INTO group_members (chat_id, telegram_id) VALUES (-2000, ${id})`);
}
const batch = await sweepClaimReminders({ id: -2000, type: 'supergroup' }, IST_10AM);
assert.equal(batch.length, 12, 'at most 12 mentions in one message');
const batchAgain = await sweepClaimReminders({ id: -2001, type: 'supergroup' }, IST_10AM);
assert.deepEqual(batchAgain, [], 'a group with no members sends nothing');

console.log('claim reminder: OK');
