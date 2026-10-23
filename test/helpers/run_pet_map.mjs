// Drives the pet/map surfaces that changed for the redesign: the BBQ and Hot
// Springs keyboards + captions, the shared rest sessions, and the daily quest
// caption. Runs against the in-memory SDK shims.
import assert from 'node:assert/strict';
import { db, sql } from './sdk_db_stub.mjs';
import {
  ensureRestSchema, startBbq, stopBbq, listBbqSessions, applyBbqRecovery, restingShinobi,
} from '../../tgcloud/lib/map/bbq.js';
import {
  bbqKeyboard, hotspringsKeyboard, ichirakuKeyboard,
  hokageKeyboard, gateKeyboard, storeKeyboard,
} from '../../tgcloud/lib/map/ui.js';
import { MAX_CHAKRA } from '../../tgcloud/lib/map/constants.js';
import { dailyMissionBody } from '../../tgcloud/lib/daily.js';
import { DAILY_TEMPLATES } from '../../tgcloud/lib/daily_defs.js';
import {
  BBQ_CAPTION, HOTSPRINGS_CAPTION, PET_FOOD_CAPTION, PET_FOOD_PRICE_LABEL,
  petCardLines, petNotHungryText, statusWord,
} from '../../tgcloud/lib/pet/text.js';
import { style } from '../../tgcloud/lib/texts.js';

const U = 701;
const now = () => Math.floor(Date.now() / 1000);

const labels = (kb) => kb.inline_keyboard.map((row) => row.map((b) => b.text));
const flat = (kb) => kb.inline_keyboard.flat();

// ---- keyboards: exact requested rows ----
assert.deepEqual(labels(bbqKeyboard(U)), [
  ['🔥 Join BBQ', '🍱 Feed pet'],
  ['⚡ Instant shinobi recovery'],
  ['🎾 Play with pet', '⬅️ Back'],
]);
// Every map button carries an emoji (requested).
for (const [name, kb] of Object.entries({
  bbqKeyboard, hotspringsKeyboard, hokageKeyboard, gateKeyboard, storeKeyboard,
})) {
  for (const button of kb(U).inline_keyboard.flat()) {
    assert.ok(/^[^\w\s]/.test(button.text), `${name}: "${button.text}" has no emoji`);
  }
}
assert.deepEqual(flat(bbqKeyboard(U)).map((b) => b.callback_data), [
  `map_bbq_select:${U}`, `map_pet_feed:${U}`,
  `map_bbq_heal:${U}`,
  `map_pet_play:${U}`, `map_home:${U}`,
]);

assert.deepEqual(labels(hotspringsKeyboard(U)), [
  ['♨️ Relax shinobis', '😴 Rest pet'],
  ['🔄 Recall shinobis', '⬅️ Back'],
]);
assert.deepEqual(labels(hokageKeyboard(U)), [
  ['🏯 Shinobi Mission', '🎯 Daily Quest'],
  ['🎁 Claim All Rewards'],
  ['⬅️ Back'],
]);
assert.deepEqual(labels(gateKeyboard(U)), [
  ['🚀 Send Available on Patrol'],
  ['⬅️ Back'],
]);
assert.deepEqual(labels(storeKeyboard(U)), [
  ['🥷 Shinobi Store', '🎁 Gift Store'],
  ['🐾 Pet Store', '🏠 Property'],
  ['⬅️ Back'],
]);
assert.deepEqual(flat(hotspringsKeyboard(U)).map((b) => b.callback_data), [
  `map_hot_relax:${U}`, `map_pet_rest:${U}`,
  `map_hot_recall:${U}`, `map_home:${U}`,
]);

// Ramen shop still opens the pet food screen.
assert.ok(flat(ichirakuKeyboard(U)).some((b) => b.callback_data === `map_pet_food:${U}`));

// ---- captions ----
assert.deepEqual(BBQ_CAPTION, [
  '🍖 𝐁𝐁𝐐',
  '',
  '⚡ ʀᴇᴄᴏᴠᴇʀ ᴄʜᴀᴋʀᴀ: +20 / 30 ᴍɪɴ',
  '🥷 ꜱᴇɴᴅ ᴜʀ ꜱʜɪɴᴏʙɪ ʜᴇʀᴇ ᴛᴏ ʀᴇᴄᴏᴠᴇʀ ᴄʜᴀᴋʀᴀ ᴏᴠᴇʀ ᴛɪᴍᴇ.',
  '',
  '🍱 ꜰᴇᴇᴅ ᴏʀ ᴘʟᴀʏ ᴡɪᴛʜ ᴜʀ ᴘᴇᴛ ʜᴇʀᴇ!',
]);
assert.equal(HOTSPRINGS_CAPTION[0], '♨️ 𝐇𝐎𝐓 𝐒𝐏𝐑𝐈𝐍𝐆𝐒');
assert.ok(HOTSPRINGS_CAPTION.some((line) => line.includes('ʀᴇʟᴀx ᴜʀ ꜱʜɪɴᴏʙɪ')));
assert.deepEqual(PET_FOOD_PRICE_LABEL, {
  ninja_meal: '500 🍥', chakra_treat: '1,000 🍥', feast: '2,000 🍥',
});
// Requested caption: `➤` title · blank · effect · blank · price per meal.
assert.deepEqual(PET_FOOD_CAPTION, [
  '➤ 🍱 𝐍𝐈𝐍𝐉𝐀 𝐏𝐄𝐓 𝐌𝐄𝐀𝐋', '', '✨ +100 xᴘ · +10 ⚡', '', '💰 500 🍥', '',
  '➤ 🍬 𝐂ʜᴀᴋʀᴀ 𝐓ʀᴇᴀᴛ', '', '✨ +250 xᴘ · +25 ⚡', '', '💰 1,000 🍥', '',
  '➤ 🍜 𝐈ᴄʜɪʀᴀᴋᴜ 𝐅ᴇᴀꜱᴛ', '', '✨ +500 xᴘ · +50 ⚡', '', '💰 2,000 🍥',
]);
assert.equal(PET_FOOD_CAPTION.filter((line) => line.startsWith('➤ ')).length, 3, 'three meals');
assert.equal(PET_FOOD_CAPTION.filter(Boolean).length, 9, 'three meals × three lines');

