// A dead account that has not been robbed yet can still close its purse:
// /protect (Jiraiya) blocks /rob as well as /kill until the shield ends.
import assert from 'node:assert/strict';
import { api } from 'sdk';
import { db } from './sdk_db_stub.mjs';

const DDL = [
  `CREATE TABLE IF NOT EXISTS users (
    telegram_id INTEGER PRIMARY KEY, balance INTEGER DEFAULT 0, xp INTEGER DEFAULT 0,
    kills INTEGER DEFAULT 0, username TEXT, first_name TEXT, equipped TEXT,
    last_claim_date TEXT, claim_streak INTEGER DEFAULT 0, naruto_patrols INTEGER DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS inventory (
    telegram_id INTEGER, item_type TEXT, item_name TEXT, qty INTEGER DEFAULT 1,
    PRIMARY KEY (telegram_id, item_name))`,
  `CREATE TABLE IF NOT EXISTS user_equipped (
    telegram_id INTEGER, shinobi TEXT, slot INTEGER DEFAULT 0,
    PRIMARY KEY (telegram_id, shinobi))`,
  `CREATE TABLE IF NOT EXISTS shinobi_state (
    telegram_id INTEGER, shinobi TEXT, level INTEGER DEFAULT 1,
    patrol_streak INTEGER DEFAULT 0, exhausted_until INTEGER DEFAULT 0,
    dead_until INTEGER DEFAULT 0, last_robbed_at INTEGER DEFAULT 0,
    train_sessions INTEGER DEFAULT 0, next_train_at INTEGER DEFAULT 0,
    PRIMARY KEY (telegram_id, shinobi))`,
  `CREATE TABLE IF NOT EXISTS user_skills (
    telegram_id INTEGER PRIMARY KEY, protected_until INTEGER DEFAULT 0,
    byakugan_at INTEGER DEFAULT 0, sakura_heal_at INTEGER DEFAULT 0,
    sakura_heal_uses INTEGER DEFAULT 0, katsuyu_heal_at INTEGER DEFAULT 0,
    dead_until INTEGER DEFAULT 0, last_robbed_at INTEGER DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS clone_pending (
    id INTEGER PRIMARY KEY AUTOINCREMENT, attacker_id INTEGER, target_id INTEGER,
    target_shinobi TEXT, chat_id INTEGER, message_id INTEGER DEFAULT 0,
    window_sec INTEGER DEFAULT 5, expires_at INTEGER DEFAULT 0,
    status TEXT DEFAULT 'pending', created_at INTEGER DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS rpg_tx (key TEXT PRIMARY KEY, created_at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS cleanup (
    id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id INTEGER, message_id INTEGER, delete_at INTEGER)`,
];
for (const text of DDL) await db.run({ text, params: [] });

const sent = [];
api.sendMessage = async (payload) => { sent.push(payload); return { message_id: sent.length }; };
api.sendRichMessage = async (payload) => { sent.push(payload); return { message_id: 100 + sent.length }; };
api.editMessageText = async () => ({});
api.answerCallbackQuery = async () => ({});
api.sendPhoto = async () => ({ message_id: 1 });

const textOf = (payload) => payload.text ?? payload.rich_message?.html
  ?? JSON.stringify(payload.rich_message?.blocks ?? '');
const now = () => Math.floor(Date.now() / 1000);

const ATTACKER = 2001;
const TARGET = 2002;

await db.run({
  text: `INSERT OR REPLACE INTO users (telegram_id, balance, first_name)
         VALUES (?, 0, 'Killer'), (?, 1000, 'Sleeping')`,
  params: [ATTACKER, TARGET],
});
for (const [id, name] of [[ATTACKER, 'Itachi'], [TARGET, 'Jiraiya'], [TARGET, 'Itachi']]) {
  await db.run({
    text: `INSERT OR IGNORE INTO inventory (telegram_id, item_type, item_name, qty)
           VALUES (?, 'shinobi', ?, 1)`,
    params: [id, name],
  });
  await db.run({
    text: `INSERT OR IGNORE INTO user_equipped (telegram_id, shinobi, slot) VALUES (?, ?, 1)`,
    params: [id, name],
  });
}
// The target is DEAD (24h account timer) and has not been robbed yet.
await db.run({
  text: `INSERT OR IGNORE INTO user_skills (telegram_id, dead_until) VALUES (?, ?)`,
  params: [TARGET, now() + 20 * 3600],
});
await db.run({
  text: `UPDATE user_skills SET dead_until = ?, last_robbed_at = 0, protected_until = 0
         WHERE telegram_id = ?`,
  params: [now() + 20 * 3600, TARGET],
});

