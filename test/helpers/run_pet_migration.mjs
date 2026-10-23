/**
 * Pet-migration integration test: runs the real migration module against an
 * in-memory SQLite database through the SDK shim.
 *
 * Covers: single-pet owner, multi-pet owner, user without pets, repeated
 * interactions, pre-existing live data, failed runs, in-flight/stale claims,
 * unknown pet ids, level flooring, and the "no coins moved" guarantee.
 */
import assert from 'node:assert/strict';
import { db, sql } from './sdk_db_stub.mjs';
import { api } from 'sdk';
import {
  restorePetsOnFirstInteraction, restorePetsForRecord, normalizeMigratedPet,
  getPetMigrationStatus, petMigrationRecordFor, ensurePetMigrationSchema,
  sendPetRestoredNotice, PET_MIGRATION_USER_IDS, PET_MIGRATION_SOURCE,
  PET_MIGRATION_CLAIM_TTL_SECONDS,
} from '../../tgcloud/lib/pet/migration.js';
import { PET_RESTORED_BODY, petRestoredText } from '../../tgcloud/lib/pet/text.js';
import { mention, style } from '../../tgcloud/lib/texts.js';
import { PET_MIGRATION_SNAPSHOT } from '../../tgcloud/lib/pet/migration_data.js';
import { ensurePetSchema, listPets, getEquippedPet } from '../../tgcloud/lib/pet/store.js';
import { PET_MAX_ENERGY, PET_XP_THRESHOLDS, petLevelForXp } from '../../tgcloud/lib/pet/defs.js';

const now = () => Math.floor(Date.now() / 1000);

const petRows = async (id) => db.all(sql`
  SELECT * FROM user_pets WHERE telegram_id = ${id} ORDER BY pet_id
`);
const petRow = async (id, petId) => db.get(sql`
  SELECT * FROM user_pets WHERE telegram_id = ${id} AND pet_id = ${petId}
`);
const markerRow = async (id) => db.get(sql`
  SELECT * FROM pet_migration_status WHERE telegram_id = ${id}
`);
const equippedRow = async (id) => db.get(sql`
  SELECT * FROM equipped_pet WHERE telegram_id = ${id}
`);
const balanceOf = async (id) => Number((await db.get(sql`
  SELECT balance FROM users WHERE telegram_id = ${id}
`))?.balance || 0);
const purchaseCount = async (id) => Number((await db.get(sql`
  SELECT COUNT(*) AS n FROM purchases WHERE telegram_id = ${id}
`))?.n || 0);

await ensurePetSchema();
await ensurePetMigrationSchema();

// ---- the bundled snapshot is the source of truth -------------------------
assert.equal(PET_MIGRATION_SNAPSHOT.format, 'missfrozen_pet_migration_v1');
assert.deepEqual(PET_MIGRATION_USER_IDS, [1292564068, 5067983759, 6100847287, 6972384968]);
assert.equal(petMigrationRecordFor(1292564068).owned_pets.length, 1);
assert.equal(petMigrationRecordFor(123), null);
assert.equal(PET_MIGRATION_SOURCE, 'missfrozen_pet_migration_v1@2026-10-22T10:04:40+00:00');

// ---- pet-owner with a single pet + custom name ---------------------------
const SINGLE = 1292564068;
await db.run(sql`INSERT OR IGNORE INTO users (telegram_id, balance) VALUES (${SINGLE}, 0)`);
const single = await restorePetsOnFirstInteraction(SINGLE);
assert.equal(single.status, 'restored');
assert.equal(single.restored, 1);
assert.equal(single.matched, true);
assert.equal(single.equipped, 'axofly');

const axofly = await petRow(SINGLE, 'axofly');
assert.ok(axofly, 'axofly restored');
assert.equal(Number(axofly.xp), 875, 'xp preserved exactly');
assert.equal(axofly.pet_name, '...❄️Snowwy༻꧂', 'custom name preserved verbatim');
assert.equal(Number(axofly.energy), PET_MAX_ENERGY);
assert.equal(Number(axofly.exhausted), 0);
assert.equal(Number(axofly.equipped), 1);
assert.equal(petLevelForXp(875), 1, 'snapshot level agrees with the derived level');

