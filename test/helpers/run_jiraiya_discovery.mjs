// Jiraiya found on a Naruto patrol → photo announcement with the discovery
// caption (spoiler around "research") and the Check ❄️ ability button.
import assert from 'node:assert/strict';
import { api } from 'sdk';
import { db, sql } from './sdk_db_stub.mjs';
import {
  jiraiyaDiscoveryCaption, sendJiraiyaDiscovery, JIRAIYA_MEDIA_MESSAGE_ID,
} from '../../tgcloud/lib/rpg/jiraiya_discovery.js';
import { runActivity, settleOwn } from '../../tgcloud/lib/activities.js';

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

const sent = [];
const photos = [];
let forwardCalls = [];
api.sendMessage = async (payload) => { sent.push(payload); return { message_id: sent.length + 1 }; };
api.sendRichMessage = async (payload) => { sent.push(payload); return { message_id: 500 + sent.length }; };
api.sendPhoto = async (payload) => {
  photos.push(payload);
  return { message_id: 900 + photos.length };
};
api.forwardMessage = async (payload) => {
  forwardCalls.push(payload);
  return { message_id: 77, photo: [{ file_id: 'JIRAIYA_PHOTO' }] };
};
api.deleteMessage = async () => ({});
api.editMessageText = async () => ({});
api.answerCallbackQuery = async () => ({});

const USER = { id: 4242, first_name: 'Kakashi', username: 'kakashi' };

// ---- 1. caption ------------------------------------------------------------
assert.equal(JIRAIYA_MEDIA_MESSAGE_ID, 581, 'the t.me/c/3889508991/581 photo');
const caption = jiraiyaDiscoveryCaption('<a href="tg://user?id=4242">Kakashi</a>');
assert.match(caption, /^🐸 <a href="tg:\/\/user\?id=4242">Kakashi<\/a>/);
assert.match(caption, /🥀 you spotted master jiraiya near the hot springs!/);
assert.match(caption, /“<span class="tg-spoiler">research<\/span>”\.\.\.🤫/, 'research is behind a spoiler');
assert.doesNotMatch(caption.replace(/<span class="tg-spoiler">research<\/span>/, ''), /research/,
  'the word only appears inside the spoiler');

// ---- 2. the announcement goes to the DM with the ability button ------------
const ok = await sendJiraiyaDiscovery(USER, -100777);
assert.equal(ok, true);
assert.equal(photos.length, 1, 'one photo announcement');
assert.equal(photos[0].chat_id, USER.id, 'DM first, like the Tsunade discovery');
assert.equal(photos[0].photo, 'JIRAIYA_PHOTO', 'file_id resolved from the storage channel');
assert.equal(photos[0].parse_mode, 'HTML');
assert.match(photos[0].caption, /tg:\/\/user\?id=4242/);
assert.match(photos[0].caption, /<span class="tg-spoiler">ʀᴇꜱᴇᴀʀᴄʜ<\/span>/, 'styled spoiler');
assert.deepEqual(photos[0].reply_markup, {
  inline_keyboard: [[{
    text: 'ᴄʜᴇᴄᴋ ❄️ ᴀʙɪʟɪᴛʏ',
    url: 'https://t.me/frozenblooded/14',
    style: 'success',
  }]],
}, 'the Jiraiya ability post');
assert.equal(forwardCalls[0].from_chat_id, -1003889508991, 'storage channel');
assert.equal(forwardCalls[0].message_id, 581);

// ---- 3. a blocked DM falls back to the patrol's group ----------------------
const blocked = [];
api.forwardMessage = async (payload) => {
  if (payload.chat_id === USER.id) throw new Error('bot was blocked by the user');
  return { message_id: 78, photo: [{ file_id: 'JIRAIYA_PHOTO_GROUP' }] };
};
api.sendPhoto = async (payload) => {
  if (payload.chat_id === USER.id) throw new Error('bot was blocked by the user');
  blocked.push(payload);
  return { message_id: 1 };
};
const fellBack = await sendJiraiyaDiscovery(USER, -100777);
assert.equal(fellBack, true);
assert.equal(blocked.length, 1);
assert.equal(blocked[0].chat_id, -100777, 'the group where the patrol ran');
assert.equal(blocked[0].reply_markup.inline_keyboard[0][0].url, 'https://t.me/frozenblooded/14');

// ---- 4. no photo available → the same caption + button as text -------------
api.forwardMessage = async () => { throw new Error('no photo'); };
api.sendPhoto = async () => { throw new Error('no photo'); };
const texts = [];
api.sendMessage = async (payload) => { texts.push(payload); return { message_id: 1 }; };
// A message with a URL button is upgraded to a rich message by the API proxy.
api.sendRichMessage = async (payload) => { texts.push(payload); return { message_id: 1 }; };
assert.equal(await sendJiraiyaDiscovery(USER, -100777), true);
assert.equal(texts.length, 1);
assert.equal(texts[0].chat_id, USER.id, 'text fallback still goes to the DM');
const fallbackText = texts[0].text || texts[0].rich_message?.html || '';
assert.match(fallbackText, /ʏᴏᴜ ꜱᴘᴏᴛᴛᴇᴅ ᴍᴀꜱᴛᴇʀ ᴊɪʀᴀɪʏᴀ/);
assert.match(fallbackText, /<span class="tg-spoiler">ʀᴇꜱᴇᴀʀᴄʜ<\/span>/);
assert.match(fallbackText, /https:\/\/t\.me\/frozenblooded\/14/, 'the ability button survives the fallback');

// ---- 5. a real Naruto patrol awards Jiraiya and announces him --------------
api.forwardMessage = async () => ({ message_id: 79, photo: [{ file_id: 'JIRAIYA_PHOTO' }] });
const announced = [];
api.sendPhoto = async (payload) => { announced.push(payload); return { message_id: 1 }; };

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
assert.equal(announced.length, 1, 'exactly one discovery announcement');
assert.equal(announced[0].chat_id, HERO, 'DM');
assert.match(announced[0].caption, /<span class="tg-spoiler">ʀᴇꜱᴇᴀʀᴄʜ<\/span>/);
assert.equal(announced[0].reply_markup.inline_keyboard[0][0].url, 'https://t.me/frozenblooded/14');
const owned = await db.get(sql`
  SELECT qty FROM inventory WHERE telegram_id = ${HERO} AND item_name = 'Jiraiya'
`);
assert.equal(Number(owned.qty), 1, 'Jiraiya is in the roster');

// Settling again never announces twice.
const again = await settleOwn({ id: HERO });
assert.deepEqual(again.blocks, []);
assert.equal(announced.length, 1, 'the announcement is sent once');

console.log('jiraiya discovery: OK');
