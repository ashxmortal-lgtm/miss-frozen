// Jiraiya found on a Naruto patrol → ONE rich message in the patrol group:
// the storage-channel photo embedded as a <figure> (same method as /map), the
// discovery caption with its exact blank lines, and a real rich ❄️ button.
import assert from 'node:assert/strict';
import { api } from 'sdk';
import { db, sql } from './sdk_db_stub.mjs';
import {
  jiraiyaDiscoveryCaption, jiraiyaDiscoveryRich, sendJiraiyaDiscovery,
  JIRAIYA_MEDIA_MESSAGE_ID,
} from '../../tgcloud/lib/rpg/jiraiya_discovery.js';
import { runActivity, settleOwn } from '../../tgcloud/lib/activities.js';
import { style } from '../../tgcloud/lib/texts.js';

await db.run(sql.raw(`CREATE TABLE IF NOT EXISTS activities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id INTEGER NOT NULL,
  shinobi TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'idle',
  started_at INTEGER NOT NULL DEFAULT 0,
  ends_at INTEGER NOT NULL DEFAULT 0,
  cooldown_until INTEGER NOT NULL DEFAULT 0,
  base_roll INTEGER NOT NULL DEFAULT 0,
  chat_id INTEGER NOT NULL DEFAULT 0,
  cooldown_sec INTEGER NOT NULL DEFAULT 0,
  partner_pet TEXT
)`));
await db.run(sql.raw(`CREATE TABLE IF NOT EXISTS map_media_cache (
  storage_message_id INTEGER PRIMARY KEY,
  file_id TEXT NOT NULL
)`));
await db.run(sql.raw(`CREATE TABLE IF NOT EXISTS tsunade_search (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id INTEGER, status TEXT, ends_at INTEGER
)`));
await db.run(sql.raw(`CREATE TABLE IF NOT EXISTS pending_patrol_rewards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id INTEGER NOT NULL, shinobi TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'patrol',
  reward INTEGER NOT NULL DEFAULT 0, completed_at INTEGER NOT NULL DEFAULT 0,
  claimed INTEGER NOT NULL DEFAULT 0
)`));

const rich = [];
const texts = [];
const photos = [];
let forwardCalls = [];
api.sendRichMessage = async (payload) => { rich.push(payload); return { message_id: 500 + rich.length }; };
api.sendMessage = async (payload) => { texts.push(payload); return { message_id: texts.length + 1 }; };
api.sendPhoto = async (payload) => { photos.push(payload); return { message_id: 900 + photos.length }; };
api.forwardMessage = async (payload) => {
  forwardCalls.push(payload);
  return { message_id: 77, photo: [{ file_id: 'JIRAIYA_PHOTO' }] };
};
api.deleteMessage = async () => ({});
api.editMessageText = async () => ({});
api.answerCallbackQuery = async () => ({});

const htmlOf = (payload) => String(payload?.rich_message?.html || '');
// The builder returns the raw rich HTML; message_style styles the label and
// re-orders the attributes on the way out, so the two shapes are asserted where
// each one actually appears.
const rawButton = /<tg-button-row align="center"><tg-button type="url" style="success" url="https:\/\/t\.me\/frozenblooded\/14">Check ❄️ ability<\/tg-button><\/tg-button-row>/;
const sentButton = /<tg-button-row align="center"><tg-button type="url" url="https:\/\/t\.me\/frozenblooded\/14" style="success">ᴄʜᴇᴄᴋ ❄️ ᴀʙɪʟɪᴛʏ<\/tg-button><\/tg-button-row>/;

const USER = { id: 4242, first_name: 'Kakashi', username: 'kakashi' };
const MENTION = '<a href="tg://user?id=4242">Kakashi</a>';

// ---- 1. caption: exact lines and blank lines --------------------------------
assert.equal(JIRAIYA_MEDIA_MESSAGE_ID, 581, 'the t.me/c/3889508991/581 photo');
const caption = jiraiyaDiscoveryCaption(MENTION);
assert.equal(
  caption,
  '🐸 <a href="tg://user?id=4242">Kakashi</a>\n\n\n\n'
  + '🥀 you spotted master jiraiya near the hot springs!\n\n'
  + ' he was busy with his “<span class="tg-spoiler">research</span>”...🤫',
  'three blank lines after the mention, one before the last line, leading space kept',
);
assert.match(caption, /“<span class="tg-spoiler">research<\/span>”\.\.\.🤫/, 'research stays spoilered');

