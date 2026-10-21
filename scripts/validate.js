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

const jsFiles = getAllJsFiles(repoRoot);
console.log(`Checking syntax of ${jsFiles.length} JavaScript files...`);
for (const file of jsFiles) {
  if (file.endsWith('source_snapshot.js')) continue;
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
  if (file.endsWith('source_snapshot.js')) continue;
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

// 3. Snapshot verification
console.log('Validating full source backup snapshot...');
import('../tgcloud/lib/source_snapshot.js').then(({ SOURCE_SNAPSHOT }) => {
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

  console.log(`✓ Source snapshot verified (${SOURCE_SNAPSHOT.length} files included).`);
  console.log('--- Pre-Deployment Validation Passed ---');
}).catch((err) => {
  console.error('Failed to validate SOURCE_SNAPSHOT:', err);
  process.exit(1);
});
