import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

console.log('--- Running Pre-Deployment Validation ---');

// 1. Syntax check on all .js files
function getAllJsFiles(dir) {
  let list = [];
  for (const item of fs.readdirSync(dir)) {
    if (item === '.git' || item === 'node_modules' || item === '.tgcloud') continue;
    const p = path.join(dir, item);
    const stat = fs.statSync(p);
    if (stat.isDirectory()) list.push(...getAllJsFiles(p));
    else if (item.endsWith('.js')) list.push(p);
  }
  return list;
}

// All text files (skipping VCS/deps/build output) for repo-wide guards.
function getAllFiles(dir) {
  let list = [];
  for (const item of fs.readdirSync(dir)) {
    if (item === '.git' || item === 'node_modules' || item === '.tgcloud') continue;
    const p = path.join(dir, item);
    const stat = fs.statSync(p);
    if (stat.isDirectory()) list.push(...getAllFiles(p));
    else list.push(p);
  }
  return list;
}

const jsFiles = getAllJsFiles(repoRoot);
const isSnapshotModule = (file) => /source_snapshot(_\d+)?\.js$/.test(file);
console.log(`Checking syntax of ${jsFiles.length} JavaScript files...`);
for (const file of jsFiles) {
  // Generated snapshot modules embed source code as strings; skip them.
  if (isSnapshotModule(file)) continue;
  try {
    execFileSync('node', ['--check', file], { stdio: 'pipe' });
  } catch (err) {
    console.error(`Syntax error in ${file}:\n`, err.stderr?.toString());
    process.exit(1);
  }
}
console.log('✓ All JavaScript files passed syntax check.');

// 2. Relative import verification
console.log('Verifying relative module imports...');
let importFailures = 0;
const importRegex = /(?:import|export)\s+(?:(?:(?:\w+|\{[^}]*\}|\*\s+as\s+\w+)\s+from\s+)?['"](\.[^'"]+)['"])/g;

for (const file of jsFiles) {
  if (isSnapshotModule(file)) continue;
  const content = fs.readFileSync(file, 'utf8');
  let match;
  while ((match = importRegex.exec(content)) !== null) {
    const relImport = match[1];
    const resolved = path.resolve(path.dirname(file), relImport);
    if (!fs.existsSync(resolved) && !fs.existsSync(`${resolved}.js`)) {
      console.error(`Broken relative import in ${path.relative(repoRoot, file)}: "${relImport}"`);
      importFailures++;
    }
  }
}

if (importFailures > 0) {
  console.error(`Found ${importFailures} broken import(s).`);
  process.exit(1);
}
console.log('✓ All relative imports resolved successfully.');

// 3. Repo hygiene — the removed study tree must never come back.
// Round 18 deleted `for-my-sheesh/` (55 files) and the stray `Hh` file; this
// guard fails the build if either returns or is referenced again.
console.log('Checking the removed study tree stays removed...');
for (const gone of ['for-my-sheesh', 'Hh']) {
  if (fs.existsSync(path.join(repoRoot, gone))) {
    console.error(`Removed path came back: ${gone}`);
    process.exit(1);
  }
}
const hygieneExtensions = new Set(['.js', '.mjs', '.json', '.jsonc', '.md', '.html', '.css', '.yml', '.yaml']);
const HYGIENE_SELF = path.join(repoRoot, 'scripts', 'validate.js');
for (const file of getAllFiles(repoRoot)) {
  if (file === HYGIENE_SELF || isSnapshotModule(file)) continue;
  if (!hygieneExtensions.has(path.extname(file))) continue;
  const content = fs.readFileSync(file, 'utf8');
  if (/\bfor-my-sheesh\b/.test(content)) {
    console.error(`Reference to the removed study tree in ${path.relative(repoRoot, file)}`);
    process.exit(1);
  }
}
console.log('✓ No trace of the removed study tree.');

