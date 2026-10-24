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

// Regression: the pet card is a rich message with a photo. Telegram refuses to
// edit a media message into a text message, so the 🎾 Play screen (and every
// other screen opened from the card) must be rendered WITH the pet photo —
// otherwise the button answers the callback but nothing changes on screen.
test('pet card screens keep the photo so button taps are never silent', () => {
  const output = execFileSync(
    process.execPath,
    ['--experimental-loader', './test/helpers/sdk-loader.mjs', 'test/helpers/run_pet_play_button.mjs'],
    { cwd: new URL('..', import.meta.url), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  assert.match(output, /pet play button: OK/);
});

// Regression: a failing shinobi check or a refused edit used to swallow the
// Play tap completely (the callback was acknowledged before the error).
test('pet Play always answers visibly, even when the check or the edit fails', () => {
  const output = execFileSync(
    process.execPath,
    ['--experimental-loader', './test/helpers/sdk-loader.mjs', 'test/helpers/run_pet_play_resilience.mjs'],
    { cwd: new URL('..', import.meta.url), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  assert.match(output, /pet play resilience: OK/);
});
