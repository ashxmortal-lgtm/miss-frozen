// Round 7 regression suite: death belongs to the ACCOUNT.
//
//  · one /kill marks user_skills.dead_until for 24h, never a shinobi row;
//  · a second kill inside the window is refused;
//  · shinobi keep patrolling / training / playing while the account is dead;
//  · a finished-but-unsettled activity can never keep a shinobi stuck;
//  · orphan pet locks are released.
// (The one-time legacy fold lives in run_death_migration.mjs — it runs once
//  per deployment, so it needs its own process.)
import assert from 'node:assert/strict';
import { db, sql } from './sdk_db_stub.mjs';
import { getUserSkills, getShinobiState } from '../../tgcloud/lib/rpg/state.js';
import { killTarget } from '../../tgcloud/lib/rpg/combat.js';
import { runActivity, settleOwn } from '../../tgcloud/lib/activities.js';
import { shinobiAvailability } from '../../tgcloud/lib/pet/store.js';
import { trainSession } from '../../tgcloud/lib/rpg/training.js';

const now = () => Math.floor(Date.now() / 1000);
const ATTACKER = 3001;
const VICTIM = 3002;
await db.run(sql`CREATE TABLE IF NOT EXISTS pending_patrol_rewards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id INTEGER NOT NULL,
  shinobi TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'patrol',
  reward INTEGER NOT NULL DEFAULT 0,
  completed_at INTEGER NOT NULL DEFAULT 0,
  claimed INTEGER NOT NULL DEFAULT 0
)`);

for (const id of [ATTACKER, VICTIM]) {
  await db.run(sql`INSERT INTO users (telegram_id, balance, first_name, xp)
    VALUES (${id}, 5000, 'Tester', 800)`);
}
for (const name of ['Itachi', 'Starter Shinobi', 'Sasuke', 'Tsunade']) {
  await db.run(sql`INSERT INTO inventory (telegram_id, item_type, item_name, qty)
    VALUES (${ATTACKER}, 'shinobi', ${name}, 1)`);
}
for (const name of ['Starter Shinobi', 'Sasuke', 'Tsunade']) {
  await db.run(sql`INSERT INTO inventory (telegram_id, item_type, item_name, qty)
    VALUES (${VICTIM}, 'shinobi', ${name}, 1)`);
}
await db.run(sql`UPDATE users SET equipped = 'Itachi' WHERE telegram_id = ${ATTACKER}`);

// ---- 1. one kill, one ACCOUNT timer ------------------------------------------
const first = await killTarget(ATTACKER, VICTIM, 'Sasuke');
assert.equal(first.code, 'ok', 'the first kill lands');
const account = await getUserSkills(VICTIM);
assert.ok(Number(account.deadUntil) > now() + 23 * 3600, 'the account is dead for 24h');
const deadRows = await db.get(sql`
  SELECT COUNT(*) AS n FROM shinobi_state WHERE telegram_id = ${VICTIM} AND dead_until > 0
`);
assert.equal(Number(deadRows.n), 0, 'no shinobi carries the death timer');

const second = await killTarget(ATTACKER, VICTIM, 'Starter Shinobi');
assert.equal(second.code, 'already_dead', 'one kill per account per 24h');
assert.equal(second.reviveAt, account.deadUntil, 'the refusal reports the account revive time');
const kills = await db.get(sql`SELECT kills FROM users WHERE telegram_id = ${ATTACKER}`);
assert.equal(kills.kills, 1, 'the refused kill pays nothing');

// ---- 2. the dead account's shinobi keep working ------------------------------
const patrol = await runActivity({ id: VICTIM, first_name: 'Tester' }, 'patrol', 'Starter Shinobi', -900);
assert.equal(patrol.status, 'ok', 'a shinobi patrols normally while the account is dead');
assert.doesNotMatch(patrol.body, /dead/i, 'no death text in the dispatch reply');

assert.equal(await shinobiAvailability(VICTIM, 'Sasuke'), null,
  'pet Play finds the shinobi available while the account is dead');
const train = await trainSession(VICTIM, 'Sasuke', 'Tsunade');
assert.equal(train.code, 'ok', 'training works while the account is dead');
const patrolState = await getShinobiState(VICTIM, 'Starter Shinobi');
assert.equal(patrolState.deadUntil, undefined, 'shinobi state exposes no death timer');

// ---- 3. a finished activity never keeps a shinobi stuck ---------------------
const t = now();
await db.run(sql`
  UPDATE activities SET status = 'active', kind = 'patrol',
    started_at = ${t - 7200}, ends_at = ${t - 60}
  WHERE telegram_id = ${VICTIM} AND shinobi = 'Starter Shinobi'
`);
const settled = await settleOwn({ id: VICTIM });
assert.equal(settled.blocks.length, 1, 'the overdue patrol is settled');
const settledRow = await db.get(sql`
  SELECT status FROM activities WHERE telegram_id = ${VICTIM} AND shinobi = 'Starter Shinobi'
`);
assert.equal(settledRow.status, 'idle', 'the stuck patrol row is released');

// A row that is due when the player dispatches again is repaired in place.
// (Clear the patrol-exhaustion timer so only the stale row is under test.)
await db.run(sql`
  UPDATE shinobi_state SET exhausted_until = 0, patrol_streak = 0
  WHERE telegram_id = ${VICTIM} AND shinobi = 'Starter Shinobi'
`);
await db.run(sql`
  UPDATE activities SET status = 'active', kind = 'patrol',
    started_at = ${t - 7200}, ends_at = ${t - 60}
  WHERE telegram_id = ${VICTIM} AND shinobi = 'Starter Shinobi'
`);
const again = await runActivity({ id: VICTIM, first_name: 'Tester' }, 'patrol', 'Starter Shinobi', -900);
assert.equal(again.status, 'ok', 'an expired row does not report a phantom busy state');

// ---- 4. orphan pet locks are released ---------------------------------------
await db.run(sql`
  INSERT OR IGNORE INTO activities (telegram_id, shinobi, kind, status)
  VALUES (${VICTIM}, 'Sasuke', 'pet', 'active')
`);
await db.run(sql`
  UPDATE activities SET status = 'active', kind = 'pet',
    started_at = ${t - 7200}, ends_at = ${t - 60}
  WHERE telegram_id = ${VICTIM} AND shinobi = 'Sasuke'
`);
assert.equal(await shinobiAvailability(VICTIM, 'Sasuke'), null,
  'a pet lock without a live pet session is released');
const orphan = await db.get(sql`
  SELECT status FROM activities WHERE telegram_id = ${VICTIM} AND shinobi = 'Sasuke'
`);
assert.equal(orphan.status, 'idle', 'the orphan lock row is idle again');

console.log('account death: OK');
