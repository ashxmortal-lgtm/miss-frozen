// `/buy` and `/equip` replies carry a `Check ❄️ ability` button that opens the
// matching post in the frozenblooded channel (one post per shinobi / pet).
import assert from 'node:assert/strict';
import { db, sql } from './sdk_db_stub.mjs';
import { handleBuy } from '../../tgcloud/lib/buy.js';
import {
  abilityCheckKeyboard, itemAbilityUrl, ABILITY_BUTTON_TEXT, SHINOBI_ABILITY_URLS, ABILITY_URL,
} from '../../tgcloud/lib/ability.js';

// The SDK stub has no query builder; purchase() reads the balance through
// getBalance()'s `db.select().from(users).where(...).get()` shape.
let activeId = null;
db.select = () => ({
  from() { return this; },
  where() { return this; },
  async get() {
    return db.get({ text: 'SELECT * FROM users WHERE telegram_id = ?', params: [activeId] });
  },
});

const BUYER = 7001;
const POOR = 7002;
await db.run(sql`INSERT OR REPLACE INTO users (telegram_id, balance) VALUES (${BUYER}, 80000)`);
await db.run(sql`INSERT OR REPLACE INTO users (telegram_id, balance) VALUES (${POOR}, 10)`);

const handleBuyAs = (id, text, updateId) => { activeId = id; return handleBuy({ id }, text, updateId); };

// ---- 1. the link table -------------------------------------------------------
assert.equal(ABILITY_URL, 'https://t.me/frozenblooded/8', 'the all-abilities post is untouched');
const EXPECTED = {
  Naruto: 'https://t.me/frozenblooded/9',
  Sasuke: 'https://t.me/frozenblooded/10',
  Sakura: 'https://t.me/frozenblooded/11',
  Itachi: 'https://t.me/frozenblooded/12',
  Tsunade: 'https://t.me/frozenblooded/13',
  Jiraiya: 'https://t.me/frozenblooded/14',
  Hinata: 'https://t.me/frozenblooded/15',
  Axofly: 'https://t.me/frozenblooded/26',
  Capycorn: 'https://t.me/frozenblooded/27',
};
for (const [name, url] of Object.entries(EXPECTED)) {
  assert.equal(itemAbilityUrl(name), url, `${name} ability link`);
  assert.equal(itemAbilityUrl(name.toLowerCase()), url, `${name} lookup is case-insensitive`);
}
assert.deepEqual(Object.keys(SHINOBI_ABILITY_URLS).sort(), [
  'Hinata', 'Itachi', 'Jiraiya', 'Naruto', 'Sakura', 'Sasuke', 'Tsunade',
]);

// ---- 2. the button -----------------------------------------------------------
const kb = abilityCheckKeyboard('Naruto');
assert.equal(ABILITY_BUTTON_TEXT, 'Check ❄️ ability');
assert.deepEqual(kb, {
  inline_keyboard: [[{ text: 'Check ❄️ ability', url: 'https://t.me/frozenblooded/9', style: 'success' }]],
});
assert.equal(abilityCheckKeyboard('Mind Transmission Jutsu'), undefined, 'jutsu has no guide post');
assert.equal(abilityCheckKeyboard('Chakra'), undefined);
assert.equal(abilityCheckKeyboard(''), undefined);

// ---- 3. /buy shinobi returns the item so the caller can attach the button ----
const naruto = await handleBuyAs(BUYER, '/buy Naruto', 11);
assert.equal(typeof naruto, 'object');
assert.match(naruto.text, /ᴜɴʟᴏᴄᴋᴇᴅ: Naruto/);
assert.match(naruto.text, /Naruto/);
assert.equal(naruto.ability, 'Naruto');
assert.equal(abilityCheckKeyboard(naruto.ability).inline_keyboard[0][0].url, EXPECTED.Naruto);

const again = await handleBuyAs(BUYER, '/buy Naruto', 12);
assert.equal(typeof again, 'object', 'already recruited still offers the ability post');
assert.equal(again.ability, 'Naruto');
assert.match(again.text, /𝐀𝐋𝐑𝐄𝐀𝐃𝐘 𝐑𝐄𝐂𝐑ᴜ𝐈𝐓𝐄𝐃/);

// ---- 4. /buy pet -------------------------------------------------------------
const axofly = await handleBuyAs(BUYER, '/buy Axofly', 13);
assert.equal(typeof axofly, 'object');
assert.equal(axofly.ability, 'Axofly');
assert.equal(abilityCheckKeyboard(axofly.ability).inline_keyboard[0][0].url, EXPECTED.Axofly);

const axoflyAgain = await handleBuyAs(BUYER, '/buy pet Axofly', 14);
assert.equal(axoflyAgain.ability, 'Axofly', 'already owned pet keeps the guide button');

// ---- 5. non-item purchases stay plain strings (no button) -------------------
const chakra = await handleBuyAs(BUYER, '/buy chakra 100', 15);
assert.equal(typeof chakra, 'string');
assert.doesNotMatch(chakra, /ability/i);

const jutsu = await handleBuyAs(BUYER, '/buy Mind Transmission Jutsu', 16);
assert.equal(typeof jutsu, 'string', 'jutsu is not a shinobi/pet purchase');
assert.equal(abilityCheckKeyboard('Mind Transmission Jutsu'), undefined);

const poor = await handleBuyAs(POOR, '/buy Sasuke', 17);
assert.equal(typeof poor, 'string', 'refused purchases carry no ability button');
assert.match(poor, /𝐈𝐍𝐒𝐔𝐅𝐅𝐈𝐂𝐈𝐄𝐍𝐓 𝐂𝐎𝐈𝐍𝐒/);

console.log('buy ability button: OK');