const { handleKill, handleRob, handleProtect } = await import('../../tgcloud/lib/rpg/combat.js');

const message = (fromId, targetId, text) => ({
  message_id: 7,
  text,
  chat: { id: -777, type: 'group', title: 'Konoha' },
  from: { id: fromId, first_name: fromId === ATTACKER ? 'Killer' : 'Sleeping' },
  reply_to_message: { from: { id: targetId, first_name: targetId === TARGET ? 'Sleeping' : 'Killer' } },
});

// ---- 1. dead + not robbed → /protect works and closes the purse -------------
sent.length = 0;
await handleProtect(message(TARGET, TARGET, '/protect'));
const protectText = sent.map(textOf).join('\n');
assert.match(protectText, /𝐏𝐑𝐎𝐓𝐄𝐂𝐓𝐈𝐎𝐍 𝐀𝐂𝐓𝐈𝐕𝐄/, '/protect works while dead');
assert.match(protectText, /\/kill ᴀɴᴅ \/rob ᴄᴀɴɴᴏᴛ ꜱᴜᴄᴄᴇᴇᴅ/, 'the card says /rob is covered too');

const shield = await db.get({
  text: `SELECT protected_until FROM user_skills WHERE telegram_id = ?`, params: [TARGET],
});
assert.ok(Number(shield.protected_until) > now() + 23 * 3600, 'the 24h shield is up');

// ---- 2. /rob is refused while the shield is up ------------------------------
sent.length = 0;
await handleRob(message(ATTACKER, TARGET, '/rob'));
const blocked = sent.map(textOf).join('\n');
assert.match(blocked, /ɪꜱ ᴘʀᴏᴛᴇᴄᴛᴇᴅ ʙʏ ᴊɪʀᴀɪʏᴀ/, 'the robber is told about the shield');
assert.match(blocked, /ʀᴏʙʙᴇʀʏ ᴄᴀɴɴᴏᴛ ʟᴀɴᴅ/, 'and that the robbery cannot land');
assert.doesNotMatch(blocked, /ᴊɪʀᴀɪʏᴀ ᴘʀᴏᴛᴇᴄᴛɪᴏɴ ᴇɴᴅꜱ/, 'no timer leaks into the group card');

const purse = await db.get({
  text: `SELECT balance FROM users WHERE telegram_id = ?`, params: [TARGET],
});
assert.equal(purse.balance, 1000, 'no coins moved');
const untouched = await db.get({
  text: `SELECT last_robbed_at FROM user_skills WHERE telegram_id = ?`, params: [TARGET],
});
assert.equal(Number(untouched.last_robbed_at), 0, 'the robbery never locked the account');

// /kill stays blocked by the same shield.
sent.length = 0;
await handleKill(message(ATTACKER, TARGET, '/kill'));
assert.match(sent.map(textOf).join('\n'), /ɪꜱ ᴘʀᴏᴛᴇᴄᴛᴇᴅ ʙʏ ᴊɪʀᴀɪʏᴀ/);

// ---- 3. once the shield ends, the dead account can be robbed ---------------
await db.run({
  text: `UPDATE user_skills SET protected_until = ? WHERE telegram_id = ?`,
  params: [now() - 1, TARGET],
});
sent.length = 0;
await handleRob(message(ATTACKER, TARGET, '/rob'));
const robbed = sent.map(textOf).join('\n');
assert.match(robbed, /ꜱᴜᴄᴄᴇꜱꜱꜰᴜʟ ʀᴏʙʙᴇᴅ/, 'the robbery lands after the shield');
const after = await db.get({
  text: `SELECT balance FROM users WHERE telegram_id = ?`, params: [TARGET],
});
assert.equal(after.balance, 800, '20% of 1000 was taken');
const lock = await db.get({
  text: `SELECT last_robbed_at FROM user_skills WHERE telegram_id = ?`, params: [TARGET],
});
assert.ok(Number(lock.last_robbed_at) > 0, 'the account lockout is set by the robbery');

// ---- 4. an ALIVE target still gets the "not dead" answer -------------------
await db.run({
  text: `UPDATE user_skills SET dead_until = 0, protected_until = ?, last_robbed_at = 0
         WHERE telegram_id = ?`,
  params: [now() + 3600, TARGET],
});
sent.length = 0;
await handleRob(message(ATTACKER, TARGET, '/rob'));
assert.match(sent.map(textOf).join('\n'), /ɴᴏᴛ ᴅᴇᴀᴅ/,
  'alive targets are answered with the death rule, not the shield');

console.log('rob protection: OK');
