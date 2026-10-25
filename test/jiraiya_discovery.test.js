import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// Round 12 — Jiraiya found on a Naruto patrol.
//
// Same moment as finding Tsunade: an image from the private storage channel
// (t.me/c/3889508991/581) with the discovery caption, "research" behind a
// Telegram spoiler, and the Check ❄️ ability button (frozenblooded/14).
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('Jiraiya discovery caption, spoiler and ability button', () => {
  const source = read('tgcloud/lib/rpg/jiraiya_discovery.js');
  assert.match(source, /JIRAIYA_MEDIA_MESSAGE_ID = 581/, 'the storage-channel photo');
  assert.match(source, /🐸 \$\{mentionHtml\}\\n\\n\\n/, 'mention block');
  assert.match(source, /🥀 you spotted master jiraiya near the hot springs!/);
  assert.match(source, /“<span class="tg-spoiler">research<\/span>”\.\.\.🤫/, 'research is spoilered');
  assert.match(source, /abilityCheckKeyboard\('Jiraiya'\)/, 'the ability button comes from the shared map');
  assert.match(source, /getMapPhotoFileId\(chatId, JIRAIYA_MEDIA_MESSAGE_ID\)/);
});

test('discovery fires exactly once when Naruto brings Jiraiya home', () => {
  const activities = read('tgcloud/lib/activities.js');
  assert.match(activities, /import \{ sendJiraiyaDiscovery \} from '\.\/rpg\/jiraiya_discovery\.js';/);
  const block = activities.slice(
    activities.indexOf("if (a.kind === 'patrol' && a.shinobi === 'Naruto')"),
    activities.indexOf('let pendingTotal = 0;'),
  );
  assert.match(block, /const g = await db\.run\(sql`INSERT OR IGNORE INTO inventory/);
  assert.match(block, /found = g\.rowsAffected > 0;/);
  assert.match(block, /if \(found\) \{/, 'only a real discovery announces');
  assert.match(block, /await sendJiraiyaDiscovery\(/, 'photo announcement');
  assert.match(block, /a\.chat_id/, 'the patrol group is the fallback');
});

test('Jiraiya announcement end to end (photo, spoiler, button, once)', () => {
  const output = execFileSync(
    process.execPath,
    ['--experimental-loader', './test/helpers/sdk-loader.mjs', 'test/helpers/run_jiraiya_discovery.mjs'],
    { cwd: new URL('..', import.meta.url), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  assert.match(output, /jiraiya discovery: OK/);
});
