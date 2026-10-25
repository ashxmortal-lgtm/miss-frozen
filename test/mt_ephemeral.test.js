import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// Round 15 — /mt must actually reach the sender and the receiver as ephemeral
// messages, and the group command menu must survive the ephemeral flag.
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('every ephemeral /mt send is tied to the triggering command', () => {
  const mt = read('tgcloud/lib/mt.js');

  assert.match(mt, /function ephemeralTrigger\(message\)/, 'the trigger is derived from the incoming message');
  assert.match(mt, /if \(message\?\.ephemeral_message_id\) \{/, 'an ephemeral command is answered by its ephemeral id');
  assert.match(mt, /return \{ ephemeral_message_id: message\.ephemeral_message_id \};/);

  const send = mt.slice(mt.indexOf('async function sendEphemeral'), mt.indexOf('/** Best-effort: hide the /mt command'));
  assert.match(send, /ephemeral_message_parameters: \{ receiver_user_id: receiverUserId \}/);
  assert.match(send, /reply_parameters: trigger/, 'the reply target keeps Telegram from refusing the send');
  assert.match(send, /return api\.sendMessage\(base\);/, 'retry without a reply target instead of dropping the message');

  // Both the receiver body and the sender confirmation use the shared helper.
  const body = mt.slice(mt.indexOf('export async function handleMtCommand'));
  assert.match(body, /const trigger = ephemeralTrigger\(message\);/);
  assert.match(body, /await sendEphemeral\(chat\.id, recipient\.id, body, trigger\);/, 'the receiver body is ephemeral');
  assert.match(body, /await sendEphemeral\(chat\.id, from\.id, html, trigger\);/, 'the sender answer is ephemeral');
});

test('a refused ephemeral send falls back to the bot DM, never silence', () => {
  const mt = read('tgcloud/lib/mt.js');
  assert.match(mt, /console\.error\('mt sender DM failed:'/, 'the sender DM fallback is logged');
  const body = mt.slice(mt.indexOf('let viaDm = false;'));
  assert.match(body, /await api\.sendMessage\(\{ chat_id: recipient\.id, text: body, parse_mode: 'HTML' \}\);/,
    'the receiver gets the text in DM when ephemeral delivery fails');
  assert.match(body, /viaDm = true;/);
  assert.match(body, /'Your message was delivered to their bot DM/);
});

test('the group command menu keeps every command when /mt is registered', () => {
  const mt = read('tgcloud/lib/mt.js');
  assert.match(mt, /import \{ COMMANDS \} from '\.\/command_registry\.js';/);
  const fn = mt.slice(mt.indexOf('export async function ensureMtEphemeralCommand'), mt.indexOf('/**\n * The jutsu check'));
  assert.match(fn, /const commands = COMMANDS/, 'the whole user menu is sent with /mt');
  assert.match(fn, /c\.access === 'user' && !c\.hidden/);
  assert.match(fn, /\.\.\.\(c\.cmd === '\/mt' \? \{ is_ephemeral: true \} : \{\}\),/, 'only /mt is ephemeral');
  assert.match(fn, /commands\.map\(\(\{ is_ephemeral, \.\.\.rest \}\) => rest\)/, 'older API builds still get the full menu');

  const registry = read('tgcloud/lib/command_registry.js');
  for (const cmd of ['/help', '/rob', '/protect', '/buy']) {
    assert.ok(registry.includes(`cmd: '${cmd}'`), `${cmd} stays in the group menu`);
  }
});

test('/mt flow end to end (ephemeral payloads, DM fallback, jutsu gate)', () => {
  const output = execFileSync(
    process.execPath,
    ['--experimental-loader', './test/helpers/sdk-loader.mjs', 'test/helpers/run_mt.mjs'],
    { cwd: new URL('..', import.meta.url), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  assert.match(output, /mt ephemeral: OK/);
});
