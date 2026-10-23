import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const run = (helper) => execFileSync(
  process.execPath,
  ['--experimental-loader', './test/helpers/sdk-loader.mjs', helper],
  { cwd: new URL('..', import.meta.url), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
);

// /kill & /rob must target a real equipped shinobi even when a legacy
// `Starter Shinobi` row still sits in slot 0.
test('/kill targets the equipped shinobi, not a shadowing starter row', () => {
  assert.match(run('test/helpers/run_kill_target.mjs'), /kill target: OK/);
});

// /claim · /daily prompts (DM, group, already claimed) and the in-place /lb
// Global leaderboard switch.
test('claim prompts and the leaderboard switch follow the requested flow', () => {
  assert.match(run('test/helpers/run_claim_lb.mjs'), /claim & leaderboard: OK/);
});