// ---- 2. rich payload: figure + paragraphs + rich button ---------------------
const withPhoto = jiraiyaDiscoveryRich(MENTION, 'JIRAIYA_PHOTO');
assert.match(withPhoto.html, /^<figure><img src="tg:\/\/photo\?id=jiraiya_photo"\/><\/figure><p>🐸 /);
assert.deepEqual(withPhoto.media, [
  { id: 'jiraiya_photo', media: { type: 'photo', media: 'JIRAIYA_PHOTO' } },
], 'the photo travels inside the rich message, like /map');
// ONE compact paragraph with real newlines: rich HTML has no <br> tag, and a
// <p> per line adds margins — both made the message far too tall.
assert.match(withPhoto.html, /<p>🐸 [\s\S]*?\n\n\n\n🥀 /,
  'exactly three blank lines between the mention and the snake line');
assert.match(withPhoto.html, /ꜱᴘʀɪɴɢꜱ!\n\n ʜᴇ ᴡᴀꜱ ʙᴜꜱʏ/,
  'exactly one blank line before the last line');
assert.equal((withPhoto.html.match(/<p>/g) || []).length, 1, 'the caption is a single paragraph');
assert.doesNotMatch(withPhoto.html, /<br\s*\/?>/, 'no <br> tags — unsupported in rich HTML');
assert.equal((withPhoto.html.match(/\n/g) || []).length, 6, 'four + two real line breaks');
assert.match(withPhoto.html, /<span class="tg-spoiler">ʀᴇꜱᴇᴀʀᴄʜ<\/span>/, 'styled spoiler');
assert.match(withPhoto.html, rawButton, 'a real rich tg-button, not an inline keyboard');

const withoutPhoto = jiraiyaDiscoveryRich(MENTION);
assert.doesNotMatch(withoutPhoto.html, /<figure>/, 'no figure without a file_id');
assert.equal(withoutPhoto.media, undefined, 'no media without a file_id');
assert.match(withoutPhoto.html, rawButton, 'the rich button survives without the photo');

// ---- 3. the announcement is ONE rich message in the patrol group ------------
const ok = await sendJiraiyaDiscovery(USER, -100777);
assert.equal(ok, true);
assert.equal(rich.length, 1, 'one rich message, not a photo + a text');
assert.equal(photos.length, 0, 'no classic sendPhoto');
assert.equal(texts.length, 0, 'no classic sendMessage');
assert.equal(rich[0].chat_id, -100777, 'the group where the Naruto patrol was sent');
assert.deepEqual(rich[0].rich_message.media, [
  { id: 'jiraiya_photo', media: { type: 'photo', media: 'JIRAIYA_PHOTO' } },
], 'file_id resolved from the storage channel');
assert.match(htmlOf(rich[0]), sentButton, 'styled rich ability button');
assert.match(htmlOf(rich[0]), /tg:\/\/user\?id=4242/, 'the player is mentioned');
assert.equal(rich[0].reply_markup, undefined, 'no inline keyboard alongside the rich button');
assert.equal(rich[0].parse_mode, undefined, 'rich messages carry HTML, not parse_mode');
assert.equal(forwardCalls[0].from_chat_id, -1003889508991, 'storage channel');
assert.equal(forwardCalls[0].message_id, 581);
assert.equal(forwardCalls[0].chat_id, USER.id, 'resolved quietly in the DM, not the group');
assert.ok(forwardCalls.every((call) => call.chat_id !== -100777), 'no forward flashes in the group');

// ---- 4. rich unsupported → classic photo + inline button --------------------
const savedRich = api.sendRichMessage;
const savedPhoto = api.sendPhoto;
api.sendRichMessage = async () => { throw Object.assign(new Error('rich unsupported'), { code: 400 }); };
photos.length = 0;
assert.equal(await sendJiraiyaDiscovery(USER, -100777), true);
assert.equal(photos.length, 1, 'the classic photo still delivers the same moment');
assert.equal(photos[0].chat_id, -100777);
assert.equal(photos[0].photo, 'JIRAIYA_PHOTO');
assert.equal(photos[0].parse_mode, 'HTML');
assert.equal(photos[0].caption, style(jiraiyaDiscoveryCaption(MENTION)),
  'unchanged caption spacing (styled on the way out)');
assert.equal(photos[0].reply_markup.inline_keyboard[0][0].url, 'https://t.me/frozenblooded/14');