const singlePets = await listPets(SINGLE);
assert.equal(singlePets.length, 1);
assert.equal(singlePets[0].petId, 'axofly');
assert.equal(singlePets[0].name, '...❄️Snowwy༻꧂');
assert.equal(singlePets[0].xp, 875);
assert.equal(singlePets[0].level, 1);
assert.equal((await getEquippedPet(SINGLE)).petId, 'axofly', 'equipped pet restored');
const singleStats = await db.get(sql`SELECT * FROM pet_stats WHERE telegram_id = ${SINGLE}`);
assert.ok(singleStats, 'pet_stats row ensured');
assert.equal(await balanceOf(SINGLE), 0, 'restoration never charges coins');
assert.equal(await purchaseCount(SINGLE), 0, 'restoration never logs a purchase');

// ---- repeated interactions never migrate twice ---------------------------
const again = await restorePetsOnFirstInteraction(SINGLE);
assert.equal(again.status, 'already_processed');
assert.equal(again.restored, 0);
assert.equal((await petRows(SINGLE)).length, 1, 'no duplicate pet');

// Even if the marker were lost, INSERT OR IGNORE keeps live progress.
await db.run(sql`UPDATE user_pets SET xp = 5000, pet_name = 'Snowy Live' WHERE telegram_id = ${SINGLE} AND pet_id = 'axofly'`);
await db.run(sql`DELETE FROM pet_migration_status WHERE telegram_id = ${SINGLE}`);
const retry = await restorePetsOnFirstInteraction(SINGLE);
assert.equal(retry.status, 'none', 'existing row counts as kept, nothing new restored');
assert.equal(retry.restored, 0);
const keptRow = await petRow(SINGLE, 'axofly');
assert.equal(Number(keptRow.xp), 5000, 'live xp never overwritten');
assert.equal(keptRow.pet_name, 'Snowy Live', 'live name never overwritten');
assert.equal((await petRows(SINGLE)).length, 1);
assert.equal((await markerRow(SINGLE)).outcome, 'none');
assert.equal(Number((await markerRow(SINGLE)).pets_skipped), 1);

// ---- multiple pets for one user ------------------------------------------
const MULTI = 6100847287;
const multi = await restorePetsOnFirstInteraction(MULTI);
assert.equal(multi.status, 'restored');
assert.equal(multi.restored, 2, 'both pets restored');
assert.equal(multi.equipped, 'axofly');

const multiRows = await petRows(MULTI);
assert.deepEqual(multiRows.map((r) => r.pet_id), ['axofly', 'capycorn']);
assert.equal(Number(multiRows[0].equipped), 1, 'axofly equipped');
assert.equal(Number(multiRows[1].equipped), 0, 'capycorn not equipped');
assert.equal((await equippedRow(MULTI)).pet_id, 'axofly');
assert.equal((await listPets(MULTI)).length, 2);
assert.equal(Number((await markerRow(MULTI)).pets_restored), 2);

// ---- second multi-pet user with xp on the non-equipped pet ---------------
const MULTI_XP = 6972384968;
const multiXp = await restorePetsOnFirstInteraction(MULTI_XP);
assert.equal(multiXp.status, 'restored');
assert.equal(multiXp.restored, 2);
const capy = await petRow(MULTI_XP, 'capycorn');
assert.equal(Number(capy.xp), 150);
assert.equal(Number(capy.equipped), 0);
assert.equal((await getEquippedPet(MULTI_XP)).petId, 'axofly');

// ---- user without pets (absent from the snapshot) ------------------------
const STRANGER = 777001;
await db.run(sql`INSERT OR IGNORE INTO users (telegram_id, balance) VALUES (${STRANGER}, 250)`);
const stranger = await restorePetsOnFirstInteraction(STRANGER);
assert.equal(stranger.status, 'none');
assert.equal(stranger.matched, false);
assert.equal(stranger.restored, 0);
assert.equal((await petRows(STRANGER)).length, 0, 'no pet is invented');
assert.equal(await equippedRow(STRANGER), null);
assert.equal(await balanceOf(STRANGER), 250, 'coins untouched');
const strangerAgain = await restorePetsOnFirstInteraction(STRANGER);
assert.equal(strangerAgain.status, 'already_processed');
assert.equal((await petRows(STRANGER)).length, 0);

for (const bad of [0, -5, 'abc', null, undefined]) {
  const res = await restorePetsOnFirstInteraction(bad);
  assert.equal(res.status, 'invalid_user', `invalid id ${bad}`);
}

