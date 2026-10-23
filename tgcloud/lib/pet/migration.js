/**
 * One-time pet restoration from the legacy `economy.db` snapshot.
 *
 * The old Python bot exported every pet owner to
 * `tgcloud/lib/pet/data/missfrozen_pet_migration.json`; the deployable mirror is
 * `./migration_data.js` (generated — TGCloud only bundles `.js` modules).
 *
 * Behaviour:
 *  - Runs on a user's first interaction (message or callback) via
 *    `restorePetsOnFirstInteraction`. No cron, no timers, no startup job.
 *  - Restores EVERY owned pet of that Telegram id: pet id, XP, custom name and
 *    the equipped pet. Level is derived from XP by the pet engine; when the
 *    snapshot's level is higher than its XP implies, XP is raised to that level's
 *    floor so the restored level is never lower than the migrated one.
 *  - Users absent from the snapshot (or with an empty `owned_pets`) get nothing.
 *  - Idempotent + concurrency-safe: pets are written with `INSERT OR IGNORE`, a
 *    live row/equipped choice is never overwritten, and a single claim row in
 *    `pet_migration_status` serialises workers. The claim is only marked
 *    `processed` AFTER restoration succeeds; a crash rolls the claim back so the
 *    next interaction retries.
 */
import { db } from 'sdk';
import { sql } from 'sdk/db';
import { ensurePetSchema } from './store.js';
import {
  PETS, PET_MAX_LEVEL, PET_MAX_ENERGY, PET_XP_CAP, PET_XP_THRESHOLDS,
  petLevelForXp, sanitizePetName,
} from './defs.js';
import { PET_MIGRATION_SNAPSHOT } from './migration_data.js';

const now = () => Math.floor(Date.now() / 1000);

/** A `processing` claim older than this is considered abandoned. */
export const PET_MIGRATION_CLAIM_TTL_SECONDS = 60;

/** Identity of the snapshot: a new export re-checks users exactly once more. */
export function petMigrationSourceKey(snapshot = PET_MIGRATION_SNAPSHOT) {
  const format = String(snapshot?.format || 'missfrozen_pet_migration_v1');
  const stamp = String(snapshot?.generated_at_utc || 'unknown');
  return `${format}@${stamp}`;
}

export const PET_MIGRATION_SOURCE = petMigrationSourceKey(PET_MIGRATION_SNAPSHOT);

function buildIndex(snapshot) {
  const map = new Map();
  const users = Array.isArray(snapshot?.users) ? snapshot.users : [];
  for (const entry of users) {
    const id = Number(entry?.user_id);
    if (!Number.isSafeInteger(id) || id <= 0) continue;
    if (!Array.isArray(entry.owned_pets)) continue;
    map.set(id, entry);
  }
  return map;
}

const MIGRATION_USERS = buildIndex(PET_MIGRATION_SNAPSHOT);

/** Every Telegram id present in the bundled snapshot (used by tests/ops). */
export const PET_MIGRATION_USER_IDS = [...MIGRATION_USERS.keys()];

/** The raw snapshot record for one user, or null. */
export function petMigrationRecordFor(userId) {
  const id = Number(userId);
  if (!Number.isSafeInteger(id)) return null;
  return MIGRATION_USERS.get(id) || null;
}

let migrationSchemaPromise = null;

/** Runtime safety net; `tgcloud migrate` remains the canonical migration. */
export function ensurePetMigrationSchema() {
  if (migrationSchemaPromise) return migrationSchemaPromise;
  migrationSchemaPromise = (async () => {
    const ddl = `CREATE TABLE IF NOT EXISTS pet_migration_status (
      telegram_id INTEGER PRIMARY KEY,
      source TEXT NOT NULL,
      status TEXT NOT NULL,
      outcome TEXT,
      pets_restored INTEGER NOT NULL DEFAULT 0,
      pets_skipped INTEGER NOT NULL DEFAULT 0,
      processed_at INTEGER NOT NULL DEFAULT 0
    )`;
    try {
      await db.run(sql.raw(ddl));
    } catch (e) {
      console.error('[pet migration schema]', e?.message || e);
    }
  })();
  return migrationSchemaPromise;
}

/**
 * Normalise one snapshot pet into the live `user_pets` shape.
 * Returns null for a pet id this build does not know (never invents a pet).
 */