// ---- pet card lines ----
assert.deepEqual(petCardLines({
  name: 'Fluffy', status: 'TRAINING', statusEndsAt: now() + 3600,
  def: { abilityName: 'Flutter Fortune' },
}), ['Fluffy', '', `Current status: ${statusWord('TRAINING', now() + 3600)}`, '', '✨ Flutter Fortune']);
assert.equal(statusWord('READY'), 'ʀᴇᴀᴅʏ');
assert.match(statusWord('TRAINING', now() + 6912), /ᴛʀᴀɪɴɪɴɢ · 1h 56m/);
assert.equal(statusWord('EXHAUSTED', now() + 600), 'ᴇxʜᴀᴜꜱᴛᴇᴅ');
assert.equal(petNotHungryText('Fluffy'), '🍖 Fluffy ɪꜱ ɴᴏᴛ ʜᴜɴɢʀʏ ʀɪɢʜᴛ ɴᴏᴡ.');

// ---- daily quest caption (pet training mission == the requested example) ----
assert.ok(DAILY_TEMPLATES.pet_training.objective);
for (const t of Object.values(DAILY_TEMPLATES)) assert.ok(t.objective, `${t.id} objective`);
const body = dailyMissionBody({}, {
  missionId: 'pet_training', name: 'Pet Training', rewardCoins: 1500,
  status: 'pending', progress: 0, targetCount: 1,
});
for (const needle of [
  '🗺️ 𝐊𝐎𝐍𝐎𝐇𝐀 𝐌𝐀𝐏',
  '𝐃𝐀𝐈𝐋𝐘 𝐐𝐔𝐄𝐒𝐓',
  '📜 ǫᴜᴇꜱᴛ: Pet Training',
  '🥷 ᴏʙᴊᴇᴄᴛɪᴠᴇ: ᴛʀᴀɪɴ ᴀɴ ᴇʟɪɢɪʙʟᴇ ᴘᴇᴛ ꜱᴜᴄᴄᴇꜱꜱꜰᴜʟʟʏ',
  '🍥 ʀᴇᴡᴀʀᴅ: 1,500 Konoha coins',
  '📊 ꜱᴛᴀᴛᴜꜱ: ᴘᴇɴᴅɪɴɢ',
  '⌛ ᴇxᴘɪʀᴇꜱ: ᴛᴏᴅᴀʏ',
]) {
  assert.ok(body.includes(needle), `daily caption missing ${needle}`);
}
assert.equal(style(body).includes('ᴋᴏɴᴏʜᴀ ᴄᴏɪɴꜱ'), true, 'coins line is styled on the map');
const done = dailyMissionBody({}, {
  missionId: 'pet_training', name: 'Pet Training', rewardCoins: 1500,
  status: 'completed', progress: 1, targetCount: 1,
});
assert.ok(done.includes('📊 ꜱᴛᴀᴛᴜꜱ: ᴄᴏᴍᴘʟᴇᴛᴇᴅ'));

// ---- shared rest sessions: BBQ / Hot Springs, busy until chakra is full ----
await ensureRestSchema();
await db.run(sql`INSERT INTO users (telegram_id, balance, first_name) VALUES (${U}, 0, 'Tester')`);
await db.run(sql`INSERT INTO inventory (telegram_id, item_type, item_name, qty) VALUES (${U}, 'chakra', 'Chakra', 40)`);

assert.equal((await startBbq(U, 'Naruto', 'hotsprings')).code, 'ok');
assert.equal((await listBbqSessions(U, 'hotsprings')).length, 1);
assert.equal((await listBbqSessions(U, 'bbq')).length, 0);
assert.ok((await restingShinobi(U)).has('Naruto'), 'relaxing shinobi count as busy');

assert.equal((await startBbq(U, 'Sasuke', 'bbq')).code, 'ok');
assert.equal((await listBbqSessions(U)).length, 2);

// Recall one; the other keeps recovering.
assert.equal((await stopBbq(U, 'Sasuke')).code, 'ok');
assert.equal((await listBbqSessions(U)).length, 1);
assert.equal((await listBbqSessions(U, 'hotsprings'))[0].shinobi, 'Naruto');

// Catch-up: four intervals of +20 would be 120 — capped at MAX_CHAKRA.
const t = now();
await db.run(sql`UPDATE bbq_sessions SET last_recovery_at = ${t - 7200} WHERE telegram_id = ${U}`);
const granted = await applyBbqRecovery(U);
assert.equal(granted, MAX_CHAKRA - 40);
const chakra = await db.get(sql`SELECT qty FROM inventory WHERE telegram_id = ${U} AND item_name = 'Chakra'`);
assert.equal(chakra.qty, MAX_CHAKRA);
assert.equal((await listBbqSessions(U)).length, 0, 'full chakra frees the shinobi automatically');
assert.equal((await restingShinobi(U)).size, 0);

// Joining with a full pool is refused instead of locking a shinobi forever.
await ensureRestSchema();
assert.equal((await startBbq(U, 'Naruto', 'bbq')).code, 'full');

console.log('pet map integration: OK');