// ---- existing live data: keep progress, equip only when nothing is live ---
const EXISTING = 5067983759;
const t0 = now();
await db.run(sql`
  INSERT INTO user_pets (telegram_id, pet_id, pet_name, xp, energy, last_energy_at, equipped, acquired_at)
  VALUES (${EXISTING}, 'axofly', 'Live Baby', 9000, 40, ${t0}, 0, ${t0})
`);
await db.run(sql`INSERT OR IGNORE INTO pet_stats (telegram_id) VALUES (${EXISTING})`);
// No equipped_pet row yet -> the snapshot's equipped pet is adopted.
const existing = await restorePetsOnFirstInteraction(EXISTING);
assert.equal(existing.status, 'none', 'nothing new inserted');
assert.equal(existing.restored, 0);
assert.equal(existing.equipped, 'axofly', 'adopted the snapshot equip when none was live');
const liveRow = await petRow(EXISTING, 'axofly');
assert.equal(Number(liveRow.xp), 9000);
assert.equal(liveRow.pet_name, 'Live Baby');
assert.equal(Number(liveRow.energy), 40, 'energy untouched');
assert.equal(Number(liveRow.equipped), 1);

// ---- existing live choice wins over the snapshot -------------------------
const LIVE_CHOICE = 6972384968;
await db.run(sql`DELETE FROM pet_migration_status WHERE telegram_id = ${LIVE_CHOICE}`);
await db.run(sql`DELETE FROM user_pets WHERE telegram_id = ${LIVE_CHOICE}`);
await db.run(sql`DELETE FROM equipped_pet WHERE telegram_id = ${LIVE_CHOICE}`);
await db.run(sql`
  INSERT INTO user_pets (telegram_id, pet_id, pet_name, xp, energy, last_energy_at, equipped, acquired_at)
  VALUES (${LIVE_CHOICE}, 'capycorn', 'My Capy', 2500, 100, ${t0}, 1, ${t0})
`);
await db.run(sql`INSERT INTO equipped_pet (telegram_id, pet_id, updated_at) VALUES (${LIVE_CHOICE}, 'capycorn', ${t0})`);
const liveChoice = await restorePetsOnFirstInteraction(LIVE_CHOICE);
assert.equal(liveChoice.status, 'restored', 'the missing axofly is still restored');
assert.equal(liveChoice.restored, 1);
assert.equal(liveChoice.equipped, null, 'a live equipped pet is never replaced');
assert.equal((await equippedRow(LIVE_CHOICE)).pet_id, 'capycorn');
const capyLive = await petRow(LIVE_CHOICE, 'capycorn');
assert.equal(Number(capyLive.xp), 2500, 'kept xp');
assert.equal(capyLive.pet_name, 'My Capy');
assert.equal(Number(capyLive.equipped), 1);
const restoredAxo = await petRow(LIVE_CHOICE, 'axofly');
assert.equal(Number(restoredAxo.xp), 0);
assert.equal(Number(restoredAxo.equipped), 0);

// ---- concurrency: an in-flight claim is respected ------------------------
const IN_FLIGHT = 6100847287;
await db.run(sql`DELETE FROM pet_migration_status WHERE telegram_id = ${IN_FLIGHT}`);
await db.run(sql`
  INSERT INTO pet_migration_status (telegram_id, source, status, outcome, pets_restored, pets_skipped, processed_at)
  VALUES (${IN_FLIGHT}, ${PET_MIGRATION_SOURCE}, 'processing', NULL, 0, 0, ${now()})
`);
const busy = await restorePetsOnFirstInteraction(IN_FLIGHT);
assert.equal(busy.status, 'in_progress', 'a fresh claim blocks a second worker');
assert.equal(busy.restored, 0);
assert.equal((await markerRow(IN_FLIGHT)).status, 'processing');

// A stale claim is taken over and completed.
await db.run(sql`
  UPDATE pet_migration_status SET processed_at = ${now() - PET_MIGRATION_CLAIM_TTL_SECONDS - 5}
  WHERE telegram_id = ${IN_FLIGHT}
`);
const stale = await restorePetsOnFirstInteraction(IN_FLIGHT);
assert.equal(stale.status, 'none', 'pets already existed, so nothing new is inserted');
assert.equal((await markerRow(IN_FLIGHT)).status, 'processed');

// Two simultaneous first interactions cannot duplicate anything.
const RACE = 5067983759;
await db.run(sql`DELETE FROM pet_migration_status WHERE telegram_id = ${RACE}`);
const [raceA, raceB] = await Promise.all([
  restorePetsOnFirstInteraction(RACE),
  restorePetsOnFirstInteraction(RACE),
]);
assert.ok(['restored', 'none', 'in_progress', 'already_processed'].includes(raceA.status), raceA.status);
assert.ok(['restored', 'none', 'in_progress', 'already_processed'].includes(raceB.status), raceB.status);
assert.equal((await markerRow(RACE)).status, 'processed');
assert.ok((await petRows(RACE)).length <= 1, 'no duplicate pets');
assert.equal((await db.get(sql`
  SELECT COUNT(*) AS n FROM pet_migration_status WHERE telegram_id = ${RACE}
`)).n, 1, 'one marker row');

