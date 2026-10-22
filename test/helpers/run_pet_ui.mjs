import assert from 'node:assert/strict';
import { db, sql } from './sdk_db_stub.mjs';
import { api } from 'sdk';
import {
  buyPet, equipPet, ensurePetSchema, feedPet, startPetActivity,
} from '../../tgcloud/lib/pet/store.js';
import {
  petStoreContent, petDetailContent, petStatsContent, petFoodContent, petListContent,
  petStoreKeyboard, petDetailKeyboard, startResultText, completionText,
  handlePetCallback, petStatusText, shinobiPickerKeyboard, handlePetCommand,
} from '../../tgcloud/lib/pet/ui.js';
import {
  STORE_INSTRUCTION, PET_ABILITY_URL, NO_PETS_TEXT, PET_NOT_FOUND_TEXT,
  WRONG_OWNER_TEXT, STALE_MENU_TEXT, buySuccessText, insufficientCoinsText,
  alreadyOwnedText, ITEM_NOT_FOUND_TEXT, equipSuccessText, notOwnedText,
  feedSuccessText, feedInsufficientText, petFullEnergyText, petCannotEatText,
  playStartedText, playCompleteText, trainStartedText, trainCompleteText,
  restStartedText, restCompleteText, restRequiredText, alreadyReadyText,
  progressDots, timeLeftText, DUPLICATE_SESSION_TEXT,
} from '../../tgcloud/lib/pet/text.js';
import { PET_XP_THRESHOLDS } from '../../tgcloud/lib/pet/defs.js';
import { style } from '../../tgcloud/lib/texts.js';

const U = 501;
const OTHER = 502;
const now = () => Math.floor(Date.now() / 1000);

const buttonsOf = (blocks) => blocks.filter((b) => b?.type === 'buttons')
  .flatMap((b) => b.buttons || []);
const textOf = (blocks) => blocks.map((b) => {
  if (typeof b?.text === 'string') return b.text;
  if (Array.isArray(b?.cells)) return b.cells.flat().map((c) => c?.text ?? '').join(' | ');
  if (Array.isArray(b?.blocks)) return textOf(b.blocks);
  return '';
}).join('\n');
const labels = (blocks) => buttonsOf(blocks).map((b) => b.text);

const answers = [];
api.answerCallbackQuery = async (payload) => { answers.push(payload); };
api.editMessageText = async () => ({});
api.editMessageCaption = async () => ({});
const sent = [];
api.sendMessage = async (payload) => { sent.push(payload); return { message_id: sent.length }; };
api.sendRichMessage = async (payload) => { sent.push(payload); return { message_id: sent.length }; };

await ensurePetSchema();
await db.run(sql`INSERT INTO users (telegram_id, balance, first_name) VALUES (${U}, 200000, 'Tester')`);
await db.run(sql`INSERT INTO users (telegram_id, balance, first_name) VALUES (${OTHER}, 200000, 'Other')`);
await db.run(sql`INSERT INTO inventory (telegram_id, item_type, item_name, qty) VALUES (${U}, 'shinobi', 'Starter Shinobi', 1)`);
await db.run(sql`INSERT INTO inventory (telegram_id, item_type, item_name, qty) VALUES (${U}, 'shinobi', 'Sasuke', 1)`);

// ---- empty collection ----
const empty = await petListContent({ id: OTHER });
assert.ok(empty.some((b) => b.type === 'paragraph' && b.text.includes(NO_PETS_TEXT.split('\n')[0])));

// ---- store: exact instruction, exactly two action rows ----
await buyPet(U, 'axofly', 'ui-buy');
await equipPet(U, 'axofly');
const store = await petStoreContent({ id: U });
const storeText = textOf(store);
assert.ok(storeText.includes(STORE_INSTRUCTION), 'store instruction is the requested line');
assert.ok(storeText.includes('ʙᴜʏ ᴡɪᴛʜ: "/buy ᴘᴇᴛ ɴᴀᴍᴇ" ᴇǫᴜɪᴘ ᴡɪᴛʜ: /equip ᴘᴇᴛ ɴᴀᴍᴇ'),
  'the instruction renders exactly as sent');
assert.ok(storeText.includes(style('Axofly')) && storeText.includes(style('Capycorn')));
assert.ok(storeText.includes('30,000') && storeText.includes('40,000'));
const storeButtons = buttonsOf(store);
assert.deepEqual(storeButtons.map((b) => b.text),
  ['Pet 🍖 food', 'Pet abilities', '⬅️ Back'].map((t) => style(t)));
