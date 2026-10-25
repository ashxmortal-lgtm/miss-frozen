/**
 * Lazy schema setup for `/own` sticker packs.
 *
 * The pack table is keyed `(telegram_id, sticker_format)` because Telegram sets
 * are single-format: one user legitimately owns a static pack *and* a video
 * pack at the same time.
 *
 * Uniqueness comes from a table-level unique index (the same mechanism
 * `daily_missions` uses), which is also the conflict target for
 * `ON CONFLICT(telegram_id, sticker_format)` in quote/packs.js.
 *
 * Earlier builds shipped a single-column primary key (`telegram_id`), which
 * physically cannot hold those two rows. `ensureQuotePackSchema()` therefore
 * creates the table when missing and, when it finds a legacy shape, rebuilds
 * it (rename → create → copy → drop) so nobody loses an existing pack link.
 *
 * IMPORTANT: this DDL must stay byte-for-byte equivalent to the
 * `quoteStickerPacks` declaration in tgcloud/schema.js — the platform compiles
 * that one at deploy time. `test/schema_contract.test.js` fails if they drift.
 *
 * Everything is best-effort: a failure is logged and the command still runs
 * against whatever table exists, rather than taking `/q` down with it.
 */

import { db } from 'sdk';
import { sql } from 'sdk/db';

const CREATE = `CREATE TABLE IF NOT EXISTS quote_sticker_packs (
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

/** Mirrors `owner` in tgcloud/schema.js. */
const CREATE_OWNER_INDEX = 'CREATE UNIQUE INDEX IF NOT EXISTS uidx_quote_pack_owner '
  + 'ON quote_sticker_packs (telegram_id, sticker_format)';

/** Mirrors `nameUnique` in tgcloud/schema.js. */
const CREATE_NAME_INDEX = 'CREATE UNIQUE INDEX IF NOT EXISTS uidx_quote_pack_name '
  + 'ON quote_sticker_packs (set_name)';

let schemaPromise = null;

/**
 * True when the live table can already hold one row per (user, format).
 * Satisfied by either shape (composite primary key from a never-deployed build,
 * or the unique index this build creates).
 */
function hasOwnerKey(createSql, ownerIndex) {
  if (ownerIndex) return true;
  const normalised = String(createSql || '').replace(/\s+/g, ' ').toLowerCase();
  return normalised.includes('primary key (telegram_id, sticker_format)');
}

/**
 * Rebuild a legacy single-key table in place.
 * Rows are copied verbatim; the legacy key allowed only one pack per user, so
 * there is never a conflict on the new composite key.
 */
async function migrateLegacyTable() {
  try {
    await db.run(sql.raw('ALTER TABLE quote_sticker_packs RENAME TO quote_sticker_packs_legacy'));
  } catch (e) {
    console.error('[sticker pack schema] rename failed', e?.message || e);
    return;
  }
  try {
    await db.run(sql.raw(CREATE));
    await db.run(sql.raw(`INSERT OR IGNORE INTO quote_sticker_packs
      (telegram_id, sticker_format, set_name, title, sticker_count, status,
       last_error, created_at, updated_at)
      SELECT telegram_id, COALESCE(sticker_format, 'static'), set_name, title,
             sticker_count, status, last_error, created_at, updated_at
      FROM quote_sticker_packs_legacy`));
    await db.run(sql.raw('DROP TABLE quote_sticker_packs_legacy'));
    await db.run(sql.raw(CREATE_OWNER_INDEX));
    console.log('[sticker pack schema] migrated to (telegram_id, sticker_format)');
  } catch (e) {
    console.error('[sticker pack schema] migration failed', e?.message || e);
  }
}

/**
 * Ensure the table exists with the composite key. Resolves once per isolate.
 */
export function ensureQuotePackSchema() {
  if (schemaPromise) return schemaPromise;
  schemaPromise = (async () => {
    try {
      const existing = await db.get(sql`
        SELECT sql FROM sqlite_master
        WHERE type = 'table' AND name = 'quote_sticker_packs'
      `);
      const ownerIndex = await db.get(sql`
        SELECT name FROM sqlite_master
        WHERE type = 'index' AND name = 'uidx_quote_pack_owner'
      `);
      if (existing && !hasOwnerKey(existing.sql, ownerIndex)) {
        await migrateLegacyTable();
      } else if (!existing) {
        await db.run(sql.raw(CREATE));
      }
      await db.run(sql.raw(CREATE_OWNER_INDEX));
      await db.run(sql.raw(CREATE_NAME_INDEX));
    } catch (e) {
      // sqlite_master may be unavailable (or the DDL already exists in another
      // shape). Fall back to a plain create; the queries below tolerate both.
      console.error('[sticker pack schema]', e?.message || e);
      try {
        await db.run(sql.raw(CREATE));
        await db.run(sql.raw(CREATE_OWNER_INDEX));
        await db.run(sql.raw(CREATE_NAME_INDEX));
      } catch (inner) {
        console.error('[sticker pack schema] create failed', inner?.message || inner);
      }
    }
  })();
  return schemaPromise;
}

/** Test hook: forget that the schema was checked. */
export function resetQuotePackSchemaCache() {
  schemaPromise = null;
}
