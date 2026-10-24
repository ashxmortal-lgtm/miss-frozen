import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');
const run = (helper) => execFileSync(
  process.execPath,
  ['--experimental-loader', './test/helpers/sdk-loader.mjs', helper],
  { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
);

// Death is the ACCOUNT's, not a shinobi's: one 24h timer on user_skills.
test('a kill marks the account dead once and never a shinobi', () => {
  assert.match(run('test/helpers/run_account_death.mjs'), /account death: OK/);
});

test('legacy per-shinobi deaths fold into one account death and are cleared', () => {
  assert.match(run('test/helpers/run_death_migration.mjs'), /death migration: OK/);
});

test('the shinobi death system is gone from the runtime code', () => {
  const files = [
    'tgcloud/lib/rpg/state.js',
    'tgcloud/lib/rpg/combat.js',
    'tgcloud/lib/rpg/status.js',
    'tgcloud/lib/rpg/training.js',
    'tgcloud/lib/activities.js',
    'tgcloud/lib/pet/store.js',
    'tgcloud/lib/profile.js',
    'tgcloud/lib/inventory.js',
    'tgcloud/lib/map/handler.js',
  ];
  for (const file of files) {
    const source = read(...file.split('/'));
    assert.doesNotMatch(source, /\bisDead\b/, file + ' never asks whether a shinobi is dead');
    assert.doesNotMatch(source, /\bmarkDead\b/, file + ' never kills a shinobi');
    assert.doesNotMatch(source, /deadShinobi|deadList/, file + ' keeps no dead-shinobi lists');
  }

  // Dispatch/training/pet availability must not refuse work because of death.
  const activities = read('tgcloud', 'lib', 'activities.js');
  assert.doesNotMatch(activities, /status:\s*'dead'/, 'a dispatch never reports "dead"');
  const pet = read('tgcloud', 'lib', 'pet', 'store.js');
  assert.doesNotMatch(pet, /return 'dead'/, 'pet availability never blocks a shinobi as dead');
});

test('account death lives on user_skills and every reader goes through it', () => {
  const schema = read('tgcloud', 'schema.js');
  const userSkills = schema.slice(schema.indexOf("table('user_skills'"), schema.indexOf('/** Hidden Tsunade'));
  assert.match(userSkills, /dead_until/, 'user_skills stores the account death timer');
  assert.match(userSkills, /last_robbed_at/, 'the robbery lockout is account-level too');
  assert.match(schema, /DEPRECATED: the shinobi death system is retired/,
    'the old shinobi column is documented as retired');

  const state = read('tgcloud', 'lib', 'rpg', 'state.js');
  assert.match(state, /export function isAccountDead/);
  assert.match(state, /export async function markAccountDead/);
  assert.match(state, /export async function reviveAccount/);
  assert.match(state, /DEATH_DURATION_SEC/, 'the death window is still 24h');

  const combat = read('tgcloud', 'lib', 'rpg', 'combat.js');
  assert.match(combat, /isAccountDead\(skills/, '/kill checks the account timer');
  assert.match(combat, /markAccountDead\(targetId\)/, '/kill flips the account timer');
  assert.match(combat, /user_skills SET last_robbed_at/, '/rob locks the account');
});

test('a stuck patrol can always settle and never keeps a shinobi busy forever', () => {
  const activities = read('tgcloud', 'lib', 'activities.js');
  assert.match(activities, /async function settleRow/, 'dispatch repairs an expired row in place');
  assert.match(activities, /ORDER BY ends_at ASC/, 'oldest returns are swept first');
  assert.match(activities, /\[sweep activities\]/, 'one broken row never aborts the whole sweep');
  assert.match(activities, /\[settle own repair\]/, 'an unpayable row is released, not kept active');

  const pet = read('tgcloud', 'lib', 'pet', 'store.js');
  assert.match(pet, /repairShinobiLocks/, 'pet Play releases orphan / finished locks');
});
