import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// Round 14 — a dead account that has not been robbed yet can still /protect:
// Jiraiya's shield blocks /rob exactly like it blocks /kill.
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('/rob checks Jiraiya protection before the robbery lockout', () => {
  const combat = read('tgcloud/lib/rpg/combat.js');
  const rob = combat.slice(
    combat.indexOf('export async function handleRob'),
    combat.indexOf('// ---- /protect ----'),
  );
  assert.match(rob, /const skills = await getUserSkills\(target\.id\)/, 'the target account is read');
  assert.match(rob, /if \(\(skills\.protectedUntil \|\| 0\) > t\) \{/, 'the shield is checked');
  assert.match(rob, /The robbery cannot land while the shield is up\./, 'the robber is told why');
  const shieldAnswer = rob.slice(
    rob.indexOf('if ((skills.protectedUntil || 0) > t) {'),
    rob.indexOf('if ((skills.lastRobbedAt || 0) > t - ROB_LOCKOUT_SEC) {'),
  );
  assert.doesNotMatch(shieldAnswer, /dueText|ᴘʀᴏᴛᴇᴄᴛɪᴏɴ ᴇɴᴅꜱ/, 'no shield timer leaks into the group');
  assert.ok(
    rob.indexOf('skills.protectedUntil') < rob.indexOf('skills.lastRobbedAt'),
    'the shield is answered before the "robbed recently" lockout',
  );
  assert.ok(
    rob.indexOf('skills.protectedUntil') > rob.indexOf('isAccountDead(skills, t)'),
    'death is still required before any robbery',
  );
});

test('the /protect card names /rob next to /kill', () => {
  const combat = read('tgcloud/lib/rpg/combat.js');
  const protect = combat.slice(
    combat.indexOf('export async function handleProtect'),
    combat.indexOf('// ---- /byakugan ----'),
  );
  assert.match(protect, /Itachi\\'s \/kill and \/rob cannot succeed while protected\./);
});

test('dead account protecting itself is un-robbable end to end', () => {
  const output = execFileSync(
    process.execPath,
    ['--experimental-loader', './test/helpers/sdk-loader.mjs', 'test/helpers/run_rob_protection.mjs'],
    { cwd: new URL('..', import.meta.url), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  assert.match(output, /rob protection: OK/);
});
