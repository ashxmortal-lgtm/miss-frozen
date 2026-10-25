// Guards for tgcloud/schema.js.
//
// The platform COMPILES schema.js at deploy time, so anything that throws while
// the table declarations are evaluated fails the whole deployment with
// "Error: Compilation failed" — while the test suite can still be green if the
// stub swallows it. These tests close that gap:
//
//   1. every table() constraint callback must evaluate without throwing;
//   2. every helper called inside a callback must actually be imported from
//      'sdk/db' (a missing import is a ReferenceError at deploy time);
//   3. a deploy-time lint pass over the module source for the same mistake.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('schema.js table constraint callbacks all evaluate cleanly', () => {
  // The stub records failures instead of hiding them, so a callback that throws
  // (e.g. a helper that was never imported) fails this test — and would fail
  // the deploy the same way.
  const output = execFileSync(
    process.execPath,
    ['--experimental-loader', './test/helpers/sdk-loader.mjs', 'test/helpers/run_schema_eval.mjs'],
    { cwd: new URL('..', import.meta.url), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  assert.match(output, /schema eval: OK/);
});

test('schema.js imports every sdk/db helper it calls', () => {
  const source = read('tgcloud/schema.js');
  const importLine = source.split('\n').find((line) => line.includes("from 'sdk/db'"));
  assert.ok(importLine, 'schema.js imports from sdk/db');
  const imported = new Set(
    importLine.replace(/^.*?\{|\}.*$/g, '').split(',').map((name) => name.trim()).filter(Boolean),
  );

  // Helpers that may legitimately appear inside a `(t) => ({ ... })` block.
  const HELPERS = ['primaryKey', 'uniqueIndex', 'index', 'unique', 'check', 'foreignKey', 'sql'];
  const tableCalls = [...source.matchAll(/\}, \(t\) => \(\{([\s\S]*?)\}\)\);/g)].map((m) => m[1]);
  assert.ok(tableCalls.length > 10, 'found the table constraint callbacks');

  const missing = new Set();
  for (const body of tableCalls) {
    for (const helper of HELPERS) {
      // `helper(` as a call, not a property access.
      const pattern = new RegExp(`(^|[^.\\w])${helper}\\s*\\(`, 'm');
      if (pattern.test(body) && !imported.has(helper)) missing.add(helper);
    }
  }
  assert.deepEqual([...missing], [],
    `these helpers are called in constraints but not imported from 'sdk/db': ${[...missing].join(', ')}`);
});

test('the quote pack table matches the DDL used by the lazy schema setup', () => {
  const schema = read('tgcloud/schema.js');
  const lazy = read('tgcloud/lib/quote/schema.js');

  // The platform declaration must expose one row per (user, format) through a
  // table-level unique index — NOT a variadic primaryKey() call.
  const block = schema.slice(
    schema.indexOf("export const quoteStickerPacks = table("),
    schema.indexOf('}));', schema.indexOf("export const quoteStickerPacks = table(")) + 4,
  );
  assert.match(block, /uniqueIndex\('uidx_quote_pack_owner'\)\.on\(t\.telegramId, t\.stickerFormat\)/,
    'owner uniqueness comes from a unique index');
  assert.doesNotMatch(block, /primaryKey\s*\(/, 'no primaryKey helper in the constraint block');

  // Same columns, same index names on both sides.
  for (const column of ['telegram_id', 'sticker_format', 'set_name', 'title',
    'sticker_count', 'status', 'last_error', 'created_at', 'updated_at']) {
    assert.ok(schema.includes(`'${column}'`), `schema.js declares ${column}`);
    assert.ok(lazy.includes(column), `lazy DDL declares ${column}`);
  }
  assert.ok(lazy.includes('uidx_quote_pack_owner'), 'lazy setup creates the owner index');
  assert.ok(lazy.includes('uidx_quote_pack_name'), 'lazy setup creates the name index');
});

test('the conflict target matches a real unique index', () => {
  const packs = read('tgcloud/lib/quote/packs.js');
  assert.match(packs, /ON CONFLICT\(telegram_id, sticker_format\) DO NOTHING/,
    'claimPack targets the owner key');
  // The target must be backed by the unique index declared above, or SQLite
  // rejects the statement at runtime.
  assert.match(read('tgcloud/lib/quote/schema.js'),
    /uidx_quote_pack_owner[^\n]*\n?[^\n]*telegram_id, sticker_format|telegram_id, sticker_format\)/,
    'the owner index covers (telegram_id, sticker_format)');
});
