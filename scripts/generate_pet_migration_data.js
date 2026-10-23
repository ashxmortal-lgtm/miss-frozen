/**
 * Generate the deployable mirror of the legacy pet snapshot.
 *
 * The canonical artifact is the JSON exported from the old economy.db bot:
 *   tgcloud/lib/pet/data/missfrozen_pet_migration.json
 * TGCloud only bundles `.js` modules, so the runtime reads the generated
 * `tgcloud/lib/pet/migration_data.js` instead of using `fs` (serverless has no
 * repository access). `test/pet_migration.test.js` fails if the two drift.
 *
 * Usage: npm run generate:pet-migration
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

export const JSON_PATH = 'tgcloud/lib/pet/data/missfrozen_pet_migration.json';
export const MODULE_PATH = 'tgcloud/lib/pet/migration_data.js';

export function readSnapshot(root = repoRoot) {
  const file = path.join(root, JSON_PATH);
  const raw = fs.readFileSync(file, 'utf8');
  const data = JSON.parse(raw);
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`${JSON_PATH} must contain a JSON object`);
  }
  if (!Array.isArray(data.users)) {
    throw new Error(`${JSON_PATH} is missing the users array`);
  }
  if (data.record_count != null && Number(data.record_count) !== data.users.length) {
    throw new Error(`${JSON_PATH} record_count (${data.record_count}) != users.length (${data.users.length})`);
  }
  for (const user of data.users) {
    if (!Number.isFinite(Number(user?.user_id))) {
      throw new Error(`${JSON_PATH} has a user without a numeric user_id`);
    }
    if (!Array.isArray(user.owned_pets)) {
      throw new Error(`${JSON_PATH} user ${user.user_id} is missing owned_pets`);
    }
  }
  return data;
}

const HEADER = `/**
 * Legacy pet snapshot (economy.db) — AUTO-GENERATED, do not edit by hand.
 * Source: ${JSON_PATH}
 * Regenerate with: npm run generate:pet-migration
 * Restored once per user on their first interaction by lib/pet/migration.js.
 */
`;

export function renderModule(data) {
  return `${HEADER}export const PET_MIGRATION_SNAPSHOT = ${JSON.stringify(data, null, 2)};\n`;
}

function main() {
  const data = readSnapshot();
  const outPath = path.join(repoRoot, MODULE_PATH);
  fs.writeFileSync(outPath, renderModule(data), 'utf8');
  const pets = data.users.reduce((n, u) => n + u.owned_pets.length, 0);
  console.log(`Generated ${MODULE_PATH} from ${JSON_PATH} (${data.users.length} users, ${pets} pets)`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
