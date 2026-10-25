import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// Round 10 — timers are private knowledge.
//
// A group message must never print when a shield ends or when a dead account
// revives: that is exactly what /byakugan exists for, and it answers only the
// scanner (ephemeral). The owner instead gets one DM shortly before the shield
// drops.
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

function sliceBetween(source, start, end) {
  const from = source.indexOf(start);
  assert.ok(from >= 0, `missing marker: ${start}`);
  const to = source.indexOf(end, from + start.length);
  assert.ok(to > from, `missing marker: ${end}`);
  return source.slice(from, to);
}

test('no group-facing command prints a revive or protection deadline', () => {
  const combat = read('tgcloud/lib/rpg/combat.js');
  const inventory = read('tgcloud/lib/inventory.js');
  const profile = read('tgcloud/lib/profile.js');

  // `/kill` on an already dead account.
  const alreadyDead = sliceBetween(combat, 'function alreadyDeadLine', 'function killResultText');
  assert.doesNotMatch(alreadyDead, /dueText/);
  assert.doesNotMatch(alreadyDead, /revives/);

  // `/protect` (both the active and the fresh reply) and `/kill` on a shielded
  // target: no end time, only a pointer to /byakugan.
  const protect = sliceBetween(combat, 'export async function handleProtect', 'export async function handleByakugan');
  assert.doesNotMatch(protect, /dueText/);
  assert.match(protect, /\/byakugan/);

  const killTarget = sliceBetween(combat, 'export async function killTarget', 'function killResultText');
  assert.doesNotMatch(killTarget, /dueText|revives/);

  // `/inventory` status line.
  assert.doesNotMatch(inventory, /revives \$\{dueText/);
  assert.match(inventory, /Status: ☠️ dead/);

  // The profile card data (shared with the Mini App) ships no countdown either.
  assert.doesNotMatch(profile, /revives \$\{dueText/);
});

test('only /byakugan reveals a timer, and it answers the scanner alone', () => {
  const combat = read('tgcloud/lib/rpg/combat.js');
  const byakugan = sliceBetween(combat, 'export async function handleByakugan', 'export function isByakuganCallback');
  assert.match(byakugan, /ephemeral_message_parameters: \{ receiver_user_id: user\.id \}/);
  assert.match(byakugan, /Jiraiya protection ends at \$\{dueText/);
  // The delivery fallback must stay private: a group fallback would publish the
  // very countdown this command protects.
  const fallback = byakugan.slice(byakugan.indexOf('catch (e)'));
  assert.doesNotMatch(fallback, /replyHtml\(message, report\)/);
  assert.match(byakugan, /the cooldown was refunded/);
});

test('the protection reminder is one DM per window, 2–3h before expiry', () => {
  const source = read('tgcloud/lib/rpg/protect_reminder.js');
  assert.match(source, /PROTECTION_REMINDER_WINDOW_SEC = 3 \* 3600/);
  assert.match(source, /ʏᴏᴜʀ ᴊɪʀᴀɪʏᴀ ᴘʀᴏᴛᴇᴄᴛɪᴏɴ ᴡɪʟʟ ᴇxᴘɪʀᴇ ɪɴ/);
  assert.match(source, /ꜱᴛᴀʏ ᴀʟᴇʀᴛ!/);
  assert.match(source, /protect_reminder:\$\{id\}:\$\{until\}/);

  // Wired into the per-message sweep and the economy path.
  assert.match(read('tgcloud/handlers/message.js'), /sweepProtectionReminders\(\)/);
  assert.match(read('tgcloud/lib/economy_handler.js'), /sweepProtectionReminders\(\)/);
});

test('reminder sweep: window, countdown and idempotency against real SQLite', () => {
  const output = execFileSync(
    process.execPath,
    ['--experimental-loader', './test/helpers/sdk-loader.mjs', 'test/helpers/run_protect_reminder.mjs'],
    { cwd: new URL('..', import.meta.url), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  assert.match(output, /protect reminder: OK/);
});