assert.equal(storeButtons[0].callback_data, `pet_food_menu:${U}`);
assert.equal(storeButtons[1].url, PET_ABILITY_URL);
assert.equal(storeButtons[2].callback_data, `pet_menu:${U}`);
assert.equal(storeButtons.filter((b) => b.callback_data?.startsWith('pet_buy')).length, 0, 'no purchase buttons');
assert.equal(storeButtons[1].url, 'https://t.me/frozenblooded/23', 'clean Telegram URL, no emoji in the URL');

// ---- store keyboard used by the map: same two rows ----
const mapStoreRows = (await petStoreKeyboard(U)).inline_keyboard;
assert.equal(mapStoreRows.length, 2);
assert.deepEqual(mapStoreRows[0].map((b) => b.text), ['Pet 🍖 food', 'Pet abilities']);
assert.deepEqual(mapStoreRows[1].map((b) => b.text), ['⬅️ Back']);
assert.equal(mapStoreRows[1][0].callback_data, `map_loc_store:${U}`);

// ---- detail menu: READY pet ----
let pet = (await petStatsContent.length) ? null : null;
const { listPets } = await import('../../tgcloud/lib/pet/store.js');
pet = (await listPets(U)).find((p) => p.petId === 'axofly');
const detail = await petDetailContent({ id: U }, pet);
const detailLabels = labels(detail);
for (const label of ['🍖 Feed', '🎾 Play', '🏋️ Train', '📊 Pet stats', '🕸️ Pet abilities', '⬅️ Back']) {
  assert.ok(detailLabels.includes(style(label)), `${label} missing from the pet menu`);
}
assert.ok(!detailLabels.includes(style('😴 Rest')), 'Rest is hidden while the pet is ready');
const detailUrls = buttonsOf(detail).filter((b) => b.url).map((b) => b.url);
assert.deepEqual(detailUrls, [PET_ABILITY_URL]);
for (const b of buttonsOf(detail)) {
  if (!b.callback_data) continue;
  assert.match(b.callback_data, new RegExp(`:${U}(:|\$)`), 'every callback carries the opener id');
}
assert.match(textOf(detail), /ʟᴇᴠᴇʟ 1\/5/);

// ---- exhausted pet: only Rest is offered ----
await db.run(sql`UPDATE user_pets SET exhausted = 1 WHERE telegram_id = ${U} AND pet_id = 'axofly'`);
pet = (await listPets(U)).find((p) => p.petId === 'axofly');
const exhausted = await petDetailContent({ id: U }, pet);
assert.ok(labels(exhausted).includes(style('😴 Rest')));
assert.ok(!labels(exhausted).includes(style('🎾 Play')));
assert.ok(textOf(exhausted).includes('ʀᴇꜱᴛ ꜱᴇꜱꜱɪᴏɴ'));
assert.ok(textOf(exhausted).includes(style('EXHAUSTED')));

// ---- playing pet: no activity buttons, status shows time left ----
await db.run(sql`UPDATE user_pets SET exhausted = 0 WHERE telegram_id = ${U} AND pet_id = 'axofly'`);
assert.equal((await startPetActivity(U, 'axofly', 'play', { shinobi: 'Starter Shinobi' })).code, 'ok');
pet = (await listPets(U)).find((p) => p.petId === 'axofly');
assert.equal(pet.status, 'PLAYING');
assert.match(petStatusText(pet), /ᴘʟᴀʏɪɴɢ · \d+m/);
const playing = await petDetailContent({ id: U }, pet);
assert.ok(!labels(playing).includes(style('🍖 Feed')));
assert.ok(!labels(playing).includes(style('🏋️ Train')));
assert.ok(labels(playing).includes(style('📊 Pet stats')));
await db.run(sql`DELETE FROM pet_activity WHERE telegram_id = ${U}`);
await db.run(sql`UPDATE activities SET status = 'idle', partner_pet = NULL WHERE telegram_id = ${U}`);
await db.run(sql`UPDATE user_pets SET exhausted = 1 WHERE telegram_id = ${U} AND pet_id = 'axofly'`);

// ---- resting pet: wake button ----
assert.equal((await startPetActivity(U, 'axofly', 'rest')).code, 'ok');
pet = (await listPets(U)).find((p) => p.petId === 'axofly');
const resting = await petDetailContent({ id: U }, pet);
assert.ok(labels(resting).includes(style('☀️ Wake Pet')));
assert.ok(!labels(resting).includes(style('😴 Rest')));
await db.run(sql`DELETE FROM pet_activity WHERE telegram_id = ${U}`);
await db.run(sql`UPDATE user_pets SET exhausted = 0, energy = 40 WHERE telegram_id = ${U} AND pet_id = 'axofly'`);

