import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

// Drives the real pet UI, dialogue catalogue and callback router against an
// in-memory SQLite database: store/menu buttons, food navigation, stats, the
// dialogue catalogue and the owner/pet guards on every callback.
test('pet ui integration: screens, buttons, dialogues and callback guards', () => {
  const output = execFileSync(
    process.execPath,
    ['--experimental-loader', './test/helpers/sdk-loader.mjs', 'test/helpers/run_pet_ui.mjs'],
    { cwd: new URL('..', import.meta.url), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  assert.match(output, /pet ui integration: OK/);
});
