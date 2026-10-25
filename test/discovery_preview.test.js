import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

const run = (helper) => execFileSync(
  process.execPath,
  ['--experimental-loader', './test/helpers/sdk-loader.mjs', helper],
  { cwd: new URL('..', import.meta.url), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
);

// Round 20 — owner-only previews of the two discovery announcements.
test('/testT and /testJ send the real discovery messages, owner only', () => {
  assert.match(run('test/helpers/run_discovery_preview.mjs'), /discovery preview: OK/);
});

test('both preview commands are registered as owner commands', () => {
  const registry = read('tgcloud/lib/command_registry.js');
  assert.match(registry, /\{ cmd: '\/testT',[^}]*access: 'owner' \}/);
  assert.match(registry, /\{ cmd: '\/testJ',[^}]*access: 'owner' \}/);
  // Owner commands never reach Telegram's command menu (users must not see them).
  const mt = read('tgcloud/lib/mt.js');
  assert.match(mt, /if \(entry\.access !== 'user' \|\| entry\.hidden\) continue;/, 'menu filters by user access');
});

test('Tsunade discovery carries the ability button, like Jiraiya', () => {
  const tsunade = read('tgcloud/lib/rpg/tsunade.js');
  assert.match(tsunade, /import \{ abilityCheckKeyboard \} from '\.\.\/ability\.js';/);
  assert.match(tsunade, /export function tsunadeDiscoveryRich\(user, fileId = null\)/);
  assert.match(tsunade, /abilityCheckKeyboard\('Tsunade'\)/, 'the frozenblooded/13 button');
  assert.match(tsunade, /<figure><img src="tg:\/\/photo\?id=\$\{TSUNADE_PHOTO_ID\}"\/><\/figure>/,
    'the photo is embedded in the rich message');
  assert.match(tsunade, /api\.sendRichMessage\(/, 'sent as a rich message, so the button is rich');
  // The rich send happens before the classic photo fallback.
  assert.ok(
    tsunade.indexOf('api.sendRichMessage') < tsunade.indexOf('await api.sendPhoto('),
    'rich first, classic photo as fallback',
  );
  // Compact layout: the caption must not be split into an empty paragraph per line.
  assert.doesNotMatch(tsunade, /<p><br\/><\/p>/);
});

test('the previews reuse the production senders and grant nothing', () => {
  const owner = read('tgcloud/lib/owner_cmds.js');
  assert.match(owner, /import \{ sendTsunadeDiscovery \} from '\.\/rpg\/tsunade\.js';/);
  assert.match(owner, /import \{ sendJiraiyaDiscovery \} from '\.\/rpg\/jiraiya_discovery\.js';/);
  assert.match(owner, /if \(from\.id !== OWNER_ID\)[\s\S]*?deniedBlocks/, 'owner check before sending');
  assert.match(owner, /cmd === '\/testt' \|\| cmd === '\/test_t'/);
  assert.match(owner, /cmd === '\/testj' \|\| cmd === '\/test_j'/);

  // The handler must not write to the database — it is a preview only.
  const fn = owner.slice(owner.indexOf('async function handleDiscoveryPreview'), owner.indexOf('export async function handleOwnerCommand'));
  assert.doesNotMatch(fn, /db\.(run|insert|update|delete)/, 'no writes');
  assert.doesNotMatch(fn, /addInventory|purchase|adjustBalance/, 'nothing is granted');

  // Tsunade's announcement is exported instead of duplicated.
  const tsunade = read('tgcloud/lib/rpg/tsunade.js');
  assert.match(tsunade, /export async function sendTsunadeDiscovery\(chatId, user\)/);
  assert.match(tsunade, /export const TSUNADE_DISCOVERY_TEXT = '🐌 Lady Tsunade was found drinking sake and gambling 🤣';/);
  assert.match(tsunade, /await sendTsunadeDiscovery\(id, user \|\|/, 'the real discovery uses the same function');
});
