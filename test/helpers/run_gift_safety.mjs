/**
 * Round 18 — `/gift` must charge exactly once per delivered gift.
 *
 * The old `deduct()` read the balance, compared it in JS and wrote back
 * `balance = <stale read> - price`, so two concurrent gifts both passed the
 * check and the second write re-used the pre-purchase balance: the sender paid
 * once for two gifts and any coins credited in between were erased.
 *
 * Also covers the inventory counter: gifts now insert-then-increment instead
 * of read-then-write, so a pair of gifts leaves qty = 2.
 */
import assert from 'node:assert/strict';
import { api } from 'sdk';
import { db } from './sdk_db_stub.mjs';
import { handleGiftCommand, GIFTS } from '../../tgcloud/lib/gift.js';

const SENDER = 601;
const TARGET = 602;
const GROUP = -100888;

const sent = [];
api.sendMessage = async (payload) => { sent.push(payload); return { message_id: sent.length }; };
api.sendRichMessage = async (payload) => { sent.push(payload); return { message_id: 500 + sent.length }; };
api.editMessageText = async () => ({});

const RAMEN = GIFTS.find((g) => g.name === 'Ichiraku Ramen');
assert.ok(RAMEN, 'the ramen gift exists');

const setBalance = (id, balance) => db.run({
  text: `INSERT INTO users (telegram_id, balance, first_name) VALUES (?, ?, 'Shinobi')
         ON CONFLICT(telegram_id) DO UPDATE SET balance = excluded.balance`,
  params: [id, balance],
});
const balanceOf = async (id) => {
  const row = await db.get({ text: 'SELECT balance FROM users WHERE telegram_id = ?', params: [id] });
  return Number(row?.balance ?? 0);
};
const giftQty = async (id) => {
  const row = await db.get({
    text: 'SELECT qty FROM inventory WHERE telegram_id = ? AND item_name = ?',
    params: [id, `${RAMEN.emoji} ${RAMEN.name}`],
  });
  return Number(row?.qty ?? 0);
};
const resetAll = async () => {
  await db.run({ text: 'DELETE FROM users', params: [] });
  await db.run({ text: 'DELETE FROM inventory', params: [] });
  await setBalance(SENDER, 0);
  await setBalance(TARGET, 0);
};

const giftMessage = (id) => ({
  text: `/gift ${id}`,
  message_id: 20,
  chat: { id: GROUP, type: 'supergroup' },
  from: { id: SENDER, first_name: 'Sender', username: 'sender' },
  reply_to_message: {
    message_id: 19,
    from: { id: TARGET, first_name: 'Target', username: 'target' },
  },
});

// ---- 1. two concurrent gifts are paid twice -------------------------------
await resetAll();
await setBalance(SENDER, 1000);
sent.length = 0;
await Promise.all([
  handleGiftCommand(giftMessage(RAMEN.id)),
  handleGiftCommand(giftMessage(RAMEN.id)),
]);
const after = await balanceOf(SENDER);
assert.equal(after, 1000 - RAMEN.price * 2, `both gifts are charged (balance ${after})`);
assert.equal(await giftQty(TARGET), 2, 'both gifts reach the receiver inventory');

// ---- 2. one gift is charged once and counted once -------------------------
await resetAll();
await setBalance(SENDER, 1000);
sent.length = 0;
await handleGiftCommand(giftMessage(RAMEN.id));
assert.equal(await balanceOf(SENDER), 1000 - RAMEN.price);
assert.equal(await giftQty(TARGET), 1);

// ---- 3. insufficient funds: no debit, no gift -----------------------------
await resetAll();
await setBalance(SENDER, RAMEN.price - 1);
sent.length = 0;
await handleGiftCommand(giftMessage(RAMEN.id));
assert.equal(await balanceOf(SENDER), RAMEN.price - 1, 'the sender keeps every coin');
assert.equal(await giftQty(TARGET), 0, 'no gift is delivered');
const refusal = sent.map((p) => String(p.text || p.rich_message?.html || '')).join('\n');
assert.match(refusal, /ɴᴏᴛ ᴇɴᴏᴜɢʜ ᴄᴏɪɴꜱ/i, 'the sender is told why');

// ---- 4. the debit is guarded in SQL ---------------------------------------
const { readFileSync } = await import('node:fs');
const source = readFileSync(new URL('../../tgcloud/lib/gift.js', import.meta.url), 'utf8');
const fn = source.slice(source.indexOf('async function deduct'), source.indexOf('async function addGiftToInventory'));
assert.match(fn, /UPDATE users SET balance = balance - \$\{amount\}[\s\S]*?AND balance >= \$\{amount\}/);
assert.doesNotMatch(fn, /balance: u\.balance - amount/, 'no stale read-then-write debit');

console.log('gift safety: OK');
