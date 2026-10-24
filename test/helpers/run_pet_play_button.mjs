// The pet CARD is a rich message carrying the pet photo. Telegram refuses to
// turn a media message into a text message (editMessageText answers 400), so
// every screen opened from the card must keep the same photo in place.
// Regression: the 🎾 Play button answered the callback but rendered nothing.
import assert from 'node:assert/strict';
import { db, sql } from './sdk_db_stub.mjs';
import { api as sdkApi, BotApiError } from 'sdk';

const FILE_ID = 'AQAD_pet_photo_540';
const edits = [];
const answers = [];
const fresh = [];

// Emulate Telegram: a photo message rejects text/caption edits and rich edits
// that drop the media, but accepts another media-bearing rich message.
let currentIsMedia = true;
const mediaEditError = () => {
  const e = new BotApiError('Bad Request: there is no text in the message to edit');
  e.code = 400;
  return e;
};
sdkApi.answerCallbackQuery = async (p) => { answers.push(p); return true; };
sdkApi.editMessageText = async (p) => {
  const rich = p.rich_message;
  if (currentIsMedia) {
    if (!rich || !Array.isArray(rich.media) || !rich.media.length) throw mediaEditError();
  }
  if (p.text) throw mediaEditError();
  edits.push(p);
  return true;
};
sdkApi.editMessageCaption = async (p) => {
  if (currentIsMedia) throw mediaEditError();
  edits.push({ caption: p.caption });
  return true;
};
sdkApi.sendRichMessage = async (p) => { fresh.push(p); return { message_id: 3 }; };
sdkApi.sendMessage = async (p) => { fresh.push(p); return { message_id: 4 }; };

const { ensurePetSchema } = await import('../../tgcloud/lib/pet/store.js');
const { handlePetCallback } = await import('../../tgcloud/lib/pet/ui.js');

await ensurePetSchema();
await db.run(sql.raw(`CREATE TABLE IF NOT EXISTS map_media_cache (
  storage_message_id INTEGER PRIMARY KEY, file_id TEXT
)`));
// The card photo resolves from the storage-channel cache (no network needed).
await db.run(sql`INSERT OR REPLACE INTO map_media_cache (storage_message_id, file_id) VALUES (540, ${FILE_ID})`);

const U = 5151;
await db.run(sql`INSERT INTO users (telegram_id, balance, xp, first_name, equipped)
  VALUES (${U}, 50000, 0, 'Tester', 'Naruto')`);
await db.run(sql`INSERT INTO inventory (telegram_id, item_type, item_name, qty)
  VALUES (${U}, 'shinobi', 'Naruto', 1)`);
await db.run(sql`INSERT INTO user_pets (telegram_id, pet_id, pet_name, xp, energy, last_energy_at, equipped, acquired_at)
  VALUES (${U}, 'axofly', 'Flappy', 0, 100, ${Math.floor(Date.now() / 1000)}, 1, 0)`);
await db.run(sql`INSERT INTO equipped_pet (telegram_id, pet_id, updated_at) VALUES (${U}, 'axofly', 0)`);

const cb = (data) => ({
  id: 'cb-play', data, from: { id: U, first_name: 'Tester' },
  message: { message_id: 77, chat: { id: U, type: 'private' } },
});

const buttonsOf = (payload) => {
  const html = payload?.rich_message?.html || '';
  return [...html.matchAll(/<tg-button[^>]*data="([^"]*)"[^>]*>([^<]*)<\/tg-button>/g)]
    .map((m) => ({ data: m[1], text: m[2] }));
};

// ---- 🎾 Play must open the shinobi picker on the same (photo) message --------
edits.length = 0;
answers.length = 0;
fresh.length = 0;
await handlePetCallback(cb(`pet_play:${U}:axofly`));

assert.equal(answers.length, 1, 'the callback is acknowledged');
const picker = edits.at(-1);
assert.ok(picker, 'the Play screen is edited in place, not dropped');
assert.ok(Array.isArray(picker.rich_message.media) && picker.rich_message.media.length,
  'the picker keeps the pet photo, so the media message can be edited');
assert.equal(picker.rich_message.media[0].media.media, FILE_ID);
assert.match(picker.rich_message.html, /ꜱʜɪɴᴏʙɪ/);
const pickerButtons = buttonsOf(picker);
assert.ok(pickerButtons.some((b) => b.data === `pet_start:${U}:axofly:play:Naruto`),
  'the shinobi picker offers a Play start button');
assert.ok(pickerButtons.some((b) => b.data === `pet_me:${U}:axofly`));
assert.equal(fresh.length, 0, 'no duplicate message for a normal in-place edit');

// ---- Picking the shinobi starts the session for real ------------------------
edits.length = 0;
answers.length = 0;
await handlePetCallback(cb(`pet_start:${U}:axofly:play:Naruto`));
const started = await db.get(sql`
  SELECT activity_type, status, shinobi_name FROM pet_activity WHERE telegram_id = ${U} AND pet_id = 'axofly'
`);
assert.equal(started.activity_type, 'play');
assert.equal(started.status, 'active');
assert.equal(started.shinobi_name, 'Naruto');
assert.ok(answers.at(-1).text, 'a confirmation toast is shown');
const card = edits.at(-1);
assert.ok(card?.rich_message?.media?.length, 'the card is re-rendered with its photo');

// ---- When even the media edit fails, the screen is opened as a new message --
currentIsMedia = false;
edits.length = 0;
fresh.length = 0;
const fallbackDb = await db.get(sql`SELECT pet_id FROM user_pets WHERE telegram_id = ${U}`);
assert.equal(fallbackDb.pet_id, 'axofly');
// Force every in-place edit to fail for this message only.
sdkApi.editMessageText = async () => { throw mediaEditError(); };
sdkApi.editMessageCaption = async () => { throw mediaEditError(); };
await handlePetCallback(cb(`pet_stats:${U}:axofly`));
assert.equal(fresh.length, 1, 'the tap is never silent: a fresh screen is sent');
assert.match(JSON.stringify(fresh[0]), /pet_me:5151:axofly/);

console.log('pet play button: OK');
