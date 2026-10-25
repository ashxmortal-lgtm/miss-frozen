import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// Round 16 — /mt command registration: the ephemeral flag must survive, the rest
// of the group menu must survive with it, and the in-memory cache must never
// suppress a repair.
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const run = (script) => execFileSync(
  process.execPath,
  ['--experimental-loader', './test/helpers/sdk-loader.mjs', script],
  { cwd: new URL('..', import.meta.url), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
);

const registrationBlock = () => {
  const mt = read('tgcloud/lib/mt.js');
  return mt.slice(mt.indexOf('function buildCommandList'), mt.indexOf('async function hasMtJutsu'));
};

test('/mt is registered with is_ephemeral and every other command is kept', () => {
  const block = registrationBlock();
  assert.match(block, /if \(name === MT_COMMAND\) command\.is_ephemeral = true;/, 'only /mt is ephemeral');
  assert.match(block, /if \(entry\.access !== 'user' \|\| entry\.hidden\) continue;/, 'hidden commands stay out');
  assert.match(block, /merged\.push\(ours \? \{ \.\.\.entry, \.\.\.ours \} : entry\);/, 'foreign commands are preserved verbatim');
  assert.match(block, /merged\.length >= MAX_COMMANDS/, 'the Telegram command limit is respected');

  const registry = read('tgcloud/lib/command_registry.js');
  for (const cmd of ['/help', '/balance', '/rob', '/protect', '/buy', '/byakugan']) {
    assert.ok(registry.includes(`cmd: '${cmd}'`), `${cmd} stays in the group menu`);
  }
});

test('the live menu is read before writing, and an unchanged menu is not rewritten', () => {
  const block = registrationBlock();
  assert.match(block, /const existing = await readGroupCommands\(\);/);
  assert.match(block, /if \(existing && registrationIsCurrent\(existing, desired\)\) \{/,
    'a correct menu short-circuits before any write');
  assert.match(block, /const commands = existing \? mergeCommands\(existing, desired\) : desired;/);
  assert.match(block, /return normalizeCommands\(await api\.getMyCommands\(\{ scope: SCOPE \}\)\);/);
});

test('a lost flag or a failed write is retried, never latched as success', () => {
  const block = registrationBlock();
  const mt = read('tgcloud/lib/mt.js');
  assert.match(mt, /const VERIFY_TTL_MS = 60_000;/, 'the verified menu is re-checked periodically');
  assert.match(mt, /const RETRY_TTL_MS = 60_000;/, 'failed writes back off instead of hammering');
  assert.match(block, /if \(!force\) \{\n\s*if \(state\.verifiedAt/, 'force bypasses the cache');
  const fallback = block.slice(block.indexOf('const withoutFlag'));
  assert.match(fallback, /state\.failedAt = Date\.now\(\);/, 'the stripped fallback stays unverified');
  assert.match(fallback, /return false;/, 'and reports failure so a later call retries');
  assert.doesNotMatch(block, /MT_CMD_REGISTERED/, 'the old one-way latch is gone');
});

test('a malformed live list is handled safely', () => {
  const block = registrationBlock();
  assert.match(block, /const list = Array\.isArray\(value\) \? value : Array\.isArray\(value\?\.commands\) \? value\.commands : null;/);
  assert.match(block, /if \(!list\) return null;/, 'missing/malformed → unknown, not "empty"');
  assert.match(block, /if \(!raw \|\| typeof raw !== 'object'\) continue;/, 'garbage entries are skipped');
});

test('/mt registration end to end (cold start, repair, preserve, retry)', () => {
  const output = run('test/helpers/run_mt_registration.mjs');
  assert.match(output, /mt registration: OK/);
});
