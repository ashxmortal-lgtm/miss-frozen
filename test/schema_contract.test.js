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

test('the DEPLOYED pack table shape is never changed again', () => {
  const schema = read('tgcloud/schema.js');
  const block = schema.slice(
    schema.indexOf("export const quoteStickerPacks = table("),
    schema.indexOf('}));', schema.indexOf("export const quoteStickerPacks = table(")) + 4,
  );
  // This table exists in production. SQLite cannot ALTER a column, so any
  // change here makes the platform demand a destructive "change column"
  // migration — which is exactly what blocked the deploy.
  assert.match(block, /telegramId: integer\('telegram_id'\)\.primaryKey\(\)/,
    'telegram_id stays INTEGER PRIMARY KEY — changing it blocks deploys');
  assert.doesNotMatch(block, /notNull\(\),?\s*\n\s*stickerFormat/,
    'telegram_id must not be redeclared as plain NOT NULL');
  // New packs go to the additive table instead.
  assert.match(schema, /export const stickerPackSets = table\('sticker_pack_sets'/);
  assert.match(schema, /uniqueIndex\('uidx_sticker_pack_owner'\)\.on\(t\.telegramId, t\.stickerFormat\)/);
});

test('only ADDITIVE migrations are introduced (no column changes)', () => {
  const schema = read('tgcloud/schema.js');
  // `deprecated()` triggers a destructive drop prompt; none should be pending
  // for the sticker tables.
  const packBlock = schema.slice(schema.indexOf("table('quote_sticker_packs'"));
  const endOfPacks = packBlock.indexOf("table('sticker_pack_sets'");
  assert.doesNotMatch(packBlock.slice(0, endOfPacks > 0 ? endOfPacks : 2000), /\.deprecated\(/,
    'no deprecated() columns on the deployed pack table');
});

test('the quote pack table matches the DDL used by the lazy schema setup', () => {
  const schema = read('tgcloud/schema.js');
  const lazy = read('tgcloud/lib/quote/schema.js');

  // The platform declaration must expose one row per (user, format) through a
  // table-level unique index — NOT a variadic primaryKey() call.
  const setBlock = schema.slice(
    schema.indexOf("export const stickerPackSets = table("),
    schema.indexOf('}));', schema.indexOf("export const stickerPackSets = table(")) + 4,
  );
  assert.match(setBlock, /uniqueIndex\('uidx_sticker_pack_owner'\)\.on\(t\.telegramId, t\.stickerFormat\)/,
    'owner uniqueness comes from a unique index');
  // A bare `primaryKey(...)` helper call is the bug that broke the deploy.
  // `integer('id').primaryKey({...})` is the column method and is fine.
  assert.doesNotMatch(setBlock, /(^|[^.\w])primaryKey\s*\(/m,
    'no variadic primaryKey() helper');

  // Same columns, same index names on both sides.
  for (const column of ['telegram_id', 'sticker_format', 'set_name', 'title',
    'sticker_count', 'status', 'last_error', 'created_at', 'updated_at']) {
    assert.ok(schema.includes(`'${column}'`), `schema.js declares ${column}`);
    assert.ok(lazy.includes(column), `lazy DDL declares ${column}`);
  }
  assert.ok(lazy.includes('uidx_sticker_pack_owner'), 'lazy setup creates the owner index');
  assert.ok(lazy.includes('uidx_sticker_pack_name'), 'lazy setup creates the name index');
  assert.match(lazy, /sticker_pack_sets/, 'lazy setup targets the new table');
  assert.match(lazy, /quote_sticker_packs/, 'lazy setup still knows the legacy table for adoption');
});

test('the conflict target matches a real unique index', () => {
  const packs = read('tgcloud/lib/quote/packs.js');
  assert.match(packs, /ON CONFLICT\(telegram_id, sticker_format\) DO NOTHING/,
    'claimPack targets the owner key');
  // The target must be backed by the unique index declared above, or SQLite
  // rejects the statement at runtime.
  assert.match(read('tgcloud/lib/quote/schema.js'),
    /uidx_sticker_pack_owner[^\n]*\n?[^\n]*telegram_id, sticker_format|telegram_id, sticker_format\)/,
    'the owner index covers (telegram_id, sticker_format)');
});