// 4. Deploy target — only the MissFrozen app may be deployed.
console.log('Checking the deploy target...');
const EXPECTED_APP_ID = 'app8888370613';
const configSource = fs.readFileSync(path.join(repoRoot, 'tgcloud', 'lib', 'config.js'), 'utf8');
if (!configSource.includes(EXPECTED_APP_ID)) {
  console.error(`tgcloud/lib/config.js no longer names ${EXPECTED_APP_ID}.`);
  process.exit(1);
}
const workflowSource = fs.readFileSync(
  path.join(repoRoot, '.github', 'workflows', 'deploy.yml'), 'utf8',
);
if (!workflowSource.includes(EXPECTED_APP_ID)) {
  console.error(`The deploy workflow no longer guards ${EXPECTED_APP_ID}.`);
  process.exit(1);
}
const otherAppIds = new Set(
  (workflowSource.match(/app\d{6,}/g) || []).filter((id) => id !== EXPECTED_APP_ID),
);
if (otherAppIds.size) {
  console.error(`The deploy workflow mentions another app: ${[...otherAppIds].join(', ')}`);
  process.exit(1);
}
console.log(`✓ Deploy target is ${EXPECTED_APP_ID}.`);

// 5. Mini App assets — every local asset a page loads must exist.
console.log('Checking the Mini App assets...');
let missingAssets = 0;
for (const page of ['web/index.html', 'web/profile.html']) {
  const full = path.join(repoRoot, page);
  const html = fs.readFileSync(full, 'utf8');
  for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    const target = match[1];
    if (/^(?:https?:|\/\/|#|tg:|data:|mailto:)/.test(target)) continue;
    const rel = target.split('?')[0].replace(/^\/+/, '');
    if (!fs.existsSync(path.join(repoRoot, 'web', rel))) {
      console.error(`Missing asset ${target} referenced by ${page}`);
      missingAssets++;
    }
  }
}
if (missingAssets > 0) {
  console.error(`Found ${missingAssets} missing Mini App asset(s).`);
  process.exit(1);
}
console.log('✓ All Mini App assets exist.');

// 6. Snapshot verification
console.log('Validating full source backup snapshot...');
import('../tgcloud/lib/source_snapshot.js').then(async ({ SOURCE_SNAPSHOT }) => {
  if (!Array.isArray(SOURCE_SNAPSHOT) || SOURCE_SNAPSHOT.length === 0) {
    console.error('SOURCE_SNAPSHOT is empty or missing.');
    process.exit(1);
  }

  const snapshotPaths = new Set(SOURCE_SNAPSHOT.map((s) => s.path));
  const essentialPaths = [
    'tgcloud.jsonc',
    'package.json',
    'tgcloud/schema.js',
    'tgcloud/handlers/message.js',
    'tgcloud/handlers/callback_query.js',
    'tgcloud/endpoints/getProfile.js',
    '.github/workflows/deploy.yml'
  ];

  for (const ep of essentialPaths) {
    if (!snapshotPaths.has(ep)) {
      console.error(`Essential file missing from SOURCE_SNAPSHOT: ${ep}`);
      process.exit(1);
    }
  }

  // Ensure no secrets or node_modules in snapshot
  for (const item of SOURCE_SNAPSHOT) {
    if (item.path.startsWith('node_modules/') || item.path.startsWith('.git/')) {
      console.error(`Generated or git path found in SOURCE_SNAPSHOT: ${item.path}`);
      process.exit(1);
    }
  }

  // Freshness: the committed snapshot must match the working tree exactly.
  const { generateSnapshotArray } = await import('./generate_snapshot.js');
  const current = generateSnapshotArray(repoRoot);
  const byPath = new Map(SOURCE_SNAPSHOT.map((entry) => [entry.path, entry.content]));
  const stale = [];
  for (const entry of current) {
    if (byPath.get(entry.path) !== entry.content) stale.push(entry.path);
    byPath.delete(entry.path);
  }
  const extra = [...byPath.keys()];
  if (stale.length || extra.length) {
    if (stale.length) console.error(`Snapshot is stale (missing or outdated): ${stale.join(', ')}`);
    if (extra.length) console.error(`Snapshot still contains removed files: ${extra.join(', ')}`);
    console.error('Run `npm run generate:snapshot` and commit the result.');
    process.exit(1);
  }

  console.log(`✓ Source snapshot verified (${SOURCE_SNAPSHOT.length} files included, up to date).`);
  console.log('--- Pre-Deployment Validation Passed ---');
}).catch((err) => {
  console.error('Failed to validate SOURCE_SNAPSHOT:', err);
  process.exit(1);
});
