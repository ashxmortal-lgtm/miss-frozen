/**
 * Lazy schema setup for `/own` sticker packs.
 *
 * New packs live in `sticker_pack_sets`, keyed by a unique index on
 * `(telegram_id, sticker_format)` so one user can hold a static pack *and* a
 * video pack at the same time.
 *
 * Why a second table instead of changing `quote_sticker_packs`:
 *   that table was deployed with `telegram_id INTEGER PRIMARY KEY` (one pack per
 *   user). SQLite cannot ALTER a column, so redeclaring it makes the platform
 *   demand a destructive "change column" migration, which blocks the deploy. The
 *   old table is therefore left untouched and this module only ever *adds* a
 *   table — the one migration class the platform applies automatically.
 *
 * `ensureQuotePackSchema()` mirrors the platform DDL so the runtime works even
 * before `npx tgcloud migrate` runs, and `adoptLegacyPacks()` copies any pack a
 * user created under the old table (best-effort, idempotent, never overwrites).
 *
 * TARGET must stay equivalent to the `stickerPackSets` declaration in
 * tgcloud/schema.js — `test/schema_contract.test.js` fails if they drift.
 */

import { db } from 'sdk';
import { sql } from 'sdk/db';

export const TABLE = 'sticker_pack_sets';
export const LEGACY_TABLE = 'quote_sticker_packs';

const CREATE = `CREATE TABLE IF NOT EXISTS sticker_pack_sets (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id    INTEGER NOT NULL,
  sticker_format TEXT    NOT NULL DEFAULT 'static',
  set_name       TEXT    NOT NULL,
  title          TEXT    NOT NULL,
  sticker_count  INTEGER NOT NULL DEFAULT 0,
  status         TEXT    NOT NULL DEFAULT 'creating',
  last_error     TEXT,
  created_at     INTEGER NOT NULL DEFAULT 0,
  updated_at     INTEGER NOT NULL DEFAULT 0
)`;

/** Mirrors `owner` in tgcloud/schema.js — the ON CONFLICT target. */
const CREATE_OWNER_INDEX = 'CREATE UNIQUE INDEX IF NOT EXISTS uidx_sticker_pack_owner '
  + 'ON sticker_pack_sets (telegram_id, sticker_format)';

/** Mirrors `nameUnique` in tgcloud/schema.js. */
const CREATE_NAME_INDEX = 'CREATE UNIQUE INDEX IF NOT EXISTS uidx_sticker_pack_name '
  + 'ON sticker_pack_sets (set_name)';

let schemaPromise = null;

/**
 * Copy packs created under the legacy table into the new one.
 *
 * The legacy key allowed one pack per user, so a row can only collide with
 * itself. `INSERT OR IGNORE` keeps whatever the new table already holds — an
 * existing (and possibly newer) pack link always wins.
 */
async function adoptLegacyPacks() {
  try {
    const legacyExists = await db.get(sql`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${LEGACY_TABLE}
    `);
    if (!legacyExists) return;
    await db.run(sql`
      INSERT OR IGNORE INTO sticker_pack_sets
        (telegram_id, sticker_format, set_name, title, sticker_count, status,
         last_error, created_at, updated_at)
      SELECT telegram_id, COALESCE(sticker_format, 'static'), set_name, title,
             sticker_count, status, last_error, created_at, updated_at
      FROM quote_sticker_packs
    `);
  } catch (e) {
    // Never let a legacy copy break /own; the user simply starts a fresh pack.
    console.error('[sticker pack schema] legacy adopt skipped', e?.message || e);
  }
}

/**
 * Ensure the pack table exists. Resolves once per isolate.
 */
export function ensureQuotePackSchema() {
  if (schemaPromise) return schemaPromise;
  schemaPromise = (async () => {
    try {
      await db.run(sql.raw(CREATE));
      await db.run(sql.raw(CREATE_OWNER_INDEX));
      await db.run(sql.raw(CREATE_NAME_INDEX));
    } catch (e) {
      console.error('[sticker pack schema]', e?.message || e);
    }
    await adoptLegacyPacks();
  })();
  return schemaPromise;
}

/** Test hook: forget that the schema was checked. */
export function resetQuotePackSchemaCache() {
  schemaPromise = null;
}
