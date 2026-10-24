// One-time upgrade: databases that still carry per-shinobi deaths get a single
// ACCOUNT death (the longest remaining timer) and every shinobi flag is cleared,
// so previously "dead" shinobi come straight back to work.
import assert from 'node:assert/strict';
import { db, sql } from './sdk_db_stub.mjs';

const now = () => Math.floor(Date.now() / 1000);
const LEGACY = 4001;
const ROBBED = 4002;

await db.run(sql`INSERT INTO users (telegram_id, balance, first_name)
  VALUES (${LEGACY}, 0, 'Legacy'), (${ROBBED}, 0, 'Robbed')`);
await db.run(sql`
  INSERT INTO shinobi_state (telegram_id, shinobi, dead_until, last_robbed_at)
  VALUES (${LEGACY}, 'Itachi', ${now() + 3600}, ${now() - 100}),
         (${LEGACY}, 'Sasuke', ${now() + 7200}, 0),
         (${ROBBED}, 'Sasuke', 0, ${now() - 60})
`);

// First touch runs the runtime migration (once per deployment).
const { getUserSkills } = await import('../../tgcloud/lib/rpg/state.js');
const legacy = await getUserSkills(LEGACY);
assert.ok(Number(legacy.deadUntil) > now() + 7000,
  'the longest per-shinobi death becomes the single account death');
assert.ok(Number(legacy.lastRobbedAt) > 0, 'the shinobi rob lockout moves to the account');

const robbed = await getUserSkills(ROBBED);
assert.equal(Number(robbed.deadUntil), 0, 'a user with no death stays alive');
assert.ok(Number(robbed.lastRobbedAt) > 0, 'the rob lockout follows the account');

const left = await db.get(sql`
  SELECT COUNT(*) AS n FROM shinobi_state WHERE dead_until > 0 OR last_robbed_at > 0
`);
assert.equal(Number(left.n), 0, 'every shinobi death / lockout row is cleared');

// A second call is a no-op (idempotent, restart-safe).
const again = await getUserSkills(LEGACY);
assert.equal(again.deadUntil, legacy.deadUntil, 'the fold never extends a timer');

console.log('death migration: OK');
