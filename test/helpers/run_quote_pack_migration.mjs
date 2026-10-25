// Legacy pack table → additive sticker_pack_sets.
//
// The deployed table keeps `telegram_id INTEGER PRIMARY KEY` (one pack per
// user) and is never altered: SQLite cannot change a column, and asking the
// platform to would block deploys. New packs live in a separate table, and any
// pack a user already created is adopted on first use.
import assert from 'node:assert/strict';
import { db, sql } from './sdk_db_stub.mjs';
import { ensureQuotePackSchema, resetQuotePackSchemaCache } from '../../tgcloud/lib/quote/schema.js';

// The live shape (as deployed) with one existing pack.
await db.run(sql.raw(`CREATE TABLE quote_sticker_packs (
  telegram_id INTEGER PRIMARY KEY, set_name TEXT NOT NULL, title TEXT NOT NULL,
  sticker_count INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'creating',
  sticker_format TEXT NOT NULL DEFAULT 'static', last_error TEXT,
  created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0)`));
await db.run(sql.raw(`INSERT INTO quote_sticker_packs
  (telegram_id, set_name, title, sticker_count, status, sticker_format)
  VALUES (42, 'frozen_static_42_by_missfrozen_bot', 'Kakashi stickers', 3, 'ready', 'static')`));

resetQuotePackSchemaCache();
await ensureQuotePackSchema();

// The legacy table must be untouched.
const legacy = await db.all(sql`SELECT * FROM quote_sticker_packs`);
assert.equal(legacy.length, 1, 'the deployed table is not modified');

// Its row is adopted into the new table, link preserved.
const adopted = await db.all(sql`SELECT * FROM sticker_pack_sets WHERE telegram_id = 42`);
console.log('adopted:', JSON.stringify(adopted));
assert.equal(adopted.length, 1, 'the existing pack is carried over');
assert.equal(adopted[0].set_name, 'frozen_static_42_by_missfrozen_bot', 'pack link preserved');
assert.equal(adopted[0].sticker_count, 3, 'count preserved');

// The same user can now hold a second format.
await db.run(sql`INSERT INTO sticker_pack_sets (telegram_id, sticker_format, set_name, title)
  VALUES (42, 'video', 'frozen_video_42_by_missfrozen_bot', 'Kakashi video stickers')`);
const both = await db.all(sql`
  SELECT sticker_format FROM sticker_pack_sets WHERE telegram_id = 42 ORDER BY sticker_format`);
console.log('formats:', both.map((r) => r.sticker_format));
assert.deepEqual(both.map((r) => r.sticker_format), ['static', 'video']);

// Idempotent: running setup again neither duplicates nor overwrites.
resetQuotePackSchemaCache();
await ensureQuotePackSchema();
const again = await db.all(sql`SELECT count(*) AS n FROM sticker_pack_sets`);
assert.equal(again[0].n, 2, 're-running setup changes nothing');

// ---- the unique index must back the ON CONFLICT target ------------------
const claim = (userId, format, name) => db.run(sql`
  INSERT INTO sticker_pack_sets
    (telegram_id, sticker_format, set_name, title, sticker_count, status, created_at, updated_at)
  VALUES (${userId}, ${format}, ${name}, 'T', 0, 'creating', 0, 0)
  ON CONFLICT(telegram_id, sticker_format) DO NOTHING`);

assert.equal((await claim(900, 'static', 'claim_static_900_by_missfrozen_bot')).rowsAffected, 1);
assert.equal((await claim(900, 'static', 'second_static_900_by_missfrozen_bot')).rowsAffected, 0,
  'a second static claim collides and is a no-op');
assert.equal((await claim(900, 'video', 'claim_video_900_by_missfrozen_bot')).rowsAffected, 1,
  'a video claim for the same user is a separate row');

const claimed = await db.all(sql`
  SELECT sticker_format, set_name FROM sticker_pack_sets
  WHERE telegram_id = 900 ORDER BY sticker_format`);
assert.deepEqual(claimed.map((r) => r.sticker_format), ['static', 'video']);
assert.equal(claimed[0].set_name, 'claim_static_900_by_missfrozen_bot', 'the first claim wins');

// Short names are globally unique across users.
let duplicateRejected = false;
try {
  await db.run(sql`INSERT INTO sticker_pack_sets (telegram_id, sticker_format, set_name, title)
    VALUES (901, 'static', 'claim_static_900_by_missfrozen_bot', 'T')`);
} catch (_) { duplicateRejected = true; }
assert.equal(duplicateRejected, true, 'a short name cannot be shared between users');

console.log('schema migration: OK');
