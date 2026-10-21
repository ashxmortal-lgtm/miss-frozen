import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { patchSnapshotSource } from '../scripts/patch-tgcloud-cli.js';

const cliSnapshotPath = path.resolve('node_modules/@tgcloud/cli/src/core/snapshot.js');

// The deployment runner installs the CLI before running tests, and package
// postinstall applies this compatibility patch before this module is imported.
const { replaceSnapshot } = await import(pathToFileURL(cliSnapshotPath).href);

test('TGCloud false canonical entries delete cached modules instead of writing boolean file content', () => {
  const originalCwd = process.cwd();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgcloud-snapshot-patch-'));
  try {
    process.chdir(tempDir);
    const removedFile = path.join('.tgcloud', 'remote', 'lib', 'removed.js');
    fs.mkdirSync(path.dirname(removedFile), { recursive: true });
    fs.writeFileSync(removedFile, 'old source');

    replaceSnapshot({
      'lib/kept': 'export const kept = true;\n',
      'lib/removed': false,
    });

    assert.equal(
      fs.readFileSync(path.join('.tgcloud', 'remote', 'lib', 'kept.js'), 'utf8'),
      'export const kept = true;\n'
    );
    assert.equal(fs.existsSync(removedFile), false);
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('TGCloud snapshot compatibility patch is applied and rejects unexpected value types', () => {
  const source = fs.readFileSync(cliSnapshotPath, 'utf8');
  assert.equal(patchSnapshotSource(source), source, 'postinstall should have applied the patch');

  const originalCwd = process.cwd();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgcloud-snapshot-invalid-'));
  try {
    process.chdir(tempDir);
    assert.throws(
      () => replaceSnapshot({ 'lib/invalid': 42 }),
      /Invalid TGCloud snapshot content for lib\/invalid: expected a string or false deletion marker/
    );
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
