import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

// Drives the real render helpers against the SDK stubs: the /inventory JUTSU
// screen (commands + heal button colours), the quoted /balance card, the
// /gift_store rich table, the /ability link and command-reply threading.
test('ui updates: inventory jutsu screen, balance card, gift table, replies', () => {
  const output = execFileSync(
    process.execPath,
    ['--experimental-loader', './test/helpers/sdk-loader.mjs', 'test/helpers/run_ui_updates.mjs'],
    { cwd: new URL('..', import.meta.url), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  assert.match(output, /ui updates: OK/);
});