export function normalizeMigratedPet(entry) {
  const petId = String(entry?.pet_id || '').trim().toLowerCase();
  if (!PETS[petId]) return null;

  const rawXp = Number(entry?.xp);
  const snapshotXp = Number.isFinite(rawXp)
    ? Math.min(PET_XP_CAP, Math.max(0, Math.trunc(rawXp)))
    : 0;

  const rawLevel = Number(entry?.level);
  const snapshotLevel = Number.isFinite(rawLevel)
    && rawLevel >= 1 && rawLevel <= PET_MAX_LEVEL
    ? Math.trunc(rawLevel)
    : null;

  // XP is authoritative; only raise it to the migrated level's floor.
  const xp = snapshotLevel == null
    ? snapshotXp
    : Math.min(PET_XP_CAP, Math.max(snapshotXp, PET_XP_THRESHOLDS[snapshotLevel] || 0));

  const customName = sanitizePetName(entry?.custom_name ?? '') || null;

  return {
    petId,
    xp,
    level: petLevelForXp(xp),
    equipped: entry?.equipped === true,
    customName,
  };
}

/**
 * Restore every pet of one snapshot record. Idempotent by construction:
 * `INSERT OR IGNORE` keeps an existing live row (and its progress) untouched.
 */
export async function restorePetsForRecord(userId, record, options = {}) {
  const id = Number(userId);
  if (!Number.isSafeInteger(id) || id <= 0) {
    return { restored: [], kept: [], ignored: [], equipped: null };
  }
  await ensurePetMigrationSchema();
  await ensurePetSchema();

  const t = options.now != null ? Number(options.now) : now();
  const entries = Array.isArray(record?.owned_pets) ? record.owned_pets : [];
  const restored = [];
  const kept = [];
  const ignored = [];
  let equipCandidate = null;

  for (const entry of entries) {
    const pet = normalizeMigratedPet(entry);
    if (!pet) {
      ignored.push(String(entry?.pet_id ?? ''));
      continue;
    }
    const inserted = await db.run(sql`
      INSERT OR IGNORE INTO user_pets
        (telegram_id, pet_id, pet_name, xp, energy, last_energy_at, equipped, acquired_at)
      VALUES (${id}, ${pet.petId}, ${pet.customName}, ${pet.xp}, ${PET_MAX_ENERGY}, ${t}, 0, ${t})
    `);
    if (inserted.rowsAffected === 1) restored.push(pet.petId);
    else kept.push(pet.petId); // live row: never overwrite progress
    if (pet.equipped && !equipCandidate) equipCandidate = pet.petId;
  }

  // Equip only when the user has no active pet yet — a live choice wins.
  let equipped = null;
  if (equipCandidate) {
    const claimed = await db.run(sql`
      INSERT OR IGNORE INTO equipped_pet (telegram_id, pet_id, updated_at)
      VALUES (${id}, ${equipCandidate}, ${t})
    `);
    if (claimed.rowsAffected === 1) {
      equipped = equipCandidate;
      await db.run(sql`
        UPDATE user_pets SET equipped = CASE WHEN pet_id = ${equipCandidate} THEN 1 ELSE 0 END
        WHERE telegram_id = ${id}
      `);
    }
  }

  if (restored.length) {
    try {
      await db.run(sql`INSERT OR IGNORE INTO pet_stats (telegram_id) VALUES (${id})`);
    } catch (e) { console.error('[pet migration stats]', e?.message || e); }
  }

  return { restored, kept, ignored, equipped };
}

/** Persisted bookkeeping row for one user (null when never checked). */
export async function getPetMigrationStatus(userId) {
  const id = Number(userId);
  if (!Number.isSafeInteger(id)) return null;
  await ensurePetMigrationSchema();
  const row = await db.get(sql`
    SELECT telegram_id, source, status, outcome, pets_restored, pets_skipped, processed_at
    FROM pet_migration_status WHERE telegram_id = ${id}
  `);
  if (!row) return null;
  return {
    telegramId: Number(row.telegram_id),
    source: row.source,
    status: row.status,
    outcome: row.outcome || null,
    petsRestored: Number(row.pets_restored || 0),
    petsSkipped: Number(row.pets_skipped || 0),
    processedAt: Number(row.processed_at || 0),
  };
}

