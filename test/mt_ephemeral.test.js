import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// Round 16 — /mt delivery: ephemeral sends need an eligible trigger (or bot-admin
// rights), the acknowledgement must match what Telegram actually accepted, and
// the invoking command is only deleted as a fallback.
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const run = (script) => execFileSync(
  process.execPath,
  ['--experimental-loader', './test/helpers/sdk-loader.mjs', script],
  { cwd: new URL('..', import.meta.url), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
);

test('only an ephemeral message is an eligible ephemeral trigger', () => {
  const mt = read('tgcloud/lib/mt.js');
  const trigger = mt.slice(mt.indexOf('function ephemeralTrigger'), mt.indexOf('async function botUserId'));
  assert.match(trigger, /message\?\.ephemeral_message_id/, 'the incoming ephemeral id is used');
  assert.match(trigger, /return ephemeralId > 0 \? \{ ephemeral_message_id: ephemeralId \} : null;/);
  assert.doesNotMatch(trigger, /message_id: message\.message_id/, 'a plain message_id is not a trigger');

  const send = mt.slice(mt.indexOf('async function sendEphemeral'), mt.indexOf('/**\n * Best-effort: hide'));
  assert.match(send, /ephemeral_message_parameters: \{ receiver_user_id: Number\(receiverUserId\) \}/,
    'receiver_user_id is a JSON number in the documented wrapper shape');
  assert.match(send, /reply_parameters: trigger/);
  assert.match(send, /return api\.sendMessage\(base\);/, 'retry without the reply target instead of dropping it');
});

test('delivery is private, acknowledged honestly, and escalated only when needed', () => {
  const mt = read('tgcloud/lib/mt.js');

  // Bot-admin rights are the only route for a receiver who triggered nothing.
  assert.match(mt, /const canEphemeral = Boolean\(trigger\) \|\| \(await botAdminStatus\(chat\.id\)\) !== false;/);
  assert.match(mt, /status === 'administrator' \|\| status === 'creator'/);
  assert.match(mt, /return null;/, 'an unknown status still tries ephemeral instead of skipping it');

  // Success is only reported for a resolved route.
  const body = mt.slice(mt.indexOf('let route = null;'));
  assert.match(body, /route = 'ephemeral';/);
  assert.match(body, /route = 'dm';/);
  assert.match(body, /if \(!route\) \{[\s\S]*TRANSMISSION FAILED/, 'no route → failure card');
  assert.match(body, /route === 'dm'/, 'the ack names the route that actually worked');

  // Diagnostics never include the private text.
  assert.ok(!/console\.error\([^)]*payload/.test(mt), 'the transmitted text is never logged');
});

test('the invoking command is deleted only as a fallback', () => {
  const mt = read('tgcloud/lib/mt.js');
  const hide = mt.slice(mt.indexOf('async function hideCommandMessage'), mt.indexOf('export async function handleMtCommand'));
  assert.match(hide, /if \(Number\(message\?\.ephemeral_message_id \|\| 0\) > 0\) return false;/,
    'an already-ephemeral command is not deleted');
  assert.match(hide, /await api\.deleteMessage\(\{ chat_id: chatId, message_id: messageId \}\);/);
  assert.match(hide, /\[mt hide\] deleteMessage failed:/, 'deletion failures are logged with context');
  assert.match(hide, /chat=\$\{chatId\}`/, 'chat id in the diagnostic');
  assert.doesNotMatch(hide, /reply_to_message/, 'the recipient message is never touched');
  assert.ok(!/message_id: message\.reply_to_message/.test(hide));

  const handler = mt.slice(mt.indexOf('export async function handleMtCommand'));
  const deleteAt = handler.indexOf('await hideCommandMessage(message)');
  const jutsuAt = handler.indexOf('await hasMtJutsu');
  assert.ok(deleteAt > -1 && deleteAt < jutsuAt, 'deletion runs before the database checks');
});

test('/mt delivery end to end (trigger, admin route, DM fallback, failure ack)', () => {
  assert.match(run('test/helpers/run_mt.mjs'), /mt delivery: OK/);
});