// ---- a failed restore is never marked processed -------------------------
const FAILING = 6100847287;
await db.run(sql`DELETE FROM pet_migration_status WHERE telegram_id = ${FAILING}`);
await db.run(sql`DELETE FROM user_pets WHERE telegram_id = ${FAILING}`);
await db.run(sql`DELETE FROM equipped_pet WHERE telegram_id = ${FAILING}`);
const realRun = db.run;
let forced = 0;
db.run = async (query) => {
  if (!forced && String(query?.text || '').includes('INSERT OR IGNORE INTO user_pets')) {
    forced += 1;
    throw new Error('simulated write failure');
  }
  return realRun(query);
};
const failed = await restorePetsOnFirstInteraction(FAILING);
db.run = realRun;
assert.equal(failed.status, 'error');
assert.equal(await markerRow(FAILING), null, 'no processed marker after a failure');
assert.equal(forced, 1, 'the simulated failure actually fired');
const recovered = await restorePetsOnFirstInteraction(FAILING);
assert.equal(recovered.status, 'restored', 'the next interaction retries and completes');
assert.equal(recovered.restored, 2);
assert.equal((await markerRow(FAILING)).status, 'processed');
assert.equal((await petRows(FAILING)).length, 2);

// ---- unknown pet ids are ignored, never invented -------------------------
const UNKNOWN = 888002;
const unknown = await restorePetsForRecord(UNKNOWN, {
  user_id: UNKNOWN,
  owned_pets: [
    { pet_id: 'dragon', level: 9, xp: 999999, equipped: true, custom_name: 'Nope' },
    { pet_id: 'axofly', level: 1, xp: 50, equipped: true, custom_name: null },
  ],
});
assert.deepEqual(unknown.ignored, ['dragon']);
assert.deepEqual(unknown.restored, ['axofly']);
assert.equal(unknown.equipped, 'axofly');
assert.equal((await petRows(UNKNOWN)).length, 1);

// ---- level is preserved by flooring xp to that level's threshold --------
assert.deepEqual(
  normalizeMigratedPet({ pet_id: 'axofly', level: 3, xp: 10, equipped: false }),
  { petId: 'axofly', xp: PET_XP_THRESHOLDS[3], level: 3, equipped: false, customName: null },
);
assert.deepEqual(
  normalizeMigratedPet({ pet_id: 'capycorn', level: 2, xp: 2500, equipped: true, custom_name: '  Capy  ' }),
  { petId: 'capycorn', xp: 2500, level: 2, equipped: true, customName: 'Capy' },
);
assert.equal(normalizeMigratedPet({ pet_id: 'dragon' }), null);
assert.deepEqual(
  normalizeMigratedPet({ pet_id: 'AXOFLY', level: 99, xp: -5 }),
  { petId: 'axofly', xp: 0, level: 1, equipped: false, customName: null },
);
// Corrupt xp beyond the engine cap never lifts the pet above the cap.
assert.equal(normalizeMigratedPet({ pet_id: 'axofly', level: 1, xp: 999999 }).xp, 15000);

// ---- an empty owned_pets list restores nothing ---------------------------
const EMPTY = 888003;
const empty = await restorePetsForRecord(EMPTY, { user_id: EMPTY, owned_pets: [] });
assert.deepEqual(empty, { restored: [], kept: [], ignored: [], equipped: null });
assert.equal((await petRows(EMPTY)).length, 0);

// ---- a newer snapshot re-checks the user exactly once --------------------
const RECHECK = 5067983759;
await db.run(sql`
  UPDATE pet_migration_status SET source = 'missfrozen_pet_migration_v1@older'
  WHERE telegram_id = ${RECHECK}
`);
const rechecked = await restorePetsOnFirstInteraction(RECHECK);
assert.equal(rechecked.status, 'none');
assert.equal((await markerRow(RECHECK)).source, PET_MIGRATION_SOURCE);
assert.equal((await markerRow(RECHECK)).status, 'processed');
assert.equal((await petRows(RECHECK)).length, 1, 'still no duplicate');

const status = await getPetMigrationStatus(RECHECK);
assert.equal(status.status, 'processed');
assert.equal(status.outcome, 'none');
assert.equal(status.petsRestored, 0);

