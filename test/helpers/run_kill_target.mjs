// /kill & /rob targeting: a real equipped shinobi must win over a legacy
// `Starter Shinobi` row that still sits in slot 0, and nobody is protected:
// a user who owns no shinobi at all is still a valid target.
// Death is ACCOUNT-level: one user_skills.dead_until timer, 24h, never a
// shinobi row — the roster keeps working while the account is dead.
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
    sakura_heal_uses INTEGER DEFAULT 0, katsuyu_heal_at INTEGER DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS clone_pending (
    id INTEGER PRIMARY KEY AUTOINCREMENT, attacker_id INTEGER, target_id INTEGER,
    target_shinobi TEXT, chat_id INTEGER, message_id INTEGER DEFAULT 0,
    window_sec INTEGER DEFAULT 5, expires_at INTEGER DEFAULT 0,
    status TEXT DEFAULT 'pending', created_at INTEGER DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS rpg_tx (key TEXT PRIMARY KEY, created_at INTEGER)`,
];
for (const text of DDL) await db.run({ text, params: [] });

const sent = [];
api.sendMessage = async (payload) => { sent.push(payload); return { message_id: sent.length }; };
api.sendRichMessage = async (payload) => { sent.push(payload); return { message_id: 100 + sent.length }; };
api.editMessageText = async () => ({});
api.answerCallbackQuery = async () => ({});

const textOf = (payload) => payload.text ?? payload.rich_message?.html
  ?? JSON.stringify(payload.rich_message?.blocks ?? '');
const now = () => Math.floor(Date.now() / 1000);

const ATTACKER = 1001;
const TARGET = 1002;      // legacy starter row in slot 0 + Itachi in slot 1
const STARTER_ONLY = 1003;
const LEGACY_TARGET = 1004; // only a starter row, but users.equipped names Itachi

await db.run({
  text: `INSERT OR REPLACE INTO users (telegram_id, balance, first_name)
         VALUES (?, 0, 'Killer'), (?, 1000, 'Victim'), (?, 0, 'Newbie'), (?, 0, 'Legacy')`,
  params: [ATTACKER, TARGET, STARTER_ONLY, LEGACY_TARGET],
});
await db.run({
  text: `UPDATE users SET equipped = 'Itachi' WHERE telegram_id = ?`,
  params: [LEGACY_TARGET],
});
await db.run({
  text: `INSERT OR IGNORE INTO user_equipped (telegram_id, shinobi, slot) VALUES (?, 'Starter Shinobi', 0)`,
  params: [LEGACY_TARGET],
});
for (const id of [ATTACKER, TARGET]) {
  await db.run({
    text: `INSERT OR IGNORE INTO inventory (telegram_id, item_type, item_name, qty)
           VALUES (?, 'shinobi', 'Itachi', 1)`,
    params: [id],
  });
}
// Attacker: Itachi in slot 1 (the starter is implicit, never a row).
await db.run({
  text: `INSERT OR IGNORE INTO user_equipped (telegram_id, shinobi, slot) VALUES (?, 'Itachi', 1)`,
  params: [ATTACKER],
});
// Target: the reported live shape — Starter Shinobi in slot 0, Itachi in slot 1.
await db.run({
  text: `INSERT OR IGNORE INTO user_equipped (telegram_id, shinobi, slot) VALUES (?, 'Starter Shinobi', 0)`,
  params: [TARGET],
});
await db.run({
  text: `INSERT OR IGNORE INTO user_equipped (telegram_id, shinobi, slot) VALUES (?, 'Itachi', 1)`,
  params: [TARGET],
});

const { getEquipped, getEquippedList } = await import('../../tgcloud/lib/rpg/state.js');
const { handleKill, handleRob } = await import('../../tgcloud/lib/rpg/combat.js');

// ---- targeting -----------------------------------------------------------------
assert.deepEqual(await getEquippedList(TARGET), ['Starter Shinobi', 'Itachi']);
assert.equal(await getEquipped(TARGET), 'Itachi', 'the real shinobi beats the legacy starter row');
assert.equal(await getEquipped(STARTER_ONLY), 'Starter Shinobi', 'starter-only users stay on the starter');
assert.equal(await getEquipped(LEGACY_TARGET), 'Itachi',
  'users.equipped still names the real shinobi when only a starter row exists');
assert.equal(await getEquipped(ATTACKER), 'Itachi');

// ---- /kill ---------------------------------------------------------------------
const message = (fromId, targetId, text) => ({
  message_id: 5,
  text,
  chat: { id: -555, type: 'group', title: 'Konoha' },
  from: { id: fromId, first_name: fromId === ATTACKER ? 'Killer' : 'Newbie' },
  reply_to_message: { from: { id: targetId, first_name: targetId === TARGET ? 'Victim' : 'Newbie' } },
});

sent.length = 0;
await handleKill(message(ATTACKER, TARGET, '/kill'));
const killText = sent.map(textOf).join('\n');
assert.match(killText, /ᴋɪʟʟᴇᴅ/);
assert.doesNotMatch(killText, /ᴄᴀɴɴᴏᴛ ʙᴇ ᴋɪʟʟᴇᴅ/, 'an equipped Itachi is killable');

// The ACCOUNT is dead for 24h and no shinobi carries a death timer.
const targetAccount = await db.get({
  text: `SELECT dead_until FROM user_skills WHERE telegram_id = ?`,
  params: [TARGET],
});
assert.ok(Number(targetAccount.dead_until) > now() + 23 * 3600, 'the target ACCOUNT is dead for 24h');
const deadShinobi = await db.get({
  text: `SELECT COUNT(*) AS n FROM shinobi_state WHERE telegram_id = ? AND dead_until > 0`,
  params: [TARGET],
});
assert.equal(Number(deadShinobi.n), 0, 'no shinobi is marked dead');
// Killing again inside the same 24h window is refused (one kill per account).
sent.length = 0;
await handleKill(message(ATTACKER, TARGET, '/kill'));
assert.match(sent.map(textOf).join('\n'), /ᴀʟʀᴇᴀᴅʏ ᴅᴇᴀᴅ/, 'the account cannot be killed twice in 24h');
const stillOne = await db.get({
  text: `SELECT kills FROM users WHERE telegram_id = ?`, params: [ATTACKER],
});
assert.equal(stillOne.kills, 1, 'the refused kill pays nothing');
const attacker = await db.get({
  text: `SELECT kills FROM users WHERE telegram_id = ?`, params: [ATTACKER],
});
assert.equal(attacker.kills, 1, 'the kill is credited');

// A target with no shinobi at all is killable — the account dies, not a shinobi.
sent.length = 0;
await handleKill(message(ATTACKER, STARTER_ONLY, '/kill'));
const newbieText = sent.map(textOf).join('\n');
assert.match(newbieText, /ᴋɪʟʟᴇᴅ/);
assert.doesNotMatch(newbieText, /ᴄᴀɴɴᴏᴛ ʙᴇ ᴋɪʟʟᴇᴅ/);
const newbieState = await db.get({
  text: `SELECT dead_until FROM user_skills WHERE telegram_id = ?`,
  params: [STARTER_ONLY],
});
assert.ok(Number(newbieState.dead_until) > now(), 'a shinobi-less account still dies');
const afterTwo = await db.get({
  text: `SELECT kills FROM users WHERE telegram_id = ?`, params: [ATTACKER],
});
assert.equal(afterTwo.kills, 2, 'the second kill is credited');

// ---- /rob needs a dead ACCOUNT and locks the account, not a shinobi --------
sent.length = 0;
await handleRob(message(ATTACKER, TARGET, '/rob'));
const robText = sent.map(textOf).join('\n');
assert.match(robText, /ʀᴏʙʙᴇʀʏ ʀᴀᴛᴇ: 20%/);
assert.match(robText, /200/, '20% of the target balance at Itachi level 1');
const robLock = await db.get({
  text: `SELECT last_robbed_at FROM user_skills WHERE telegram_id = ?`,
  params: [TARGET],
});
assert.ok(Number(robLock.last_robbed_at) > 0, 'the rob lockout lives on the account');
const shinobiLock = await db.get({
  text: `SELECT COUNT(*) AS n FROM shinobi_state WHERE telegram_id = ? AND last_robbed_at > 0`,
  params: [TARGET],
});
assert.equal(Number(shinobiLock.n), 0, 'no shinobi row keeps a rob lockout');

// Second /rob in the same 24h is refused.
sent.length = 0;
await handleRob(message(ATTACKER, TARGET, '/rob'));
assert.match(sent.map(textOf).join('\n'), /ʀᴏʙʙᴇᴅ ʀᴇᴄᴇɴᴛʟʏ/);

// ---- an ALIVE account cannot be robbed even when a shinobi row looks odd ----
await db.run({
  text: `UPDATE user_skills SET dead_until = 0 WHERE telegram_id = ?`,
  params: [TARGET],
});
await db.run({
  text: `UPDATE shinobi_state SET dead_until = 1 WHERE telegram_id = ?`,
  params: [TARGET],
});
sent.length = 0;
await handleRob(message(ATTACKER, TARGET, '/rob'));
assert.match(sent.map(textOf).join('\n'), /ɴᴏᴛ ᴅᴇᴀᴅ/,
  'leftover shinobi death rows never make a living account robbable');

// ---- the retired shinobi-death rows are wiped on first use ----------------
const { getUserSkills } = await import('../../tgcloud/lib/rpg/state.js');
await getUserSkills(TARGET);
const swept = await db.get({
  text: `SELECT COUNT(*) AS n FROM shinobi_state WHERE dead_until > 0 OR last_robbed_at > 0`,
  params: [],
});
assert.equal(Number(swept.n), 0, 'legacy shinobi death/lock rows are cleared');

console.log('kill target: OK');