// ---- stats screen ----
pet = (await listPets(U)).find((p) => p.petId === 'axofly');
const stats = await petStatsContent({ id: U }, pet);
const statsText = textOf(stats);
for (const needle of ['𝐏𝐄𝐓 𝐒𝐓𝐀𝐓𝐒', 'ʟᴇᴠᴇʟ 1/5', '⚡', 'ᴇɴᴇʀɢʏ', 'xᴘ', 'ꜱᴛᴀᴛᴜꜱ', 'ᴛᴏᴛᴀʟ xᴘ ᴇᴀʀɴᴇᴅ', '𝐅𝐋𝐔𝐓𝐓ᴇʀ 𝐅ᴏʀᴛᴜɴᴇ']) {
  assert.ok(statsText.includes(needle), `stats missing ${needle}`);
}
assert.ok(!statsText.includes('𝐑𝐎𝐘𝐀𝐋 𝐏𝐀𝐂𝐄'), "Axofly never shows Capycorn's ability");

await buyPet(U, 'capycorn', 'ui-buy-2');
// Level 2 (1,000–2,999 XP) → Royal Pace −4% duration / −3% cooldown.
await db.run(sql`UPDATE user_pets SET xp = 2000 WHERE telegram_id = ${U} AND pet_id = 'capycorn'`);
const capy = (await listPets(U)).find((p) => p.petId === 'capycorn');
const capyStats = textOf(await petStatsContent({ id: U }, capy));
for (const needle of [style('𝐑𝐎𝐘𝐀𝐋 𝐏𝐀𝐂𝐄'), style('Mission & Patrol duration: −4%'),
  style('Mission & Patrol cooldown: −3%')]) {
  assert.ok(capyStats.includes(needle), `Capycorn stats missing ${needle}`);
}
assert.ok(!capyStats.includes('𝐅𝐋𝐔𝐓𝐓ᴇʀ 𝐅ᴏʀᴛᴜɴᴇ'));

// ---- food menu ----
const food = await petFoodContent({ id: U }, 'axofly');
assert.ok(textOf(food).includes('ᴄʜᴏᴏꜱᴇ ꜰᴏᴏᴅ ꜰᴏʀ'));
for (const foodKey of ['ninja_meal', 'chakra_treat', 'feast']) {
  assert.ok(buttonsOf(food).some((b) => b.callback_data === `pet_food:${U}:axofly:${foodKey}`), foodKey);
}
assert.equal(buttonsOf(food).find((b) => b.text.includes('ʙᴀᴄᴋ')).callback_data, `pet_me:${U}:axofly`);

// ---- start / completion dialogue catalogue ----
assert.equal(startResultText({ code: 'ok', shinobi: 'Starter Shinobi', pet: { name: 'Fluffy' } }, 'play'),
  playStartedText('Fluffy', 'Starter Shinobi', 30));
assert.equal(startResultText({ code: 'ok', pet: { name: 'Fluffy' } }, 'train'), trainStartedText('Fluffy', 2));
assert.equal(startResultText({ code: 'ok', pet: { name: 'Fluffy' } }, 'rest'), restStartedText('Fluffy', 30));
assert.equal(startResultText({ code: 'busy', pet: { name: 'Fluffy' } }, 'play'), DUPLICATE_SESSION_TEXT);
assert.equal(startResultText({ code: 'rest_required', pet: { name: 'Fluffy' } }, 'train'), restRequiredText('Fluffy'));
assert.equal(startResultText({ code: 'not_exhausted', pet: { name: 'Fluffy' } }, 'rest'), alreadyReadyText('Fluffy'));

const playDone = completionText({
  activityType: 'play', petName: 'Fluffy', shinobiName: 'Starter Shinobi', xp: 75,
  levelUp: false, totalXp: 0, maxLevel: false,
});
assert.ok(playDone.includes('ᴘʟᴀʏᴛɪᴍᴇ ᴄᴏᴍᴘʟᴇᴛᴇ'));
assert.ok(playDone.includes('✨ ᴘᴇᴛ xᴘ: +75'));
assert.ok(playDone.includes('ᴇxʜᴀᴜꜱᴛᴇᴅ'));
const trainDone = completionText({
  activityType: 'train', petName: 'Fluffy', xp: 150, levelUp: true, level: 2,
  totalXp: 1000, maxLevel: false,
});
assert.equal(trainDone, trainCompleteText('Fluffy', 150, `\n${'🎉 ʟᴇᴠᴇʟ ᴜᴘ!\n🐾 Fluffy ʀᴇᴀᴄʜᴇᴅ ʟᴇᴠᴇʟ 2!\n✨ ᴛᴏᴛᴀʟ xᴘ: 1000'}`));
assert.equal(completionText({ activityType: 'rest', petName: 'Fluffy' }), restCompleteText('Fluffy', 100, 100));