// ---- the one-time "your pets are back" notice ----------------------------
const NOTICE = 6972384968;
await db.run(sql`DELETE FROM pet_migration_status WHERE telegram_id = ${NOTICE}`);
await db.run(sql`DELETE FROM user_pets WHERE telegram_id = ${NOTICE}`);
await db.run(sql`DELETE FROM equipped_pet WHERE telegram_id = ${NOTICE}`);

assert.equal(
  style(petRestoredText(mention({ id: NOTICE, first_name: 'Snowy' }))),
  `${style(mention({ id: NOTICE, first_name: 'Snowy' }))}\n\n${style(PET_RESTORED_BODY)}`,
  'restore text = mention + the exact requested body',
);
assert.ok(PET_RESTORED_BODY.startsWith('🐾 ʏᴏᴜʀ ᴘᴇᴛꜱ ᴀʀᴇ ʙᴀᴄᴋ!'));
assert.ok(PET_RESTORED_BODY.endsWith('✨ ᴄʜᴇᴄᴋ ᴏᴜᴛ: /pet'));

const notices = [];
const realSend = api.sendMessage;
api.sendMessage = async (payload) => { notices.push(payload); return { message_id: 1 }; };

const notified = await restorePetsOnFirstInteraction(NOTICE, {
  notify: { user: { id: NOTICE, first_name: 'Snowy' }, chatId: -1001234 },
});
assert.equal(notified.status, 'restored');
assert.equal(notified.restored, 2);
assert.equal(notices.length, 1, 'exactly one notice per restoration');
const notice = notices[0];
assert.equal(notice.chat_id, NOTICE, 'the notice is a DM');
assert.equal(notice.parse_mode, 'HTML');
assert.ok(notice.text.startsWith(`<a href="tg://user?id=${NOTICE}">Snowy</a>`), 'the notice mentions the owner');
assert.ok(notice.text.includes('🐾 ʏᴏᴜʀ ᴘᴇᴛꜱ ᴀʀᴇ ʙᴀᴄᴋ!'));
assert.ok(notice.text.includes('✨ ᴄʜᴇᴄᴋ ᴏᴜᴛ: /pet'));
assert.ok(!notice.text.includes('{mention}'), 'the mention placeholder is resolved');

// Repeated interactions never send it again.
const repeatNotice = await restorePetsOnFirstInteraction(NOTICE, {
  notify: { user: { id: NOTICE, first_name: 'Snowy' }, chatId: -1001234 },
});
assert.equal(repeatNotice.status, 'already_processed');
assert.equal(notices.length, 1, 'no second notice');

// Users without pets are never notified.
const silent = 777001;
await db.run(sql`DELETE FROM pet_migration_status WHERE telegram_id = ${silent}`);
const silentRun = await restorePetsOnFirstInteraction(silent, {
  notify: { user: { id: silent, first_name: 'Nobody' }, chatId: silent },
});
assert.equal(silentRun.status, 'none');
assert.equal(notices.length, 1, 'no notice for a pet-less user');

// A blocked/closed DM falls back to the chat the user interacted in.
const FALLBACK = 6100847287;
await db.run(sql`DELETE FROM pet_migration_status WHERE telegram_id = ${FALLBACK}`);
await db.run(sql`DELETE FROM user_pets WHERE telegram_id = ${FALLBACK}`);
await db.run(sql`DELETE FROM equipped_pet WHERE telegram_id = ${FALLBACK}`);
api.sendMessage = async (payload) => {
  if (Number(payload.chat_id) === FALLBACK) throw new Error('bot was blocked by the user');
  notices.push(payload);
  return { message_id: 2 };
};
const fallback = await restorePetsOnFirstInteraction(FALLBACK, {
  notify: { user: { id: FALLBACK, first_name: 'Capy' }, chatId: -1009876 },
});
api.sendMessage = realSend;
assert.equal(fallback.status, 'restored');
assert.equal(notices.length, 2, 'the notice still reaches the user');
assert.equal(notices.at(-1).chat_id, -1009876, 'fallback target is the origin chat');
assert.ok(notices.at(-1).text.includes(`tg://user?id=${FALLBACK}`));

// The helper is directly usable (e.g. from an owner tool) and validates input.
assert.equal(await sendPetRestoredNotice({ id: 0 }), false);
assert.equal(await sendPetRestoredNotice({ id: NOTICE, first_name: 'Snowy' }), true);

console.log('pet migration integration: OK');
