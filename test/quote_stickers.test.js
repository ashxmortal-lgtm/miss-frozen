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

test('the legacy pack table migrates to one row per (user, format)', () => {
  const output = execFileSync(
    process.execPath,
    ['--experimental-loader', './test/helpers/sdk-loader.mjs', 'test/helpers/run_quote_pack_migration.mjs'],
    { cwd: new URL('..', import.meta.url), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  assert.match(output, /schema migration: OK/);
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
  assert.match(png, /encodeRgbaPng/, 'RGBA output for real transparency');
  assert.match(png, /zlibDeflate/, 'compressed IDAT (stored blocks would exceed 512 KB)');
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
    assert.equal(table, 'sticker_pack_sets', `unexpected table touched: ${table}`);
  }
});

test('packs live in one row per (user, format) in the additive table', () => {
  const schema = read('tgcloud/schema.js');
  const setBlock = schema.slice(
    schema.indexOf("export const stickerPackSets = table("),
    schema.indexOf('}));', schema.indexOf("export const stickerPackSets = table(")) + 4,
  );
  assert.match(setBlock, /telegramId: integer\('telegram_id'\)\.notNull\(\)/);
  assert.match(setBlock, /stickerFormat: text\('sticker_format'\)/, 'format is part of the key');
  assert.match(setBlock, /uniqueIndex\('uidx_sticker_pack_owner'\)\.on\(t\.telegramId, t\.stickerFormat\)/,
    'owner uniqueness: a static and a video pack coexist');
  assert.doesNotMatch(setBlock, /(^|[^.\w])primaryKey\s*\(/m,
    'no variadic primaryKey() — it is not imported and breaks deploy');
  assert.match(setBlock, /uniqueIndex\('uidx_sticker_pack_name'\)\.on\(t\.setName\)/, 'unique short name');
  assert.match(setBlock, /stickerCount: integer\('sticker_count'\)/, 'sticker count for the pack limit');
});

test('the deployed pack table is left untouched so no column change is requested', () => {
  const schema = read('tgcloud/schema.js');
  const liveBlock = schema.slice(
    schema.indexOf("export const quoteStickerPacks = table("),
    schema.indexOf('}));', schema.indexOf("export const quoteStickerPacks = table(")) + 4,
  );
  // SQLite cannot ALTER a column: redeclaring this one as NOT NULL makes the
  // platform demand a destructive migration and blocks the deploy.
  assert.match(liveBlock, /telegramId: integer\('telegram_id'\)\.primaryKey\(\)/,
    'telegram_id keeps its deployed PRIMARY KEY shape');
  assert.doesNotMatch(liveBlock, /uidx_sticker_pack_owner/, 'no new indexes on the live table');
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

test('the image codecs are pure JS and agree with the zlib reference', () => {
  const inflate = read('tgcloud/lib/quote/inflate.js');
  const deflate = read('tgcloud/lib/quote/deflate.js');
  const jpeg = read('tgcloud/lib/quote/jpeg.js');
  for (const source of [inflate, deflate, jpeg]) {
    assert.doesNotMatch(source, /from 'node:/, 'no node: builtins in the isolate');
    assert.doesNotMatch(source, /require\(/, 'no CommonJS requires');
  }
  assert.match(inflate, /export function zlibInflate/, 'PNG decode needs inflate');
  assert.match(deflate, /export function zlibDeflate/, 'RGBA PNG encode needs deflate');
  assert.match(jpeg, /export function decodeJpeg/, 'profile photos are JPEG');
  assert.match(jpeg, /progressive JPEG is not supported/, 'unsupported JPEGs fail loudly');
});

test('the font atlas is generated data, not a runtime dependency', () => {
  const atlas = read('tgcloud/lib/quote/font_atlas.js');
  assert.match(atlas, /GENERATED FILE/, 'built by scripts/build_quote_font.js');
  assert.match(atlas, /export const GLYPHS/);
  // The atlas is deflated with the project's own encoder and inflated at runtime.
  const text = read('tgcloud/lib/quote/text.js');
  assert.match(text, /zlibInflate/);
  assert.doesNotMatch(text, /registerFont|canvas|freetype/i);
});