// ---- purchase / equip dialogues ----
assert.equal(buySuccessText('Axofly'), '🎉 ʏᴏᴜ ʙᴏᴜɢʜᴛ Axofly!');
assert.equal(insufficientCoinsText('30,000', '1,000'),
  '🍥 ɴᴏᴛ ᴇɴᴏᴜɢʜ ᴋᴏɴᴏʜᴀ ᴄᴏɪɴꜱ.\nʀᴇQᴜɪʀᴇᴅ: 30,000 · ʙᴀʟᴀɴᴄᴇ: 1,000');
assert.equal(alreadyOwnedText('Axofly'), '⚠️ ʏᴏᴜ ᴀʟʀᴇᴀᴅʏ ᴏᴡɴ Axofly.');
assert.match(ITEM_NOT_FOUND_TEXT, /ɪᴛᴇᴍ ɴᴏᴛ ꜰᴏᴜɴᴅ/);
assert.equal(equipSuccessText('Axofly'), '✅ Axofly ɪꜱ ɴᴏᴡ ᴇQᴜɪᴘᴘᴇᴅ.');
assert.equal(notOwnedText('Capycorn'), "❌ ʏᴏᴜ ᴅᴏɴ'ᴛ ᴏᴡɴ Capycorn.");
assert.equal(feedSuccessText('Fluffy', 'Ninja Pet Meal', 40, 50, 100),
  '🍖 Fluffy ᴇɴᴊᴏʏᴇᴅ Ninja Pet Meal!\n⚡ ᴇɴᴇʀɢʏ: 40 → 50\n✨ ᴘᴇᴛ xᴘ: +100');
assert.match(feedInsufficientText('Ichiraku Feast', '2,000', '10'), /🍥/);
assert.equal(petFullEnergyText('Fluffy'), '⚡ Fluffy ɪꜱ ᴀʟʀᴇᴀᴅʏ ᴀᴛ ꜰᴜʟʟ ᴇɴᴇʀɢʏ.');
assert.ok(petCannotEatText('Fluffy', 'PLAYING').includes('⚡') === false);

// ---- progress dots reset per level and fill at max ----
assert.equal(progressDots(0, 1, PET_XP_THRESHOLDS, 5), '○○○○○');
assert.equal(progressDots(1000, 2, PET_XP_THRESHOLDS, 5), '○○○○○');
assert.equal(progressDots(2999, 2, PET_XP_THRESHOLDS, 5), '●●●●●');
assert.equal(progressDots(15000, 5, PET_XP_THRESHOLDS, 5), '●●●●●');
assert.equal(progressDots(500, 1, PET_XP_THRESHOLDS, 5), '●●●○○');
assert.equal(progressDots(1999, 1, PET_XP_THRESHOLDS, 5), '●●●●●');
assert.equal(timeLeftText(0), '0s');
assert.equal(timeLeftText(90), '2m');
assert.equal(timeLeftText(3600), '1h');
assert.equal(timeLeftText(3650), '1h 1m');

// ---- callback guards: foreign owner, unknown pet, stale action ----
answers.length = 0;
const foreign = await handlePetCallback({
  id: 'cb-1', from: { id: OTHER }, data: `pet_menu:${U}`,
  message: { chat: { id: 1 }, message_id: 2 },
});
assert.equal(foreign, true);
assert.equal(answers.at(-1).text, WRONG_OWNER_TEXT);
assert.equal(answers.at(-1).show_alert, true);

answers.length = 0;
const missing = await handlePetCallback({
  id: 'cb-2', from: { id: U }, data: `pet_me:${U}:dragon`,
  message: { chat: { id: 1 }, message_id: 2 },
});
assert.equal(missing, true);
assert.equal(answers.at(-1).text, PET_NOT_FOUND_TEXT);

answers.length = 0;
const stale = await handlePetCallback({
  id: 'cb-3', from: { id: U }, data: `pet_something_old:${U}`,
  message: { chat: { id: 1 }, message_id: 2 },
});
assert.equal(stale, true);
assert.equal(answers.at(-1).text, STALE_MENU_TEXT);

// Ownership tampering with a real pet id but someone else's account.
answers.length = 0;
await handlePetCallback({
  id: 'cb-4', from: { id: OTHER }, data: `pet_me:${U}:axofly`,
  message: { chat: { id: 1 }, message_id: 2 },
});
assert.equal(answers.at(-1).text, WRONG_OWNER_TEXT);

