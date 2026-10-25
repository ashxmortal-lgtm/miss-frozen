// Legacy single-key pack table → composite (telegram_id, sticker_format).
import assert from 'node:assert/strict';
import { db, sql } from './sdk_db_stub.mjs';
import { ensureQuotePackSchema, resetQuotePackSchemaCache } from '../../tgcloud/lib/quote/schema.js';

// legacy single-key table with one existing pack
await db.run(sql.raw(`CREATE TABLE quote_sticker_packs (
  telegram_id INTEGER PRIMARY KEY, set_name TEXT NOT NULL, title TEXT NOT NULL,
  sticker_count INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'creating',
  sticker_format TEXT NOT NULL DEFAULT 'static', last_error TEXT,
  created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0)`));
await db.run(sql.raw(`INSERT INTO quote_sticker_packs (telegram_id, set_name, title, sticker_count, status, sticker_format)
  VALUES (42, 'frozen_stickers42_by_missfrozen_bot', 'Kakashi stickers', 3, 'ready', 'static')`));

resetQuotePackSchemaCache();
await ensureQuotePackSchema();

const rows = await db.all(sql`SELECT telegram_id, sticker_format, set_name, sticker_count FROM quote_sticker_packs`);
console.log('after migration:', JSON.stringify(rows));
assert.equal(rows.length, 1, 'the existing pack survives');
assert.equal(rows[0].set_name, 'frozen_stickers42_by_missfrozen_bot', 'link preserved');

// and the same user can now hold a second format
await db.run(sql`INSERT INTO quote_sticker_packs (telegram_id, sticker_format, set_name, title)
  VALUES (42, 'video', 'frozen_video_42_by_missfrozen_bot', 'Kakashi video stickers')`);
const both = await db.all(sql`SELECT sticker_format FROM quote_sticker_packs WHERE telegram_id = 42 ORDER BY sticker_format`);
console.log('formats:', both.map(r => r.sticker_format));
assert.deepEqual(both.map(r => r.sticker_format), ['static', 'video']);

// idempotent
resetQuotePackSchemaCache();
await ensureQuotePackSchema();
const again = await db.all(sql`SELECT count(*) AS n FROM quote_sticker_packs`);
console.log('still', again[0].n, 'rows');
assert.equal(again[0].n, 2);
console.log('schema migration: OK');
