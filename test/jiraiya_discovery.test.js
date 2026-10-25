import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// Round 12 → round 19 — Jiraiya found on a Naruto patrol.
//
// Same moment as finding Tsunade: the storage-channel photo (t.me/c/3889508991/581)
// plus the discovery caption, delivered with the /map rich-message method — the
// photo embedded as a <figure> (rich_message.media) and a real rich ❄️ button
// (frozenblooded/14) instead of a classic inline keyboard.
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('Jiraiya discovery keeps the exact caption spacing', () => {
  const source = read('tgcloud/lib/rpg/jiraiya_discovery.js');
  assert.match(source, /JIRAIYA_MEDIA_MESSAGE_ID = 581/, 'the storage-channel photo');
  assert.match(source, /🐸 \$\{mentionHtml\}\\n\\n\\n\\n/, 'three blank lines after the mention');
  assert.match(source, /near the hot springs!\\n\\n/, 'one blank line before the last line');
  assert.match(source, /' he was busy with his “<span class="tg-spoiler">research<\/span>”\.\.\.🤫'/, 'tail line');
});

test('blank lines use <br/>, never their own paragraph', () => {
  const source = read('tgcloud/lib/rpg/jiraiya_discovery.js');
  const fn = source.slice(
    source.indexOf('export function captionParagraphs'),
    source.indexOf('export function jiraiyaDiscoveryRich'),
  );
  assert.match(fn, /lines\.join\('<br\/>'\)/, 'one paragraph, <br/> breaks');
  assert.doesNotMatch(fn, /<p><br\/><\/p>/, 'no empty paragraph per blank line');
  assert.doesNotMatch(fn, /map\(\(line\) =>[\s\S]*?<p>\$\{text\}<\/p>/, 'one <p> only');
});

test('the Jiraiya button is a rich tg-button inside the rich photo message', () => {
  const source = read('tgcloud/lib/rpg/jiraiya_discovery.js');
  assert.match(source, /import \{ richHtml \} from '\.\.\/map\/rich\.js';/, 'reuses the /map rich helpers');
  assert.match(source, /abilityCheckKeyboard\('Jiraiya'\)/, 'the ability post keyboard');
  assert.match(source, /<figure><img src="tg:\/\/photo\?id=\$\{PHOTO_ID\}"\/><\/figure>/,
    'the photo is embedded in the rich message, exactly like /map');
  assert.match(source, /media: \[\{ id: PHOTO_ID, media: \{ type: 'photo', media: fileId \} \}\]/);
  assert.match(source, /api\.sendRichMessage\(/, 'sent as a rich message');
  assert.match(source, /getMapPhotoFileId\(chatId, JIRAIYA_MEDIA_MESSAGE_ID\)/);
  // Classic inline buttons remain only as a last-resort fallback.
  const richCall = source.indexOf('api.sendRichMessage');
  const photoFallback = source.indexOf('api.sendPhoto(');
  assert.ok(richCall > 0 && photoFallback > richCall, 'the rich send is tried before the classic photo');
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

test('Jiraiya announcement end to end (rich photo, exact spacing, rich button, once)', () => {
  const output = execFileSync(
    process.execPath,
    ['--experimental-loader', './test/helpers/sdk-loader.mjs', 'test/helpers/run_jiraiya_discovery.mjs'],
    { cwd: new URL('..', import.meta.url), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  assert.match(output, /jiraiya discovery: OK/);
});
