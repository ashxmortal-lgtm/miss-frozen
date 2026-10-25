// /q and /own — quote stickers (mocked Bot API, in-memory database).
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('/q and /own: end to end (extract → render → upload → pack row)', () => {
  const output = execFileSync(
    process.execPath,
    ['--experimental-loader', './test/helpers/sdk-loader.mjs', 'test/helpers/run_quote_stickers.mjs'],
    { cwd: new URL('..', import.meta.url), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  assert.match(output, /quote stickers: OK/);
});

test('the renderer is pure JS — no canvas, no zlib, no npm at runtime', () => {
  const png = read('tgcloud/lib/quote/png.js');
  const render = read('tgcloud/lib/quote/render.js');
  const font = read('tgcloud/lib/quote/font.js');
  for (const source of [png, render, font]) {
    assert.doesNotMatch(source, /from 'node:/, 'no node: builtins in the isolate');
    assert.doesNotMatch(source, /require\(/, 'no CommonJS requires');
  }
  assert.doesNotMatch(png, /require\('zlib'\)|zlib\.deflate/, 'zlib is unavailable at runtime');
  assert.match(png, /stored/, 'deflate uses stored (uncompressed) blocks');
  assert.match(render, /STICKER_SIZE = 512/, 'stickers are 512 px wide');
});

test('the pack module never caches or stores message content', () => {
  const packs = read('tgcloud/lib/quote/packs.js');
  const stickers = read('tgcloud/lib/quote_stickers.js');
  for (const source of [packs, stickers]) {
    assert.doesNotMatch(source, /quote_text|message_text|caption\s+TEXT/i,
      'no message content in the schema');
  }
  // Only the pack metadata table is touched (comments stripped first, they have
  // prose like "from an earlier run").
  const code = packs
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map((line) => line.replace(/\/\/.*$/, '')).join('\n');
  const touched = [...code.matchAll(/(?:FROM|INTO|UPDATE)\s+([a-z_]+)/gi)].map((m) => m[1].toLowerCase());
  assert.ok(touched.length > 0);
  for (const table of new Set(touched)) {
    assert.equal(table, 'quote_sticker_packs', `unexpected table touched: ${table}`);
  }
});

test('the schema declares one pack per user with unique names', () => {
  const schema = read('tgcloud/schema.js');
  assert.match(schema, /export const quoteStickerPacks = table\('quote_sticker_packs'/);
  assert.match(schema, /telegramId: integer\('telegram_id'\)\.primaryKey\(\)/, 'unique user row');
  assert.match(schema, /uniqueIndex\('uidx_quote_pack_name'\)\.on\(t\.setName\)/, 'unique short name');
  assert.match(schema, /stickerCount: integer\('sticker_count'\)/, 'sticker count for the pack limit');
});

test('/q and /own are dispatched before the economy handlers and never consume other text', () => {
  const handler = read('tgcloud/handlers/message.js');
  const index = handler.indexOf('handleQuoteCommand(message)');
  assert.ok(index > 0, 'the dispatcher calls the quote handler');
  assert.ok(index < handler.indexOf('handleEconomyCommand(message, ctx)'),
    'quotes are handled before the economy fallback');
  assert.match(handler, /parseQuoteCommand\(message\.text\)/, 'only quote commands are routed');
});

test('help lists /q and /own exactly once', () => {
  const registry = read('tgcloud/lib/command_registry.js');
  assert.equal((registry.match(/cmd: '\/q'/g) || []).length, 1);
  assert.equal((registry.match(/cmd: '\/own'/g) || []).length, 1);
  const help = read('tgcloud/lib/help.js');
  assert.equal((help.match(/'\/q'/g) || []).length, 1);
  assert.equal((help.match(/'\/own'/g) || []).length, 1);
});
