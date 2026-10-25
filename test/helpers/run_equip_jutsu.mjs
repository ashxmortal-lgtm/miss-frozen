// A purchased jutsu is a passive unlock, not a shinobi: /equip must recognise
// "Mind Transmission Jutsu" instead of printing the recruit-at-/shinobi_store
// card, and /mt must accept the purchase as unlocked.
import assert from 'node:assert/strict';
import { api } from 'sdk';
import { db, sql } from './sdk_db_stub.mjs';
import { style } from '../../tgcloud/lib/texts.js';
import { handleBuy } from '../../tgcloud/lib/buy.js';
import { handleEquip } from '../../tgcloud/lib/economy_handler.js';
import { handleMtCommand } from '../../tgcloud/lib/mt.js';

for (const text of [
  `CREATE TABLE IF NOT EXISTS users (
    telegram_id INTEGER PRIMARY KEY, balance INTEGER DEFAULT 0, xp INTEGER DEFAULT 0,
    kills INTEGER DEFAULT 0, username TEXT, first_name TEXT, equipped TEXT,
    last_claim_date TEXT, claim_streak INTEGER DEFAULT 0, naruto_patrols INTEGER DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS inventory (
    telegram_id INTEGER, item_type TEXT, item_name TEXT, qty INTEGER DEFAULT 1,
    PRIMARY KEY (telegram_id, item_name))`,
  `CREATE TABLE IF NOT EXISTS purchases (
    id INTEGER PRIMARY KEY AUTOINCREMENT, update_id INTEGER, telegram_id INTEGER,
    item_name TEXT, qty INTEGER, cost INTEGER, created_at INTEGER DEFAULT 0)`,
]) await db.run({ text, params: [] });

// purchase() reads the new balance through getBalance()'s query-builder shape.
let activeId = null;
db.select = () => ({
  from() { return this; },
  where() { return this; },
  async get() {
    return db.get({ text: 'SELECT * FROM users WHERE telegram_id = ?', params: [activeId] });
  },
});

const sent = [];
// Ephemeral sends are answered the way Telegram answers a private message
// (`message_id: 0` + `ephemeral_message_id`), so /mt can verify delivery.
let ephemeralSeq = 0;
api.sendMessage = async (payload) => {
  sent.push(payload);
  if (payload.ephemeral_message_parameters || payload.receiver_user_id) {
    return { message_id: 0, ephemeral_message_id: ++ephemeralSeq };
  }
  return { message_id: sent.length };
};
api.sendRichMessage = async (payload) => { sent.push(payload); return { message_id: 100 + sent.length }; };
api.setMyCommands = async () => true;
api.deleteMessage = async () => true;

const htmlOf = (payload) => String(payload.rich_message?.html ?? payload.text ?? '');
const lastReply = () => htmlOf(sent[sent.length - 1]);

const PLAYER = 8301;
await db.run(sql`INSERT OR REPLACE INTO users (telegram_id, balance) VALUES (${PLAYER}, 50000)`);

const message = (text) => ({
  text,
  message_id: 42,
  chat: { id: PLAYER, type: 'private' },
  from: { id: PLAYER, first_name: 'Shinobi' },
});

// ---- 1. not owned yet: guide to /buy, never to a shinobi recruit -------------
sent.length = 0;
await handleEquip(message('/equip Mind Transmission Jutsu'), '/equip Mind Transmission Jutsu');
const notOwned = lastReply();
assert.match(notOwned, new RegExp(style('Mind Transmission Jutsu')));
assert.match(notOwned, /\/buy /, 'the unlock path is /buy');
assert.ok(!/\/shinobi_store/.test(notOwned), 'a jutsu is never a shinobi recruit');
assert.ok(!/Recruit at/i.test(notOwned));

// ---- 2. buy the jutsu -------------------------------------------------------
activeId = PLAYER;
const bought = await handleBuy({ id: PLAYER }, '/buy Mind Transmission Jutsu', 9001);
assert.equal(typeof bought, 'string');
assert.match(bought, /𝐉𝐔𝐓𝐒𝐔 𝐔𝐍𝐋𝐎𝐂𝐊𝐄𝐃|ᴜɴʟᴏᴄᴋᴇᴅ/);
const row = await db.get(sql`
  SELECT item_type, item_name, qty FROM inventory
  WHERE telegram_id = ${PLAYER} AND item_name = 'Mind Transmission Jutsu'
`);
assert.equal(row.item_type, 'jutsu', 'the purchase lands in inventory as a jutsu');
assert.equal(Number(row.qty), 1);

// ---- 3. /equip after the purchase: "already unlocked", not "you don't own" ---
sent.length = 0;
await handleEquip(message('/equip Mind Transmission Jutsu'), '/equip Mind Transmission Jutsu');
const owned = lastReply();
assert.match(owned, new RegExp(style('is already unlocked')));
assert.match(owned, new RegExp(style('never equipped')));
assert.match(owned, /\/mt /, 'the player is pointed at /mt');
assert.ok(!/don't own/i.test(owned), 'a bought jutsu is never reported as missing');

// The name is matched case-insensitively and with the "jutsu" suffix omitted.
sent.length = 0;
await handleEquip(message('/equip mind transmission'), '/equip mind transmission');
assert.match(lastReply(), new RegExp(style('is already unlocked')));

// ---- 4. /mt accepts the purchased jutsu -------------------------------------
sent.length = 0;
const group = {
  text: '/mt testing',
  message_id: 43,
  chat: { id: -100830, type: 'supergroup' },
  from: { id: PLAYER, first_name: 'Shinobi' },
  reply_to_message: { message_id: 44, from: { id: 8302, first_name: 'Receiver' } },
};
await handleMtCommand(group);
const mtText = htmlOf(sent[sent.length - 1]);
assert.ok(!new RegExp(style('JUTSU NOT UNLOCKED')).test(mtText), '/mt sees the bought jutsu');
assert.match(mtText, new RegExp(style('MIND TRANSMISSION SENT')));

// ---- 5. an unknown shinobi name still gets the recruit card -----------------
sent.length = 0;
await handleEquip(message('/equip Sasuke'), '/equip Sasuke');
assert.match(lastReply(), new RegExp(style("You don't own")));
assert.match(lastReply(), /\/shinobi_store/);

console.log('equip jutsu: OK');