async function releaseClaim(id, claimTs) {
  try {
    await db.run(sql`
      DELETE FROM pet_migration_status
      WHERE telegram_id = ${id} AND status = 'processing' AND processed_at = ${claimTs}
    `);
  } catch (e) {
    console.error('[pet migration release]', e?.message || e);
  }
}

/**
 * Run (at most once) the legacy pet restoration for one user.
 * Called from the message + callback routers on every interaction; the marker
 * table turns every later call into a single primary-key lookup.
 *
 * @returns {Promise<{status: string, restored: number, kept?: string[],
 *   ignored?: string[], equipped?: string|null, matched?: boolean,
 *   outcome?: string|null}>}
 */
export async function restorePetsOnFirstInteraction(userId, options = {}) {
  const id = Number(userId);
  if (!Number.isSafeInteger(id) || id <= 0) return { status: 'invalid_user', restored: 0 };

  await ensurePetMigrationSchema();
  await ensurePetSchema();

  const source = PET_MIGRATION_SOURCE;
  const t = options.now != null ? Number(options.now) : now();

  const existing = await db.get(sql`
    SELECT telegram_id, source, status, outcome, pets_restored, pets_skipped, processed_at
    FROM pet_migration_status WHERE telegram_id = ${id}
  `);

  if (existing && existing.source === source && existing.status === 'processed') {
    return {
      status: 'already_processed',
      outcome: existing.outcome || null,
      restored: 0,
      matched: MIGRATION_USERS.has(id),
    };
  }

  const claimTs = t;
  let claimed = false;

  if (!existing) {
    const inserted = await db.run(sql`
      INSERT OR IGNORE INTO pet_migration_status
        (telegram_id, source, status, outcome, pets_restored, pets_skipped, processed_at)
      VALUES (${id}, ${source}, 'processing', NULL, 0, 0, ${claimTs})
    `);
    claimed = inserted.rowsAffected === 1;
  } else if (
    existing.source === source
    && existing.status === 'processing'
    && t - Number(existing.processed_at || 0) < PET_MIGRATION_CLAIM_TTL_SECONDS
  ) {
    // Another worker is restoring this user right now.
    return { status: 'in_progress', restored: 0, matched: MIGRATION_USERS.has(id) };
  } else {
    // Stale claim, or a newer snapshot: take it over with a compare-and-swap.
    const takeover = await db.run(sql`
      UPDATE pet_migration_status
      SET source = ${source}, status = 'processing', outcome = NULL,
          pets_restored = 0, pets_skipped = 0, processed_at = ${claimTs}
      WHERE telegram_id = ${id}
        AND source = ${existing.source}
        AND status = ${existing.status}
        AND processed_at = ${existing.processed_at}
    `);
    claimed = takeover.rowsAffected === 1;
  }

  if (!claimed) return { status: 'in_progress', restored: 0, matched: MIGRATION_USERS.has(id) };

  const record = MIGRATION_USERS.get(id) || null;
  try {
    const result = await restorePetsForRecord(id, record, { now: t });
    const restored = result.restored.length;
    const skipped = result.kept.length + result.ignored.length;
    const outcome = restored > 0 ? 'restored' : 'none';

    const marked = await db.run(sql`
      UPDATE pet_migration_status
      SET status = 'processed', outcome = ${outcome}, pets_restored = ${restored},
          pets_skipped = ${skipped}, processed_at = ${now()}
      WHERE telegram_id = ${id} AND status = 'processing' AND processed_at = ${claimTs}
    `);
    if (marked.rowsAffected === 0) {
      // Our claim was taken over by a retry; the restore itself was idempotent.
      console.error('[pet migration] claim taken over', id);
    }
    if (restored > 0 || skipped > 0) {
      console.log(`[pet migration] user ${id}: restored=${restored} skipped=${skipped} equipped=${result.equipped || '-'}`);
    }
    return {
      status: outcome,
      outcome,
      restored,
      kept: result.kept,
      ignored: result.ignored,
      equipped: result.equipped,
      matched: !!record,
    };
  } catch (e) {
    console.error('[pet migration]', id, e?.message || e);
    await releaseClaim(id, claimTs);
    return { status: 'error', restored: 0, matched: !!record };
  }
}
