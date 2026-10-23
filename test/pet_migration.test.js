import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const root = new URL('..', import.meta.url);
const read = (rel) => fs.readFileSync(new URL(rel, root), 'utf8');

// Drives the real migration module against in-memory SQLite: owners with one and
// several pets, users absent from the snapshot, repeated interactions, live data,
// failed runs, in-flight claims, unknown pet ids and level flooring.
test('pet migration integration: restore once, never duplicate, never overwrite', () => {
  const output = execFileSync(
    process.execPath,
    ['--experimental-loader', './test/helpers/sdk-loader.mjs', 'test/helpers/run_pet_migration.mjs'],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  assert.match(output, /pet migration integration: OK/);
});

test('the migration JSON is bundled in the repo and mirrored for the deploy', async () => {
  const jsonPath = 'tgcloud/lib/pet/data/missfrozen_pet_migration.json';
  const raw = read(jsonPath);
  const data = JSON.parse(raw);
  assert.equal(data.format, 'missfrozen_pet_migration_v1');
  assert.ok(Array.isArray(data.users) && data.users.length > 0);
  assert.equal(data.record_count, data.users.length);
  assert.equal(data.pet_record_count, data.users.reduce((n, u) => n + u.owned_pets.length, 0));

  // TGCloud only bundles JS modules, so the runtime reads the generated mirror.
  const { PET_MIGRATION_SNAPSHOT } = await import('../tgcloud/lib/pet/migration_data.js');
  assert.deepEqual(PET_MIGRATION_SNAPSHOT, data, 'migration_data.js is stale — run npm run generate:pet-migration');

  const generator = read('scripts/generate_pet_migration_data.js');
  assert.match(generator, /readFileSync\(/);
  assert.match(read('package.json'), /"generate:pet-migration": "node scripts\/generate_pet_migration_data\.js"/);
});

test('restoration runs on first interaction from both routers', () => {
  for (const file of ['tgcloud/handlers/message.js', 'tgcloud/handlers/callback_query.js']) {
    const src = read(file);
    assert.match(src, /import \{ restorePetsOnFirstInteraction \} from '\.\.\/lib\/pet\/migration\.js';/, file);
    assert.match(src, /await restorePetsOnFirstInteraction\(/, file);
    assert.match(src, /is_bot/, `${file} must skip bots`);
  }
  const messageHandler = read('tgcloud/handlers/message.js');
  const hook = messageHandler.indexOf('await restorePetsOnFirstInteraction(');
  assert.ok(hook < messageHandler.indexOf('handleEconomyCommand(message, ctx)'),
    'pets are restored before command handling');

  // The restore notice needs the sender + the origin chat for the DM fallback.
  for (const file of ['tgcloud/handlers/message.js', 'tgcloud/handlers/callback_query.js']) {
    const src = read(file);
    assert.match(src, /notify: \{ user: .*?, chatId: /, `${file} passes the notice context`);
  }
});

test('a restored owner gets the exact one-time notice', async () => {
  const { PET_RESTORED_BODY, petRestoredText } = await import('../tgcloud/lib/pet/text.js');
  assert.equal(PET_RESTORED_BODY.split('\n')[0], '🐾 ʏᴏᴜʀ ᴘᴇᴛꜱ ᴀʀᴇ ʙᴀᴄᴋ!');
  assert.equal(PET_RESTORED_BODY.split('\n').at(-1), '✨ ᴄʜᴇᴄᴋ ᴏᴜᴛ: /pet');
  assert.ok(PET_RESTORED_BODY.includes('\n\n\n'), 'blank lines between the two blocks');
  assert.ok(petRestoredText('<a href="tg://user?id=1">U</a>')
    .startsWith('<a href="tg://user?id=1">U</a>\n\n🐾'), 'mention comes first');

  const src = read('tgcloud/lib/pet/migration.js');
  assert.match(src, /options\.notify/, 'notice sent only when the router asks for it');
  assert.match(src, /await api\.sendMessage\(\{ chat_id: target, text, parse_mode: 'HTML' \}\)/);
  // Sent after the marker is committed, so a retry can never repeat it.
  const markAt = src.indexOf("SET status = 'processed'");
  const notifyAt = src.indexOf('await sendPetRestoredNotice(');
  assert.ok(markAt > 0 && notifyAt > markAt, 'notify happens after marking processed');
});

test('migration module is idempotent, offline and free of side effects', () => {
  const src = read('tgcloud/lib/pet/migration.js');
  // No filesystem / network / Python dependency at runtime.
  assert.doesNotMatch(src, /from 'node:fs'|require\('fs'\)|readFileSync|fetch\(/);
  assert.match(src, /from '\.\/migration_data\.js'/);
  // Idempotent inserts: no UPDATE of xp/pet_name, no DELETE of pets.
  assert.match(src, /INSERT OR IGNORE INTO user_pets/);
  assert.match(src, /INSERT OR IGNORE INTO equipped_pet/);
  assert.doesNotMatch(src, /UPDATE user_pets SET xp/);
  assert.doesNotMatch(src, /UPDATE user_pets SET pet_name/);
  assert.doesNotMatch(src, /DELETE FROM user_pets/);
  assert.doesNotMatch(src, /DELETE FROM equipped_pet/);
  // Restoration never charges coins or writes a purchase.
  assert.doesNotMatch(src, /balance/);
  assert.doesNotMatch(src, /purchases/);
  // Claim is marked processed only after the restore returns.
  const restoreAt = src.indexOf('await restorePetsForRecord(');
  const markAt = src.indexOf("SET status = 'processed'");
  assert.ok(restoreAt > 0 && markAt > restoreAt, 'mark processed after restoring');
  assert.match(src, /releaseClaim\(id, claimTs\)/, 'a failed run rolls the claim back');
});

test('the migration marker table is declared additively', () => {
  const schema = read('tgcloud/schema.js');
  const table = schema.slice(
    schema.indexOf("export const petMigrationStatus = table('pet_migration_status'"),
    schema.indexOf('export const equippedPet'),
  );
  assert.ok(table.length > 0, 'pet_migration_status declared');
  for (const column of ['telegramId', 'source', 'status', 'outcome', 'petsRestored', 'petsSkipped', 'processedAt']) {
    assert.match(table, new RegExp(`${column}:`), column);
  }
  assert.match(table, /telegramId: integer\('telegram_id'\)\.primaryKey\(\)/);

  // Also created lazily at runtime, like the rest of the pet schema.
  const migration = read('tgcloud/lib/pet/migration.js');
  assert.match(migration, /CREATE TABLE IF NOT EXISTS pet_migration_status/);
});

test('restoration values are validated, never guessed', () => {
  const src = read('tgcloud/lib/pet/migration.js');
  assert.match(src, /if \(!PETS\[petId\]\) return null;/, 'unknown pet ids are skipped');
  assert.match(src, /PET_XP_CAP/, 'xp is capped');
  assert.match(src, /PET_MAX_LEVEL/, 'level is bounded');
  assert.match(src, /PET_XP_THRESHOLDS\[snapshotLevel\]/, 'level floor from the snapshot');
  assert.match(src, /sanitizePetName/, 'custom names are sanitised');
  assert.match(src, /entry\?\.equipped === true/, 'equipped flag must be a real boolean');
  assert.match(src, /PET_MAX_ENERGY/, 'restored pets start at full energy');

  const dir = new URL('tgcloud/lib/pet/data/', root);
  assert.ok(fs.existsSync(new URL('missfrozen_pet_migration.json', dir)));
  // The snapshot is not edited by hand: the mirror is generated from it.
  assert.match(read('tgcloud/lib/pet/migration_data.js'), /AUTO-GENERATED/);
});

test('snapshot pet ids and levels match this build', async () => {
  const { PETS, PET_MAX_LEVEL, petLevelForXp } = await import('../tgcloud/lib/pet/defs.js');
  const data = JSON.parse(read('tgcloud/lib/pet/data/missfrozen_pet_migration.json'));
  for (const user of data.users) {
    assert.ok(Array.isArray(user.owned_pets), `user ${user.user_id}`);
    for (const pet of user.owned_pets) {
      assert.ok(PETS[pet.pet_id], `unknown pet ${pet.pet_id} in the snapshot`);
      assert.ok(pet.level >= 1 && pet.level <= PET_MAX_LEVEL, `${pet.pet_id} level in range`);
      assert.ok(petLevelForXp(pet.xp) <= pet.level, `${pet.pet_id} level never below its xp`);
    }
  }
});
