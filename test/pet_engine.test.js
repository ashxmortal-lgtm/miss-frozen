import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

// Runs the real pet/property/daily modules against an in-memory SQLite WAL
// through a minimal SDK shim, so persistence, energy clocks, cooldowns,
// duplicate taps, feed fees and one-per-day settlement are executed — not mocked.
test('pet engine integration: persistence, timing, idempotency and property fees', () => {
  const output = execFileSync(
    process.execPath,
    ['--experimental-loader', './test/helpers/sdk-loader.mjs', 'test/helpers/run_pet_engine.mjs'],
    { cwd: new URL('..', import.meta.url), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  assert.match(output, /pet engine integration: OK/);
});
