import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const cliPackagePath = path.join(repoRoot, 'node_modules', '@tgcloud', 'cli', 'package.json');
const snapshotPath = path.join(repoRoot, 'node_modules', '@tgcloud', 'cli', 'src', 'core', 'snapshot.js');
const expectedCliVersion = '0.2.0';

const original = `      const p = moduleToPath(moduleName);
      writeSnapshotFile(p, content);
      newPaths.add(p);`;

const replacement = `      const p = moduleToPath(moduleName);
      // TGCloud's deploy response uses false for modules absent from the
      // canonical snapshot. Treat that marker as a deletion, not file content.
      if (content === false) continue;
      if (typeof content !== 'string') {
        throw new TypeError(
          \`Invalid TGCloud snapshot content for \${moduleName}: expected a string or false deletion marker.\`
        );
      }
      writeSnapshotFile(p, content);
      newPaths.add(p);`;

export function patchSnapshotSource(source) {
  if (source.includes(replacement)) return source;
  const occurrences = source.split(original).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `Cannot safely patch TGCloud CLI snapshot writer: expected one matching block, found ${occurrences}.`
    );
  }
  return source.replace(original, replacement);
}

function main() {
  if (!fs.existsSync(cliPackagePath) || !fs.existsSync(snapshotPath)) {
    throw new Error('TGCloud CLI is not installed; cannot apply snapshot compatibility patch.');
  }
  const { version } = JSON.parse(fs.readFileSync(cliPackagePath, 'utf8'));
  if (version !== expectedCliVersion) {
    throw new Error(
      `TGCloud snapshot compatibility patch is for @tgcloud/cli ${expectedCliVersion}; found ${version}.`
    );
  }

  const source = fs.readFileSync(snapshotPath, 'utf8');
  const patched = patchSnapshotSource(source);
  if (patched !== source) fs.writeFileSync(snapshotPath, patched, 'utf8');
  console.log(`Applied @tgcloud/cli ${version} canonical snapshot compatibility patch.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
