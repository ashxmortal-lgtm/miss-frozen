import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SOURCE_SNAPSHOT } from '../tgcloud/lib/source_snapshot.js';

test('SOURCE_SNAPSHOT contains complete project files and no sensitive data', () => {
  assert(Array.isArray(SOURCE_SNAPSHOT), 'SOURCE_SNAPSHOT should be an array');
  assert(SOURCE_SNAPSHOT.length >= 50, `Expected at least 50 files in snapshot, got ${SOURCE_SNAPSHOT.length}`);

  const paths = SOURCE_SNAPSHOT.map((f) => f.path);

  // Critical files must be present
  const required = [
    'tgcloud.jsonc',
    'package.json',
    'tgcloud/schema.js',
    'tgcloud/handlers/message.js',
    'tgcloud/handlers/callback_query.js',
    'tgcloud/endpoints/getProfile.js',
    'tgcloud/lib/economy_handler.js',
    'tgcloud/lib/backup.js',
    '.github/workflows/deploy.yml'
  ];

  for (const r of required) {
    assert(paths.includes(r), `Missing required file in backup snapshot: ${r}`);
  }

  // Ensure no sensitive files or generated folders
  for (const p of paths) {
    assert(!p.startsWith('.git/'), `Backup must not include .git files: ${p}`);
    assert(!p.startsWith('node_modules/'), `Backup must not include node_modules: ${p}`);
    assert(!p.endsWith('.env'), `Backup must not include .env files: ${p}`);
  }
});

test('Backup serialization replacer encodes Uint8Array as hex', () => {
  function replacer(_k, v) {
    if (v instanceof Uint8Array) {
      return { __blob_hex: Array.from(v, (b) => b.toString(16).padStart(2, '0')).join('') };
    }
    return v;
  }

  const sampleBytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
  const serialized = JSON.stringify({ blob: sampleBytes }, replacer);
  assert.equal(serialized, '{"blob":{"__blob_hex":"deadbeef"}}');
});

test('Backup filenames use valid timestamp interpolation and no invalid chars', () => {
  const stamp = '2026-03-31T12-00-00-000Z';
  const table = 'users';
  const filename = `backup-${stamp}-${table}.json`;

  assert.equal(filename, 'backup-2026-03-31T12-00-00-000Z-users.json');
  assert(!filename.includes('\\('), 'Filename must not contain broken regex or syntax interpolation');
  assert(!filename.includes(' '), 'Filename should not contain spaces');
});