// ---- 5. the group refuses everything → the DM gets the rich message ---------
const refuseInGroup = (payload, error) => {
  if (payload.chat_id === -100777) throw error;
};
api.sendRichMessage = async (payload) => {
  refuseInGroup(payload, Object.assign(new Error('no rights'), { code: 400 }));
  rich.push(payload);
  return { message_id: 1 };
};
api.sendPhoto = async (payload) => {
  refuseInGroup(payload, Object.assign(new Error('not enough rights to send photos'), { code: 400 }));
  photos.push(payload);
  return { message_id: 1 };
};
api.sendMessage = async (payload) => {
  refuseInGroup(payload, Object.assign(new Error('no rights to send messages'), { code: 400 }));
  texts.push(payload);
  return { message_id: 1 };
};
const before = rich.length;
assert.equal(await sendJiraiyaDiscovery(USER, -100777), true);
assert.equal(rich.length, before + 1, 'the DM receives the rich message');
assert.equal(rich.at(-1).chat_id, USER.id, 'the DM is the fallback');
assert.match(htmlOf(rich.at(-1)), sentButton);

// ---- 6. every rich send fails → plain text with the inline button ----------
api.sendRichMessage = async () => { throw Object.assign(new Error('rich unsupported'), { code: 400 }); };
api.sendPhoto = async () => { throw Object.assign(new Error('no photos'), { code: 400 }); };
api.sendMessage = async (payload) => { texts.push(payload); return { message_id: 1 }; };
texts.length = 0;
assert.equal(await sendJiraiyaDiscovery(USER, -100777), true);
assert.equal(texts.length, 1);
assert.equal(texts[0].chat_id, -100777, 'text fallback also prefers the group');
assert.equal(texts[0].text, style(jiraiyaDiscoveryCaption(MENTION)), 'same caption, same spacing');
assert.equal(texts[0].reply_markup.inline_keyboard[0][0].url, 'https://t.me/frozenblooded/14');

// ---- 7. a real Naruto patrol awards Jiraiya and announces him once ---------
api.sendRichMessage = savedRich;
api.sendPhoto = savedPhoto;
api.forwardMessage = async () => ({ message_id: 79, photo: [{ file_id: 'JIRAIYA_PHOTO' }] });
rich.length = 0;
photos.length = 0;

const HERO = 4343;
await db.run(sql`INSERT OR REPLACE INTO users (telegram_id, balance, first_name, naruto_patrols)
  VALUES (${HERO}, 0, 'Naruto Fan', 15)`);
await db.run(sql`INSERT OR IGNORE INTO inventory (telegram_id, item_type, item_name, qty)
  VALUES (${HERO}, 'shinobi', 'Naruto', 1)`);
await db.run(sql`INSERT OR IGNORE INTO inventory (telegram_id, item_type, item_name, qty)
  VALUES (${HERO}, 'shinobi', 'Starter Shinobi', 1)`);
await db.run(sql`UPDATE users SET equipped = 'Naruto' WHERE telegram_id = ${HERO}`);

const group = { id: -100999, type: 'supergroup', title: 'Leaf' };
const dispatched = await runActivity({ id: HERO, first_name: 'Naruto Fan' }, 'patrol', 'Naruto', group.id);
assert.equal(dispatched.status, 'ok', 'the patrol starts');

// A 1h patrol finishes: backdate the window, then settle it.
const tt = Math.floor(Date.now() / 1000);
await db.run(sql`
  UPDATE activities SET started_at = ${tt - 4000}, ends_at = ${tt - 60}, status = 'active'
  WHERE telegram_id = ${HERO} AND shinobi = 'Naruto'
`);
const settled = await settleOwn({ id: HERO });
assert.ok(settled.blocks.some((b) => /Jiraiya has joined your shinobi roster/i.test(b)), 'the card says he joined');
assert.equal(rich.length, 1, 'exactly one discovery announcement');
assert.equal(rich[0].chat_id, group.id, 'the patrol group, not the DM');
assert.match(htmlOf(rich[0]), /<figure><img src="tg:\/\/photo\?id=jiraiya_photo"\/><\/figure>/);
assert.doesNotMatch(htmlOf(rich[0]), /<br\s*\/?>/, 'no <br> tags in rich HTML');
assert.equal((htmlOf(rich[0]).match(/<p>/g) || []).length, 1, 'one paragraph');
assert.equal((htmlOf(rich[0]).match(/\n/g) || []).length, 6, 'compacted line breaks');
assert.match(htmlOf(rich[0]), sentButton);
const owned = await db.get(sql`
  SELECT qty FROM inventory WHERE telegram_id = ${HERO} AND item_name = 'Jiraiya'
`);
assert.equal(Number(owned.qty), 1, 'Jiraiya is in the roster');

// Settling again never announces twice.
const again = await settleOwn({ id: HERO });
assert.deepEqual(again.blocks, []);
assert.equal(rich.length, 1, 'the announcement is sent once');

console.log('jiraiya discovery: OK');
