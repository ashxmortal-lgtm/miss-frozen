// The 🎾 Play button must always produce a visible result, even when the
// shinobi availability check or the message edit fails. Regression: an error
// after the callback was acknowledged left the tap completely silent.
import assert from 'node:assert/strict';
import { db, sql } from './sdk_db_stub.mjs';
import { api as sdkApi, BotApiError } from 'sdk';

const edits = [];
const sends = [];
const answers = [];

const badRequest = (text) => {
  const e = new BotApiError(text);
  e.code = 400;
  return e;
};

sdkApi.answerCallbackQuery = async (p) => { answers.push(p); return true; };
sdkApi.editMessageText = async (p) => { edits.push(p); return true; };
sdkApi.editMessageCaption = async (p) => { edits.push({ caption: p.caption }); return true; };
sdkApi.sendRichMessage = async (p) => { sends.push(p); return { message_id: 91 }; };
sdkApi.sendMessage = async (p) => { sends.push(p); return { message_id: 92 }; };

const { ensurePetSchema, shinobiAvailability } = await import('../../tgcloud/lib/pet/store.js');
const { handlePetCallback } = await import('../../tgcloud/lib/pet/ui.js');

await ensurePetSchema();
const U = 5252;
await db.run(sql`INSERT INTO users (telegram_id, balance, xp, first_name, equipped)
  VALUES (${U}, 50000, 0, 'Tester', 'Naruto')`);
await db.run(sql`INSERT INTO inventory (telegram_id, item_type, item_name, qty)
  VALUES (${U}, 'shinobi', 'Naruto', 1)`);
await db.run(sql`INSERT INTO user_pets (telegram_id, pet_id, pet_name, xp, energy, last_energy_at, equipped, acquired_at)
  VALUES (${U}, 'axofly', 'Flappy', 0, 100, ${Math.floor(Date.now() / 1000)}, 1, 0)`);
await db.run(sql`INSERT INTO equipped_pet (telegram_id, pet_id, updated_at) VALUES (${U}, 'axofly', 0)`);

const cb = (data) => ({
  id: 'cb-res', data, from: { id: U, first_name: 'Tester' },
  message: { message_id: 55, chat: { id: U, type: 'private' } },
});
const htmlOf = (payload) => payload?.rich_message?.html || payload?.rich_message?.blocks
  ? JSON.stringify(payload.rich_message) : (payload?.text || '');
const lastHtml = () => htmlOf(edits.at(-1) || sends.at(-1));
const reset = () => { edits.length = 0; sends.length = 0; answers.length = 0; };

// ---- 1. a broken/partial database must not silence Play ---------------------
// (worst case: the activities table is missing entirely in this process)
await db.run(sql.raw('DROP TABLE activities'));
reset();
await handlePetCallback(cb(`pet_play:${U}:axofly`));
assert.equal(answers.length, 1, 'the tap is acknowledged');
assert.equal(edits.length, 1, 'the picker is still rendered');
assert.match(lastHtml(), /pet_start:5252:axofly:play:Naruto/,
  'the shinobi is offered even when the availability check fails');
assert.equal(sends.length, 0, 'no extra message needed');

// ---- 2. a stale pet lock is repaired, the shinobi is offered ---------------
await db.run(sql.raw(`CREATE TABLE activities (
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
const t = Math.floor(Date.now() / 1000);
await db.run(sql`
  INSERT INTO activities (telegram_id, shinobi, kind, status, started_at, ends_at, partner_pet)
  VALUES (${U}, 'Naruto', 'pet', 'active', ${t - 3000}, ${t - 100}, 'axofly')
`);
assert.equal(await shinobiAvailability(U, 'Naruto'), null,
  'a stale pet lock never blocks Play');
const freed = await db.get(sql`SELECT status, partner_pet FROM activities WHERE telegram_id = ${U} AND shinobi = 'Naruto'`);
assert.equal(freed.status, 'idle');
assert.equal(freed.partner_pet, null);

// ---- 3. if every edit is refused, the tap still shows something ------------
sdkApi.editMessageText = async () => { throw badRequest('Bad Request: there is no text in the message to edit'); };
sdkApi.editMessageCaption = async () => { throw badRequest('Bad Request: message cannot be edited'); };
reset();
await handlePetCallback(cb(`pet_play:${U}:axofly`));
assert.equal(answers.length, 1, 'acknowledged');
assert.equal(sends.length >= 1, true, 'the screen is sent as a new message instead of silence');
assert.match(JSON.stringify(sends.at(-1)), /pet_start:5252:axofly:play:Naruto/);

// ---- 4. an exploding handler reports instead of vanishing ------------------
const { handlePetCallback: _keep } = await import('../../tgcloud/lib/pet/ui.js');
assert.equal(typeof _keep, 'function');
// `pet_play` on a pet that does not exist answers with the not-found toast.
reset();
sdkApi.editMessageText = async (p) => { edits.push(p); return true; };
await handlePetCallback(cb(`pet_play:${U}:nopet`));
assert.equal(answers.length >= 1, true, 'unknown pet ids still answer');
assert.ok(answers[0].text, 'with a visible explanation');

console.log('pet play resilience: OK');
