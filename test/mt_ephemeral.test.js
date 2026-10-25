import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// Round 17 — /mt must deliver the body as a private in-group message: never
// public, never a DM. Both Bot API ephemeral shapes are sent, the response is
// verified, and a build that ignores the parameters gets its public copy deleted.
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const run = (script) => execFileSync(
  process.execPath,
  ['--experimental-loader', './test/helpers/sdk-loader.mjs', script],
  { cwd: new URL('..', import.meta.url), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
);

test('both Bot API ephemeral shapes are sent, and only an ephemeral message is a trigger', () => {
  const mt = read('tgcloud/lib/mt.js');

  const trigger = mt.slice(mt.indexOf('function ephemeralTrigger'), mt.indexOf('async function botUserId'));
  assert.match(trigger, /message\?\.ephemeral_message_id/, 'the incoming ephemeral id is used');
  assert.match(trigger, /return ephemeralId > 0 \? \{ ephemeral_message_id: ephemeralId \} : null;/);
  assert.doesNotMatch(trigger, /message_id: message\.message_id/, 'a plain message_id is not a trigger');

  const payloads = mt.slice(mt.indexOf('function ephemeralPayload'), mt.indexOf('function classifyEphemeralResult'));
  assert.match(payloads, /payload\.receiver_user_id = userId; \/\/ Bot API 10\.2/);
  assert.match(payloads, /payload\.ephemeral_message_parameters = \{ receiver_user_id: userId \}; \/\/ Bot API 10\.3/);
  assert.match(payloads, /mode === 'both' \|\| mode === 'flat'/, 'the flat 10.2 field');
  assert.match(payloads, /mode === 'both' \|\| mode === 'nested'/, 'the nested 10.3 object');
  assert.match(mt, /const EPHEMERAL_MODES = \['both', 'nested', 'flat'\];/);
});

test('an ignored ephemeral parameter is detected and the public copy deleted', () => {
  const mt = read('tgcloud/lib/mt.js');
  const classify = mt.slice(mt.indexOf('function classifyEphemeralResult'), mt.indexOf('async function deleteLeakedMessage'));
  assert.match(classify, /sent\.ephemeral_message_id/, 'a real ephemeral message carries the id');
  assert.match(classify, /messageId > 0 \? 'public' : 'ephemeral'/, 'a normal message id means a public post');

  const send = mt.slice(mt.indexOf('async function sendEphemeral'), mt.indexOf('/**\n * Best-effort: hide'));
  assert.match(send, /classifyEphemeralResult\(sent\) !== 'public'/);
  assert.match(send, /await deleteLeakedMessage\(chatId, Number\(sent\.message_id\)\)/,
    'the leaked copy is removed before anything else');
  assert.match(send, /state\.ephemeralMode = mode;/, 'the working shape is cached');
  assert.match(send, /EPHEMERAL_RETRY_MS/, 'a build that ignores every shape is not probed again immediately');
});

test('the body is never posted publicly and never rerouted to a DM', () => {
  const mt = read('tgcloud/lib/mt.js');
  const handler = mt.slice(mt.indexOf('export async function handleMtCommand'));

  assert.ok(!/chat_id: recipient\.id/.test(handler), 'the body is never DM-ed to the recipient');
  assert.ok(!/route = 'dm'/.test(handler), 'there is no DM route');
  assert.match(handler, /const delivery = await sendEphemeral\(chat\.id, recipient\.id, body, trigger\);/);
  assert.match(handler, /if \(!delivery\.ok\) failure = delivery\.reason;/);
  assert.match(handler, /TRANSMISSION FAILED/);
  assert.match(handler, /Nothing was posted to the group\./);
  assert.ok(!/\[mt ack public\]/.test(handler), 'no public status fallback either');
});

test('/mt delivery end to end (10.3, 10.2, leaking build, refusals)', () => {
  assert.match(run('test/helpers/run_mt.mjs'), /mt delivery: OK/);
});
