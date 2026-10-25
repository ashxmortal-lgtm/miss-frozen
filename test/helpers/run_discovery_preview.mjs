// `/testT` and `/testJ` — owner preview of the Tsunade and Jiraiya discovery
// messages. They must send the real message (same caption / photo / rich
// button) without granting anything or touching player state.
import assert from 'node:assert/strict';
import { api } from 'sdk';
import { db, sql } from './sdk_db_stub.mjs';
import { handleOwnerCommand } from '../../tgcloud/lib/owner_cmds.js';
import { TSUNADE_DISCOVERY_TEXT } from '../../tgcloud/lib/rpg/tsunade.js';
import { jiraiyaDiscoveryCaption } from '../../tgcloud/lib/rpg/jiraiya_discovery.js';
import { OWNER_ID } from '../../tgcloud/lib/config.js';
import { style } from '../../tgcloud/lib/texts.js';

await db.run(sql.raw(`CREATE TABLE IF NOT EXISTS map_media_cache (
  storage_message_id INTEGER PRIMARY KEY,
  file_id TEXT NOT NULL
)`));
await db.run(sql.raw(`CREATE TABLE IF NOT EXISTS shinobi_state (
  telegram_id INTEGER NOT NULL, shinobi TEXT NOT NULL, level INTEGER NOT NULL DEFAULT 1,
  patrol_streak INTEGER NOT NULL DEFAULT 0, exhausted_until INTEGER NOT NULL DEFAULT 0,
  dead_until INTEGER NOT NULL DEFAULT 0, last_robbed_at INTEGER NOT NULL DEFAULT 0,
  train_sessions INTEGER NOT NULL DEFAULT 0, next_train_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (telegram_id, shinobi)
)`));

const rich = [];
const texts = [];
const photos = [];
const forwards = [];
api.sendRichMessage = async (payload) => { rich.push(payload); return { message_id: 500 + rich.length }; };
api.sendMessage = async (payload) => { texts.push(payload); return { message_id: texts.length + 1 }; };
api.sendPhoto = async (payload) => { photos.push(payload); return { message_id: 900 + photos.length }; };
api.forwardMessage = async (payload) => {
  forwards.push(payload);
  return { message_id: 77, photo: [{ file_id: `PHOTO_${payload.message_id}` }] };
};
api.deleteMessage = async () => ({});
api.answerCallbackQuery = async () => ({});

const OWNER = { id: OWNER_ID, first_name: 'Owner', username: 'owner' };
const STRANGER = { id: 777001, first_name: 'Stranger' };
const GROUP = -100555;

const message = (text, from, chat = { id: GROUP, type: 'supergroup', title: 'Leaf' }) => ({
  text,
  message_id: 31,
  chat,
  from,
});

const reset = () => { rich.length = 0; texts.length = 0; photos.length = 0; forwards.length = 0; };

// ---- 1. /testT sends the real Tsunade discovery photo + caption ------------
reset();
assert.equal(await handleOwnerCommand(message('/testT', OWNER)), true);
assert.equal(photos.length, 1, 'one discovery photo');
assert.equal(photos[0].chat_id, GROUP, 'sent in the chat where the owner typed it');
assert.equal(photos[0].photo, 'PHOTO_31', 'the storage-channel Tsunade photo (message 31)');
assert.equal(photos[0].parse_mode, 'HTML');
assert.equal(photos[0].caption, style(TSUNADE_DISCOVERY_TEXT), 'the exact production caption');
assert.equal(rich.length, 0);
assert.equal(texts.length, 0, 'no extra wrapper message');

// ---- 2. /testJ sends the real rich Jiraiya discovery ----------------------
reset();
assert.equal(await handleOwnerCommand(message('/testJ', OWNER)), true);
assert.equal(rich.length, 1, 'one rich discovery message');
assert.equal(rich[0].chat_id, GROUP);
assert.deepEqual(rich[0].rich_message.media, [
  { id: 'jiraiya_photo', media: { type: 'photo', media: 'PHOTO_581' } },
], 'the storage-channel Jiraiya photo (message 581)');
const html = String(rich[0].rich_message.html);
assert.match(html, /<figure><img src="tg:\/\/photo\?id=jiraiya_photo"\/><\/figure>/);
assert.equal((html.match(/<p><br\/><\/p>/g) || []).length, 4, 'the exact blank-line spacing');
assert.match(html, /<tg-button[^>]*type="url"[^>]*url="https:\/\/t\.me\/frozenblooded\/14"/, 'rich ability button');
assert.match(html, new RegExp(style(jiraiyaDiscoveryCaption('')).split('\n').pop().trim().slice(0, 8).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
  'the discovery caption body');
assert.equal(photos.length, 0);

// ---- 3. both commands work from the owner's DM ---------------------------
reset();
const DM = { id: OWNER_ID, type: 'private' };
assert.equal(await handleOwnerCommand(message('/testT', OWNER, DM)), true);
assert.equal(photos.at(-1).chat_id, OWNER_ID, 'DM delivery');
reset();
assert.equal(await handleOwnerCommand(message('/testj', OWNER, DM)), true);
assert.equal(rich.at(-1).chat_id, OWNER_ID, 'lowercase spelling resolves too');

// ---- 4. nothing is granted and no state is written ----------------------
const inv = await db.all(sql`SELECT * FROM inventory WHERE telegram_id = ${OWNER_ID}`);
assert.deepEqual(inv, [], 'no shinobi is added to the owner');
const state = await db.all(sql`SELECT * FROM shinobi_state WHERE telegram_id = ${OWNER_ID}`);
assert.deepEqual(state, [], 'no exhaustion or timer is written');
const users = await db.all(sql`SELECT * FROM users WHERE telegram_id = ${OWNER_ID}`);
assert.deepEqual(users, [], 'no user row is created');

// ---- 5. everyone else is denied, and nothing is sent --------------------
for (const cmd of ['/testT', '/testJ']) {
  reset();
  assert.equal(await handleOwnerCommand(message(cmd, STRANGER)), true, `${cmd} is consumed`);
  assert.equal(rich.length, 1, `${cmd}: one denial card`);
  assert.equal(photos.length, 0, `${cmd}: no discovery photo leaks`);
  const denial = JSON.stringify(rich[0].rich_message.blocks || []);
  assert.match(denial, /⛔/, 'the denial card is shown');
  assert.match(denial, /ᴏᴡɴᴇʀ/, 'it names the owner restriction (small caps)');
}

// ---- 6. the @bot suffix used in groups still resolves -------------------
reset();
assert.equal(await handleOwnerCommand(message('/testT@missfrozen_bot', OWNER)), true);
assert.equal(photos.length, 1, '/testT@bot works in a group');

// ---- 7. unrelated owner commands are untouched --------------------------
assert.equal(await handleOwnerCommand(message('/not_a_command', OWNER)), false);

console.log('discovery preview: OK');
