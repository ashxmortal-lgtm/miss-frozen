import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => readFileSync(path.join(repoRoot, rel), 'utf8');

// Built from parts so this file never matches its own guard.
const REMOVED_TREE = ['for', 'my', 'sheesh'].join('-');

test('the removed study tree and stray file stay gone', () => {
  for (const gone of [REMOVED_TREE, 'Hh']) {
    assert.equal(existsSync(path.join(repoRoot, gone)), false, `${gone} must stay deleted`);
  }

  const offenders = [];
  const walk = (dir) => {
    for (const item of readdirSync(dir)) {
      if (['.git', 'node_modules', '.tgcloud'].includes(item)) continue;
      const full = path.join(dir, item);
      if (statSync(full).isDirectory()) { walk(full); continue; }
      if (!/\.(js|mjs|json|jsonc|md|html|css|ya?ml)$/.test(item)) continue;
      // Generated snapshot modules mirror their sources; the sources are checked.
      if (/^source_snapshot(_\d+)?\.js$/.test(item)) continue;
      const rel = path.relative(repoRoot, full);
      if (rel === path.join('scripts', 'validate.js')) continue; // names the path in its guard
      if (readFileSync(full, 'utf8').includes(REMOVED_TREE)) offenders.push(rel);
    }
  };
  walk(repoRoot);
  assert.deepEqual(offenders, [], 'nothing may reference the removed tree');
});

test('validate.js keeps the audit guards', () => {
  const validate = read('scripts/validate.js');
  assert.match(validate, /Removed path came back/, 'removed-tree guard');
  assert.match(validate, /Deploy target is \$\{EXPECTED_APP_ID\}/, 'deploy-target guard');
  assert.match(validate, /Missing asset/, 'Mini App asset guard');
  assert.match(validate, /Snapshot is stale/, 'snapshot freshness guard');
  assert.match(validate, /generateSnapshotArray/, 'freshness uses the real generator');
});

test('only the MissFrozen app can be deployed', () => {
  const workflow = read('.github/workflows/deploy.yml');
  const config = read('tgcloud/lib/config.js');
  assert.match(config, /app8888370613/, 'the bot config names the app');
  assert.match(workflow, /app8888370613/, 'the workflow pins the app id');
  const others = (workflow.match(/app\d{6,}/g) || []).filter((id) => id !== 'app8888370613');
  assert.deepEqual(others, [], 'no second app id in the deploy workflow');
  assert.match(workflow, /if: github\.event_name != 'pull_request'/, 'deploy never runs on PRs');
});

test('the Mini App contract matches the endpoint actions', () => {
  const contract = read('web/js/contract.js');
  const endpoint = read('tgcloud/endpoints/miniapp.js');
  const declared = JSON.parse(
    contract.match(/const ACTIONS = (\[[^\]]+\])/)[1].replace(/'/g, '"'),
  ).sort();
  const implemented = JSON.parse(
    endpoint.match(/new Set\((\[[^\]]+\])\)/)[1].replace(/'/g, '"'),
  ).sort();
  assert.deepEqual(declared, implemented, 'contract.js and miniapp.js agree');
  assert.deepEqual(declared, ['bootstrap', 'claim', 'purchase']);
});

test('every Mini App page asset exists', () => {
  for (const page of ['web/index.html', 'web/profile.html']) {
    const html = read(page);
    for (const [, target] of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
      if (/^(?:https?:|\/\/|#|tg:|data:|mailto:)/.test(target)) continue;
      const rel = target.split('?')[0].replace(/^\/+/, '');
      assert.equal(existsSync(path.join(repoRoot, 'web', rel)), true, `${page} → ${target}`);
    }
  }
});
