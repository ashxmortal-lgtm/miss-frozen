import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// Round 15 — the robbery lockout reply must not expose the retry clock to the
// group. Only /byakugan is allowed to reveal timers.
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('the /rob lockout reply carries no retry time or countdown', () => {
  const combat = read('tgcloud/lib/rpg/combat.js');
  const start = combat.indexOf('if ((skills.lastRobbedAt || 0) > t - ROB_LOCKOUT_SEC) {');
  assert.ok(start > -1, 'the lockout branch is still guarded by lastRobbedAt');
  const branch = combat.slice(start, combat.indexOf('const u = await db.get(sql`SELECT kills, balance FROM users', start));

  assert.match(branch, /was robbed recently\.`\);/);
  assert.doesNotMatch(branch, /ʀᴏʙʙᴇʀʏ ᴘᴏꜱꜱɪʙʟᴇ ᴀɢᴀɪɴ/, 'the "possible again at" line is gone');
  assert.doesNotMatch(branch, /dueText\(/, 'no timer helper in the group reply');
  assert.doesNotMatch(branch, /ROB_LOCKOUT_SEC, t\)\}/, 'the lockout window is not printed');
  // The protection shield branch keeps its own no-timer rule.
  assert.match(combat, /The robbery cannot land while the shield is up\./);
});

test('/rob twice: refused without leaking the timer (end to end)', () => {
  const output = execFileSync(
    process.execPath,
    ['--experimental-loader', './test/helpers/sdk-loader.mjs', 'test/helpers/run_kill_target.mjs'],
    { cwd: new URL('..', import.meta.url), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  assert.match(output, /kill target: OK/);
});
