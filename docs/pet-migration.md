# Legacy pet restoration (`missfrozen_pet_migration.json`)

One-time restoration of the pets users owned in the previous Python bot
(`economy.db`) into the MissFrozen pet system. Nothing runs on a schedule: the
check happens on the user's **first interaction** with the bot and is then
remembered forever.

## Source data

| Path | Role |
|---|---|
| `tgcloud/lib/pet/data/missfrozen_pet_migration.json` | Canonical snapshot exported from `economy.db` (kept verbatim in the repo) |
| `tgcloud/lib/pet/migration_data.js` | Generated JS mirror the runtime imports (TGCloud only bundles `.js` modules) |
| `scripts/generate_pet_migration_data.js` | `npm run generate:pet-migration` — regenerates the mirror |

Snapshot contents (format `missfrozen_pet_migration_v1`, generated
2026-10-22T10:04:40Z): 4 users, 6 pets.

The runtime never reads the JSON file, never calls the network and has no
dependency on the Python bot. `test/pet_migration.test.js` fails if the JSON and
the generated mirror drift apart.

## When it runs

`restorePetsOnFirstInteraction(userId)` is called from both routers before any
command/callback is handled:

- `tgcloud/handlers/message.js` (any non-bot sender, private or group)
- `tgcloud/handlers/callback_query.js` (a first tap counts as an interaction)

After the user is marked processed, each call is a single primary-key lookup in
`pet_migration_status`. Errors are logged and swallowed so message routing is
never blocked.

## What is restored

For every pet in that user's `owned_pets`:

| Field | Behaviour |
|---|---|
| `pet_id` | Restored exactly (`axofly`, `capycorn`). Unknown ids in the snapshot are skipped and counted — a pet is never invented |
| `xp` | Preserved exactly, clamped to `0 … 15,000` |
| `custom_name` | Preserved verbatim (control characters stripped); `null` keeps the catalogue name |
| `level` | Derived from XP by the engine. If the snapshot's level is **higher** than its XP implies, XP is raised to that level's threshold, so the restored level is never lower than the migrated one |
| `equipped` | Restored only when the user has no live equipped pet |
| energy / status | Full energy, `READY`, no activity, no cooldowns |

A `pet_stats` row is created when at least one pet is restored. Restoration
never charges coins, never writes a `purchases` row and sends no extra message —
`/pet` simply shows the restored pet.

## Users without pets

A user who is absent from the snapshot, or whose `owned_pets` is empty, receives
no pet. The check still completes and is recorded (`outcome = 'none'`).

## Idempotency and concurrency

1. **Claim.** `pet_migration_status` holds one row per user. A fresh worker
   inserts it as `processing`; an existing `processing` row younger than
   `PET_MIGRATION_CLAIM_TTL_SECONDS` (60 s) means another worker is already
   restoring, so this call returns `in_progress`. An older (abandoned) claim is
   taken over with a compare-and-swap on `processed_at`.
2. **Restore.** Every write is `INSERT OR IGNORE`, so a second worker (or a
   retry) can never duplicate a pet. An existing `user_pets` row is left exactly
   as-is — live XP, name, energy and cooldowns always win over the snapshot.
   Equipping uses `INSERT OR IGNORE INTO equipped_pet`, so a live choice is
   never replaced.
3. **Mark.** The claim flips to `processed` **only after** the restore (or the
   empty check) returns successfully. If anything throws, the claim is deleted
   and the next interaction retries from scratch.

Because of this the same user can be processed again safely — e.g. when a newer
snapshot export is shipped: the marker stores the snapshot identity
(`format@generated_at_utc`), so a new export re-checks each user exactly once
more and still cannot duplicate or overwrite anything.

## Schema setup

New additive table (declared in `tgcloud/schema.js`, created lazily by
`ensurePetMigrationSchema()`):

```sql
CREATE TABLE IF NOT EXISTS pet_migration_status (
  telegram_id    INTEGER PRIMARY KEY,
  source         TEXT NOT NULL,     -- format@generated_at_utc
  status         TEXT NOT NULL,     -- 'processing' | 'processed'
  outcome        TEXT,              -- 'restored' | 'none'
  pets_restored  INTEGER NOT NULL DEFAULT 0,
  pets_skipped   INTEGER NOT NULL DEFAULT 0,  -- already owned or unknown id
  processed_at   INTEGER NOT NULL DEFAULT 0
);
```

Deploy steps (owner, not run by this change):

```sh
npx tgcloud migrate   # adds pet_migration_status
npx tgcloud push      # deploys handlers + lib/pet/migration*.js
```

No reset, no backfill job, no change to `user_pets` or `equipped_pet`.

## Checking a user

```js
import { getPetMigrationStatus } from './tgcloud/lib/pet/migration.js';
await getPetMigrationStatus(1292564068);
// { telegramId, source, status: 'processed', outcome: 'restored', petsRestored: 1, ... }
```

`outcome = 'restored'` means at least one pet row was inserted; `'none'` means
the user had no pets in the snapshot **or** already owned every migrated pet
(`pets_skipped` counts them).

## Tests

`test/pet_migration.test.js` + `test/helpers/run_pet_migration.mjs` run the real
module against in-memory SQLite:

- single-pet owner with a custom name — XP/name/equip preserved;
- multi-pet owners — every pet restored, exactly one equipped;
- user without pets — nothing created, nothing charged;
- repeated interactions — `already_processed`, no duplicate rows;
- existing live data — XP/name/energy kept, live equip choice kept;
- failures — no `processed` marker, retry completes;
- concurrency — in-flight claim respected, stale claim taken over, `Promise.all`
  double interaction yields one row;
- normalisation — unknown pet ids skipped, level flooring, XP cap.
