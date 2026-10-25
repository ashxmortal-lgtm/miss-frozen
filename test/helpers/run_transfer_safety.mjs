/**
 * Round 18 — `/transfer` must never mint coins.
 *
 * The old handler read the balance, compared it, and only then debited, so two
 * concurrent `/transfer` calls from a 100-coin wallet both passed the check and
 * the receiver was credited twice (sender 0, receiver 200).
 *
 * This harness drives the real handler through the SDK shim:
 *   1. concurrent double transfer → one succeeds, coins are conserved;
 *   2. insufficient funds → rejected, nothing moves;
 *   3. a normal transfer → exact debit/credit.
 */
import assert from 'node:assert/strict';
import { api } from 'sdk';
import { db } from './sdk_db_stub.mjs';
import { handleEconomyCommand } from '../../tgcloud/lib/economy_handler.js';

// ---- schema the handler touches --------------------------------------------
// The shared stub pre-creates `users`; rebuild it with every column the
// economy sweeps read so the handler runs on a production-shaped database.
await db.run({ text: 'DROP TABLE IF EXISTS users', params: [] });
for (const text of [
  `CREATE TABLE IF NOT EXISTS users (
    telegram_id INTEGER PRIMARY KEY, balance INTEGER DEFAULT 0, xp INTEGER DEFAULT 0,
    kills INTEGER DEFAULT 0, username TEXT, first_name TEXT, equipped TEXT,
    last_claim_date TEXT, claim_streak INTEGER DEFAULT 0, naruto_patrols INTEGER DEFAULT 0,
    total_searches INTEGER DEFAULT 0, blocked INTEGER DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS group_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id INTEGER NOT NULL, telegram_id INTEGER NOT NULL)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uidx_group_members ON group_members (chat_id, telegram_id)`,
  `CREATE TABLE IF NOT EXISTS clone_pending (
    id INTEGER PRIMARY KEY AUTOINCREMENT, attacker_id INTEGER, target_id INTEGER,
    target_shinobi TEXT, chat_id INTEGER, message_id INTEGER, window_sec INTEGER,
    expires_at INTEGER, status TEXT)`,
  `CREATE TABLE IF NOT EXISTS cleanup (
    id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id INTEGER, message_id INTEGER, delete_at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS tsunade_search (
    telegram_id INTEGER PRIMARY KEY, status TEXT, ends_at INTEGER, found INTEGER,
    total_searches INTEGER DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS activities (
    telegram_id INTEGER, shinobi TEXT, kind TEXT, status TEXT, ends_at INTEGER,
    cooldown_until INTEGER, PRIMARY KEY (telegram_id, shinobi))`,
  `CREATE TABLE IF NOT EXISTS games_lobbies (
    id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id INTEGER, status TEXT)`,
  `CREATE TABLE IF NOT EXISTS group_settings (
    chat_id INTEGER PRIMARY KEY, economy_enabled INTEGER NOT NULL DEFAULT 1,
    updated_by INTEGER, updated_at INTEGER)`,
]) await db.run({ text, params: [] });

const SENDER = 501;
const RECEIVER = 502;
const GROUP = -100777;

const sent = [];
api.sendMessage = async (payload) => { sent.push(payload); return { message_id: sent.length }; };
api.sendRichMessage = async (payload) => { sent.push(payload); return { message_id: 900 + sent.length }; };
api.editMessageText = async () => ({});
api.answerCallbackQuery = async () => ({});

const setBalance = (id, balance) => db.run({
  text: `INSERT INTO users (telegram_id, balance, first_name) VALUES (?, ?, 'Shinobi')
         ON CONFLICT(telegram_id) DO UPDATE SET balance = excluded.balance`,
  params: [id, balance],
});
const balanceOf = async (id) => {
  const row = await db.get({ text: 'SELECT balance FROM users WHERE telegram_id = ?', params: [id] });
  return Number(row?.balance ?? 0);
};
const resetAll = async () => {
  await db.run({ text: 'DELETE FROM users', params: [] });
  await setBalance(SENDER, 0);
  await setBalance(RECEIVER, 0);
};

const transferMessage = (text) => ({
  text,
  message_id: 11,
  chat: { id: GROUP, type: 'supergroup' },
  from: { id: SENDER, first_name: 'Sender', username: 'sender' },
  reply_to_message: {
    message_id: 10,
    from: { id: RECEIVER, first_name: 'Receiver', username: 'receiver' },
  },
});

const visible = (payload) => String(payload?.rich_message?.html ?? payload?.text ?? '');

// ---- 1. concurrent double transfer must not mint ---------------------------
await resetAll();
await setBalance(SENDER, 100);
sent.length = 0;
await Promise.all([
  handleEconomyCommand(transferMessage('/transfer 100')),
  handleEconomyCommand(transferMessage('/transfer 100')),
]);
const senderAfter = await balanceOf(SENDER);
const receiverAfter = await balanceOf(RECEIVER);
assert.equal(senderAfter, 0, `sender paid exactly its stake (got ${senderAfter})`);
assert.equal(receiverAfter, 100, `receiver credited once, not twice (got ${receiverAfter})`);
assert.equal(senderAfter + receiverAfter, 100, 'coins are conserved — no minting');

// ---- 2. insufficient funds changes nothing --------------------------------
await resetAll();
await setBalance(SENDER, 50);
sent.length = 0;
await handleEconomyCommand(transferMessage('/transfer 100'));
assert.equal(await balanceOf(SENDER), 50, 'sender keeps every coin');
assert.equal(await balanceOf(RECEIVER), 0, 'receiver is not credited');
const refusal = visible(sent.at(-1));
assert.ok(!/Transferred/.test(refusal), 'no success message is shown');
assert.match(refusal, /50/, 'the current balance is shown');
assert.match(refusal, /🍥/, 'the refusal keeps the coin icon');

// ---- 3. a normal transfer still works -------------------------------------
await resetAll();
await setBalance(SENDER, 100);
sent.length = 0;
await handleEconomyCommand(transferMessage('/transfer 40'));
assert.equal(await balanceOf(SENDER), 60);
assert.equal(await balanceOf(RECEIVER), 40);
assert.ok(
  sent.some((p) => /40/.test(visible(p))),
  'the group reply reports the transferred amount',
);

// ---- 4. the balance check and the debit are one statement -----------------
const { readFileSync } = await import('node:fs');
const source = readFileSync(new URL('../../tgcloud/lib/economy_handler.js', import.meta.url), 'utf8');
const fn = source.slice(source.indexOf('async function handleTransfer'), source.indexOf('const LB_LIMIT'));
assert.match(fn, /UPDATE users SET balance = balance - \$\{amount\}[\s\S]*?WHERE telegram_id = \$\{user\.id\} AND balance >= \$\{amount\}/,
  'the debit is guarded by the balance in SQL');
assert.match(fn, /if \(!paid\?\.rowsAffected\)/, 'the handler checks whether the debit actually happened');
assert.doesNotMatch(fn, /await adjustBalance\(user\.id, -amount\)/, 'no unguarded sender debit');

console.log('transfer safety: OK');
