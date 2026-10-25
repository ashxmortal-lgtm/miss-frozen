import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const run = (helper) => execFileSync(
  process.execPath,
  ['--experimental-loader', './test/helpers/sdk-loader.mjs', helper],
  { cwd: new URL('..', import.meta.url), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
);

// Round 18 — /transfer read the balance, compared it, then debited in a second
// statement. Two concurrent transfers from a 100-coin wallet both passed the
// check, so the receiver was credited twice and 100 coins were minted.
test('/transfer debits atomically and cannot mint coins', () => {
  assert.match(run('test/helpers/run_transfer_safety.mjs'), /transfer safety: OK/);
});

test('the balance check and the debit are a single guarded statement', () => {
  const source = readFileSync(new URL('../tgcloud/lib/economy_handler.js', import.meta.url), 'utf8');
  const fn = source.slice(source.indexOf('async function handleTransfer'), source.indexOf('const LB_LIMIT'));
  assert.match(fn, /UPDATE users SET balance = balance - \$\{amount\}[\s\S]*?WHERE telegram_id = \$\{user\.id\} AND balance >= \$\{amount\}/);
  assert.match(fn, /if \(!paid\?\.rowsAffected\)/, 'a failed debit must abort the transfer');
  assert.ok(
    fn.indexOf('WHERE telegram_id = ${user.id} AND balance >= ${amount}') < fn.indexOf('adjustBalance(replied.id, amount)'),
    'the receiver is credited only after the sender actually paid',
  );
  assert.doesNotMatch(fn, /await adjustBalance\(user\.id, -amount\)/, 'no unguarded sender debit');
});

// Round 18 — /gift had the same read-then-write debit, plus a read-then-write
// inventory counter, so a pair of gifts was paid once and could overwrite
// coins credited in between with a stale balance.
test('/gift charges every delivered gift and counts it once', () => {
  assert.match(run('test/helpers/run_gift_safety.mjs'), /gift safety: OK/);
});

test('gift debits and increments are single statements', () => {
  const source = readFileSync(new URL('../tgcloud/lib/gift.js', import.meta.url), 'utf8');
  const deduct = source.slice(source.indexOf('async function deduct'), source.indexOf('async function addGiftToInventory'));
  assert.match(deduct, /UPDATE users SET balance = balance - \$\{amount\}[\s\S]*?AND balance >= \$\{amount\}/);
  assert.doesNotMatch(deduct, /balance: u\.balance - amount/);

  const add = source.slice(source.indexOf('async function addGiftToInventory'), source.indexOf('export async function handleGiftCommand'));
  assert.match(add, /INSERT OR IGNORE INTO inventory/, 'the row is created before the increment');
  assert.match(add, /UPDATE inventory SET qty = qty \+ 1/, 'the counter increments in SQL');
  assert.doesNotMatch(add, /qty: \(existing\.qty \|\| 1\) \+ 1/, 'no stale read-then-write counter');
});