// A real callback from the owner renders the pet menu.
answers.length = 0;
await handlePetCallback({
  id: 'cb-5', from: { id: U }, data: `pet_menu:${U}`,
  message: { chat: { id: 1 }, message_id: 2 },
});
assert.equal(answers.at(-1).text, undefined);

// ---- keyboard callback data stays within Telegram's 64-byte limit ----
for (const blocks of [store, detail, exhausted, playing, resting, food]) {
  for (const b of buttonsOf(blocks)) {
    if (!b.callback_data) continue;
    assert.ok(Buffer.byteLength(b.callback_data) <= 64, `${b.callback_data} is too long`);
  }
}
const mapDetail = await petDetailKeyboard(U, 'axofly', { pet: { ...pet, equipped: true, status: 'RESTING' } });
assert.ok(mapDetail.inline_keyboard.flat().some((b) => b.callback_data === `map_pet_wake:axofly:${U}`),
  'map wake callback is pet-first and owned by the last segment');

const picker = await shinobiPickerKeyboard(U, 'play', { petId: 'axofly' });
const starts = picker.inline_keyboard.flat().filter((b) => b.callback_data?.startsWith('map_pet_start:'));
assert.ok(starts.length > 0);
for (const b of starts) {
  const parts = b.callback_data.split(':');
  assert.equal(parts[0], 'map_pet_start');
  assert.equal(parts[1], String(U), 'owner id is the second segment');
  assert.equal(parts[2], 'play');
  assert.equal(parts[3], 'axofly');
  assert.ok(parts.slice(4).join(':').length > 0, 'shinobi name is the tail');
}
// Even without a pet id the callback keeps the legacy shape the handler parses.
const bare = await shinobiPickerKeyboard(U, 'train', null);
for (const b of bare.inline_keyboard.flat()) {
  if (!b.callback_data?.startsWith('map_pet_start:')) continue;
  assert.equal(b.callback_data.split(':').slice(3).join(':').includes('::'), false);
}
for (const row of mapDetail.inline_keyboard) {
  for (const b of row) {
    if (!b.callback_data) continue;
    assert.ok(Buffer.byteLength(b.callback_data) <= 64, `${b.callback_data} is too long`);
  }
}

// ---- /pet command paths (store, me, stats, help, play picker) ----
const message = (text) => ({
  text, message_id: 21, chat: { id: U, type: 'private' }, from: { id: U, first_name: 'Tester' },
});
const command = async (text) => {
  const before = sent.length;
  assert.equal(await handlePetCommand(message(text)), true, text);
  assert.ok(sent.length > before, `${text} produced a reply`);
  return sent.at(-1);
};

const storeReply = await command('/pet_store');
const storeReplyText = (storeReply.rich_message?.blocks || [])
  .map((b) => b.text).filter(Boolean).join('\n');
assert.ok(storeReplyText.includes(STORE_INSTRUCTION),
  `store command shows the instruction verbatim: ${JSON.stringify(storeReplyText)}`);
const storeReplyButtons = (storeReply.rich_message?.blocks || [])
  .filter((b) => b.type === 'buttons').flatMap((b) => b.buttons);
assert.deepEqual(storeReplyButtons.map((b) => b.text),
  ['Pet 🍖 food', 'Pet abilities', '⬅️ Back'].map((t) => style(t)));
assert.equal(storeReplyButtons.find((b) => b.url).url, PET_ABILITY_URL);

const meReply = await command('/pet me');
const meButtons = (meReply.rich_message?.blocks || [])
  .filter((b) => b.type === 'buttons').flatMap((b) => b.buttons.map((x) => x.text));
assert.ok(meButtons.includes(style('📊 Pet stats')));
assert.ok(meButtons.includes(style('🕸️ Pet abilities')));

await command('/pet stats');
await command('/pet help');
await command('/pet play');
await command('/pet store');
await command('/pet food');
await command('/pet ability');
await command('/pet_rename');
assert.equal(await handlePetCommand({ ...message('hello'), text: 'hello' }), false);

// /pet play while exhausted explains the rest requirement instead of throwing.
await db.run(sql`UPDATE user_pets SET exhausted = 1 WHERE telegram_id = ${U} AND pet_id = 'axofly'`);
const exhaustedReply = await command('/pet play');
// Outgoing plain text is small-capped by the message style layer.
assert.equal(exhaustedReply.text, style(restRequiredText('Axofly')),
  'exhausted pet is told to rest');
await db.run(sql`UPDATE user_pets SET exhausted = 0 WHERE telegram_id = ${U} AND pet_id = 'axofly'`);

console.log('pet ui integration: OK');
