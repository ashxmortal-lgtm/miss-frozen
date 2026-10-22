import assert from 'node:assert/strict';
import { db, sql } from './sdk_db_stub.mjs';
import {
  buyPet, equipPet, getPet, getEquippedPet, listPets, startPetActivity, settlePetActivities,
  cancelPetActivity, getPetActivity, renamePet, grantSpecialItem, specialItemQty, buyPetFood,
  buyPetNametag, petRewardBonus, petShinobiXpMultiplier, petTimeReduction, getPetStats,
  ensurePetSchema, feedPet, petStateOf, listPetActivities, shinobiAvailability,
} from '../../tgcloud/lib/pet/store.js';
import { PET_ACTIVITIES, PET_FOOD_MENU, PET_MAX_ENERGY } from '../../tgcloud/lib/pet/defs.js';
import {
  ensureDailyMission, getDailyMission, notifyDailyProgress, dailyCycleDate,
} from '../../tgcloud/lib/daily.js';
import { sweepActivities } from '../../tgcloud/lib/activities.js';
import { trainSession } from '../../tgcloud/lib/rpg/training.js';
import {
  buyPropertySolo, getPropertyOwnership, chargePetFeed, refundPetFeed,
  addPropertyEarnings, claimPropertyEarnings, creditIchirakuOwners,
} from '../../tgcloud/lib/property.js';

const U = 42;
const now = () => Math.floor(Date.now() / 1000);
const balance = async (id = U) => Number((await db.get(sql`SELECT balance FROM users WHERE telegram_id = ${id}`))?.balance || 0);
const petRow = async (id, petId) => db.get(sql`SELECT * FROM user_pets WHERE telegram_id = ${id} AND pet_id = ${petId}`);
const activityRow = async (id, petId) => db.get(sql`SELECT * FROM pet_activity WHERE telegram_id = ${id} AND pet_id = ${petId}`);
const activityStatus = async (shinobi, id = U) => (await db.get(sql`
  SELECT status, kind, started_at, ends_at, partner_pet FROM activities
  WHERE telegram_id = ${id} AND shinobi = ${shinobi}
`)) || {};
const forceDue = async (id, petId, shinobi = null) => {
  const t = now();
  await db.run(sql`UPDATE pet_activity SET started_at = ${t - 2000}, ends_at = ${t - 5}
    WHERE telegram_id = ${id} AND pet_id = ${petId}`);
  if (shinobi) {
    await db.run(sql`UPDATE activities SET started_at = ${t - 2000}, ends_at = ${t - 5}
      WHERE telegram_id = ${id} AND shinobi = ${shinobi}`);
  }
};

await ensurePetSchema();
await db.run(sql`INSERT INTO users (telegram_id, balance, first_name) VALUES (${U}, 200000, 'Tester')`);
await db.run(sql`INSERT INTO inventory (telegram_id, item_type, item_name, qty) VALUES (${U}, 'shinobi', 'Starter Shinobi', 1)`);
await db.run(sql`INSERT INTO inventory (telegram_id, item_type, item_name, qty) VALUES (${U}, 'shinobi', 'Sasuke', 1)`);
await db.run(sql`INSERT INTO inventory (telegram_id, item_type, item_name, qty) VALUES (${U}, 'shinobi', 'Sakura', 1)`);
await db.run(sql`INSERT INTO inventory (telegram_id, item_type, item_name, qty) VALUES (${U}, 'shinobi', 'Tsunade', 1)`);

// ---- purchase: one charge under duplicate taps, never auto-equips ----
const [first, second] = await Promise.all([
  buyPet(U, 'axofly', 'buy-a'),
  buyPet(U, 'axofly', 'buy-b'),
]);
assert.ok([first.code, second.code].includes('ok'), 'one purchase succeeds');
assert.ok([first.code, second.code].some((c) => c === 'already_owned' || c === 'duplicate'));
assert.equal(await balance(), 170000, 'exactly one 30,000 charge');
assert.equal(await getEquippedPet(U), null, 'buying never equips');
assert.equal((await petRow(U, 'axofly')).equipped, 0);
assert.equal((await startPetActivity(U, 'axofly', 'play', { shinobi: 'Starter Shinobi' })).code, 'not_equipped');
assert.equal((await equipPet(U, 'axofly')).code, 'ok');
assert.equal((await petRow(U, 'axofly')).equipped, 1);
assert.equal((await equipPet(U, 'axofly')).code, 'already_equipped');
assert.equal((await equipPet(U, 'capycorn')).code, 'not_owned');

// ---- shinobi training is blocked while the shinobi is locked in play ----
await db.run(sql`INSERT INTO activities (telegram_id, shinobi, kind, status, started_at, ends_at)
  VALUES (${U}, 'Sakura', 'pet', 'active', ${now()}, ${now() + 1800})`);
const lockedTrain = await trainSession(U, 'Sakura', 'Tsunade');
assert.equal(lockedTrain.code, 'busy', 'play locks the shinobi against training');
await db.run(sql`DELETE FROM activities WHERE telegram_id = ${U} AND shinobi = 'Sakura'`);

// ---- ownership guards ----
assert.equal(await getPet(999, 'axofly'), null, "another user's pet is not readable");
assert.equal((await startPetActivity(U, 'capycorn', 'play', { shinobi: 'Starter Shinobi' })).code, 'no_pet');
assert.equal((await feedPet(U, 'ninja_meal', 'own-1', 0, 'capycorn')).code, 'not_owned');

// ---- feeding is instant: coins, energy, XP; blocked at full energy ----
assert.equal((await feedPet(U, 'ninja_meal', 'feed-full')).code, 'full_energy');
await db.run(sql`UPDATE user_pets SET energy = 50 WHERE telegram_id = ${U} AND pet_id = 'axofly'`);
const balBeforeFeed = await balance();
const fed = await feedPet(U, 'ninja_meal', 'feed-1');
assert.equal(fed.code, 'ok');
assert.equal(fed.energyBefore, 50);
assert.equal(fed.energyAfter, 60, '+10 energy');
assert.equal(fed.petXp, 100);
assert.equal(await balance(), balBeforeFeed - PET_FOOD_MENU.ninja_meal.cost);
assert.equal((await feedPet(U, 'ninja_meal', 'feed-1')).code, 'duplicate', 'same tap charges once');
assert.equal(await balance(), balBeforeFeed - PET_FOOD_MENU.ninja_meal.cost);
assert.equal((await petRow(U, 'axofly')).xp, 100, 'food XP lands once');

// cap: XP never crosses 15,000
await db.run(sql`UPDATE user_pets SET xp = 14990 WHERE telegram_id = ${U} AND pet_id = 'axofly'`);
const capped = await feedPet(U, 'feast', 'feed-cap');
assert.equal(capped.code, 'ok');
assert.equal(capped.petXp, 10);
assert.equal((await petRow(U, 'axofly')).xp, 15000);
await db.run(sql`UPDATE user_pets SET xp = 100 WHERE telegram_id = ${U} AND pet_id = 'axofly'`);

// insufficient coins never grants food or energy
await db.run(sql`UPDATE users SET balance = 10 WHERE telegram_id = ${U}`);
await db.run(sql`UPDATE user_pets SET energy = 20 WHERE telegram_id = ${U} AND pet_id = 'axofly'`);
assert.equal((await feedPet(U, 'feast', 'feed-broke')).code, 'insufficient');
assert.equal((await balance()), 10);
assert.equal((await petRow(U, 'axofly')).energy, 20);
await db.run(sql`UPDATE users SET balance = 200000 WHERE telegram_id = ${U}`);

// ---- play: 30 minutes, locks pet AND shinobi ----
assert.equal((await startPetActivity(U, 'axofly', 'play')).code, 'no_shinobi');
assert.equal((await startPetActivity(U, 'axofly', 'play', { shinobi: 'Naruto' })).code, 'shinobi_unavailable');

const [p1, p2] = await Promise.all([
  startPetActivity(U, 'axofly', 'play', { shinobi: 'Starter Shinobi', chatId: -100 }),
  startPetActivity(U, 'axofly', 'play', { shinobi: 'Starter Shinobi', chatId: -100 }),
]);
assert.ok([p1.code, p2.code].includes('ok'), 'one play session starts');
assert.ok([p1.code, p2.code].some((c) => c === 'duplicate_session' || c === 'busy' || c === 'shinobi_busy'),
  'the concurrent request cannot start a second session');
const startedAt = now();
const playRow = await activityRow(U, 'axofly');
assert.equal(playRow.activity_type, 'play');
assert.ok(Math.abs(playRow.ends_at - (playRow.started_at + 30 * 60)) <= 2, 'play lasts 30 minutes');
assert.ok(Math.abs(playRow.started_at - startedAt) <= 2);
assert.equal(playRow.shinobi_name, 'Starter Shinobi');
const shinobiRow = await activityStatus('Starter Shinobi');
assert.equal(shinobiRow.status, 'active');
assert.equal(shinobiRow.kind, 'pet');
assert.equal(shinobiRow.partner_pet, 'axofly', 'the shinobi records which pet it is playing with');

assert.equal(await shinobiAvailability(U, 'Starter Shinobi'), 'pet_busy');

assert.equal((await startPetActivity(U, 'axofly', 'train')).code, 'busy', 'pet training is blocked during play');
assert.equal((await startPetActivity(U, 'axofly', 'rest')).code, 'busy');
assert.equal((await feedPet(U, 'chakra_treat', 'feed-busy')).code, 'busy', 'feeding is blocked during play');
assert.equal((await cancelPetActivity(U, 'axofly')).code, 'not_cancellable', 'play cannot be abandoned');

const activityState = petStateOf({ exhausted: 0 }, await getPetActivity(U, 'axofly'));
assert.equal(activityState.status, 'PLAYING');
assert.equal((await listPets(U)).find((p) => p.petId === 'axofly').status, 'PLAYING');

// ---- play completion: XP once, exhausted, shinobi released ----
const xpBeforePlay = (await petRow(U, 'axofly')).xp;
await forceDue(U, 'axofly', 'Starter Shinobi');
const playDone = await settlePetActivities(U);
assert.equal(playDone.length, 1);
assert.equal(playDone[0].xp, PET_ACTIVITIES.play.xp);
assert.equal((await petRow(U, 'axofly')).xp, Math.min(15000, xpBeforePlay + PET_ACTIVITIES.play.xp));
assert.equal((await petRow(U, 'axofly')).exhausted, 1, 'play exhausts the pet');
assert.equal(await activityRow(U, 'axofly'), null, 'session row cleared');
assert.equal((await activityStatus('Starter Shinobi')).status, 'idle', 'shinobi released at completion');
assert.equal((await activityStatus('Starter Shinobi')).partner_pet, null);
assert.equal((await settlePetActivities(U)).length, 0, 'completion settles once');
assert.equal((await petRow(U, 'axofly')).xp, Math.min(15000, xpBeforePlay + PET_ACTIVITIES.play.xp), 'no double XP');

// ---- exhausted: only Rest is allowed ----
assert.equal((await startPetActivity(U, 'axofly', 'play', { shinobi: 'Sasuke' })).code, 'rest_required');
assert.equal((await startPetActivity(U, 'axofly', 'train')).code, 'rest_required');
assert.equal((await feedPet(U, 'ninja_meal', 'feed-exhausted')).code, 'busy');
assert.equal((await startPetActivity(U, 'axofly', 'rest')).code, 'ok');
assert.equal((await activityRow(U, 'axofly')).activity_type, 'rest');
assert.ok((await activityRow(U, 'axofly')).ends_at <= now() + 30 * 60 + 2, 'rest lasts 30 minutes');

// waking early gives no recovery and no reward
await db.run(sql`UPDATE user_pets SET energy = 5 WHERE telegram_id = ${U} AND pet_id = 'axofly'`);
assert.equal((await cancelPetActivity(U, 'axofly')).code, 'ok');
assert.equal((await petRow(U, 'axofly')).exhausted, 1, 'cancelled rest does not clear exhaustion');
assert.equal((await petRow(U, 'axofly')).energy, 5, 'cancelled rest restores no energy');
assert.equal((await getPetStats(U)).restCount, 0, 'cancelled rest is not counted');

// completed rest restores the configured energy and clears exhaustion
assert.equal((await startPetActivity(U, 'axofly', 'rest')).code, 'ok');
await forceDue(U, 'axofly');
const restDone = await settlePetActivities(U);
assert.equal(restDone.length, 1);
assert.equal(restDone[0].xp, 0, 'rest pays no XP');
assert.equal(restDone[0].energyRestored, true);
assert.equal((await petRow(U, 'axofly')).energy, PET_MAX_ENERGY);
assert.equal((await petRow(U, 'axofly')).exhausted, 0);
assert.equal((await getPetStats(U)).restCount, 1, 'completed rest is counted once');
assert.equal((await settlePetActivities(U)).length, 0);

// ---- train: 2 hours, pet-only lock ----
const balBeforeTrain = await balance();
const train = await startPetActivity(U, 'axofly', 'train');
assert.equal(train.code, 'ok');
const trainRow = await activityRow(U, 'axofly');
assert.equal(trainRow.activity_type, 'train');
assert.ok(Math.abs(trainRow.ends_at - (trainRow.started_at + 120 * 60)) <= 2, 'train lasts 2 hours');
assert.equal(trainRow.shinobi_name, null, 'training does not lock a shinobi');
assert.equal(await balance(), balBeforeTrain, 'training costs no coins');
assert.equal((await startPetActivity(U, 'axofly', 'play', { shinobi: 'Starter Shinobi' })).code, 'busy');

const xpBeforeTrain = (await petRow(U, 'axofly')).xp;
await forceDue(U, 'axofly');
const trainDone = await settlePetActivities(U);
assert.equal(trainDone.length, 1);
assert.equal(trainDone[0].xp, PET_ACTIVITIES.train.xp);
assert.equal((await petRow(U, 'axofly')).exhausted, 1, 'train exhausts the pet');
assert.equal((await petRow(U, 'axofly')).xp, Math.min(15000, xpBeforeTrain + PET_ACTIVITIES.train.xp));

// ---- level up on completion, combined into one event ----
await db.run(sql`UPDATE user_pets SET xp = 900, exhausted = 0 WHERE telegram_id = ${U} AND pet_id = 'axofly'`);
assert.equal((await startPetActivity(U, 'axofly', 'train')).code, 'ok');
await forceDue(U, 'axofly');
const levelDone = await settlePetActivities(U);
assert.equal(levelDone[0].level, 2, '900 + 150 XP reaches level 2');
assert.equal(levelDone[0].levelUp, true);
assert.equal(levelDone[0].totalXp, 1050);
// rest back to ready for the remaining checks
assert.equal((await startPetActivity(U, 'axofly', 'rest')).code, 'ok');
await forceDue(U, 'axofly');
await settlePetActivities(U);
assert.equal((await petRow(U, 'axofly')).exhausted, 0);

// ---- the lazy sweep settles sessions even if /pet is never reopened ----
assert.equal((await startPetActivity(U, 'axofly', 'play', { shinobi: 'Starter Shinobi' })).code, 'ok');
await forceDue(U, 'axofly', 'Starter Shinobi');
const swept = await sweepActivities();
assert.ok(swept.some((r) => r.kind === 'pet' && r.id === U), 'sweep reports the pet completion');
assert.equal((await activityStatus('Starter Shinobi')).status, 'idle', 'sweep frees the shinobi');
assert.ok((await getPet(U, 'axofly')).xp >= 1050 + PET_ACTIVITIES.play.xp);

// rest to ready again
await db.run(sql`UPDATE user_pets SET exhausted = 1 WHERE telegram_id = ${U} AND pet_id = 'axofly'`);
assert.equal((await startPetActivity(U, 'axofly', 'rest')).code, 'ok');
await forceDue(U, 'axofly');
await settlePetActivities(U);
assert.equal((await petRow(U, 'axofly')).exhausted, 0);

// ---- Capycorn: purchase, equip, max-level reduction ----
assert.equal((await buyPet(U, 'capycorn', 'buy-c')).code, 'ok');
await equipPet(U, 'axofly');
assert.equal((await petRow(U, 'capycorn')).equipped, 0);
await db.run(sql`UPDATE user_pets SET xp = 15000 WHERE telegram_id = ${U} AND pet_id = 'capycorn'`);
await equipPet(U, 'capycorn');
assert.equal((await getEquippedPet(U)).petId, 'capycorn');
assert.equal(
  (await startPetActivity(U, 'axofly', 'play', { shinobi: 'Starter Shinobi' })).code,
  'not_equipped',
  'only the equipped pet can take an activity',
);
const pace = await petTimeReduction(U);
assert.equal(pace.durationFrac, 0.10);
assert.equal(pace.cooldownFrac, 0.07);
assert.equal((await petRow(U, 'axofly')).equipped, 0, 'only one pet equipped');

// ---- Axofly: max-level reward bonus + XP multiplier (injected roll) ----
await equipPet(U, 'axofly');
await db.run(sql`UPDATE user_pets SET xp = 15000 WHERE telegram_id = ${U} AND pet_id = 'axofly'`);
const originalRandom = Math.random;
Math.random = () => 0;
const bonus = await petRewardBonus(U, 1000);
Math.random = originalRandom;
assert.equal(bonus.triggered, true);
assert.equal(bonus.bonus, 250);
assert.equal((await getPetStats(U)).rewardTriggers, 1);
assert.ok(Math.abs((await petShinobiXpMultiplier(U)) - 1.07) < 1e-9);

// ---- nametag + rename ----
assert.equal((await renamePet(U, 'axofly', 'Fluffy')).code, 'no_nametag');
const balBeforeTag = await balance();
await db.run(sql`UPDATE users SET balance = ${3010} WHERE telegram_id = ${U}`);
assert.equal((await buyPetNametag(U, 'tag-key')).code, 'ok');
assert.equal(await balance(), 10);
assert.equal(await specialItemQty(U, 'pet_nametag'), 1);
assert.equal((await buyPetNametag(U, 'tag-key')).code, 'duplicate', 'same tap charges once');
assert.equal(await balance(), 10);
assert.equal((await buyPetNametag(U, 'tag-key-2')).code, 'insufficient');
assert.equal(await specialItemQty(U, 'pet_nametag'), 1, 'no item without payment');
await grantSpecialItem(U, 'pet_nametag', 1);
assert.equal(await specialItemQty(U, 'pet_nametag'), 2);
assert.equal((await renamePet(U, 'axofly', 'x'.repeat(25))).code, 'invalid_name');
assert.equal((await renamePet(U, 'axofly', '  Fluffy  ')).code, 'ok');
assert.equal((await getPet(U, 'axofly')).name, 'Fluffy');
assert.equal(await specialItemQty(U, 'pet_nametag'), 1, 'rename consumes exactly one nametag');
await db.run(sql`UPDATE users SET balance = ${balBeforeTag} WHERE telegram_id = ${U}`);

// ---- inventory-facing session list ----
assert.equal((await startPetActivity(U, 'axofly', 'play', { shinobi: 'Starter Shinobi' })).code, 'ok');
const live = await listPetActivities(U);
assert.equal(live.length, 1);
assert.equal(live[0].activityType, 'play');
assert.equal(live[0].shinobiName, 'Starter Shinobi');
const settledLive = await settlePetActivities(U);
assert.equal(settledLive.length, 0, 'live row is still running');
await forceDue(U, 'axofly', 'Starter Shinobi');
await settlePetActivities(U);

// ---- daily mission: one assignment, one settlement ----
await db.run(sql`INSERT INTO inventory (telegram_id, item_type, item_name, qty) VALUES (${U}, 'shinobi', 'Itachi', 1)`);
const mission = await ensureDailyMission(U, null, () => 0);
assert.equal(mission.missionId, 'bounty_hunter');
assert.equal(mission.status, 'assigned');
const balBefore = await balance();
const progress = await notifyDailyProgress(U, 'kill_success', 'kill-key-1');
assert.equal(progress.completed, true);
assert.equal(progress.awarded, true);
assert.equal(await balance(), balBefore + 2500);
assert.equal(await notifyDailyProgress(U, 'kill_success', 'kill-key-1'), null, 'same event cannot progress twice');
assert.equal(await balance(), balBefore + 2500, 'reward paid once');
const done = await getDailyMission(U);
assert.equal(done.status, 'completed');
assert.equal(done.rewardSettled, 1);
const same = await ensureDailyMission(U, null, () => 0.9);
assert.equal(same.missionId, 'bounty_hunter', 'completed cycle never rerolls');
await db.run(sql`UPDATE daily_missions SET status = 'completed', reward_settled = 1 WHERE user_id = ${U}`);
await db.run(sql`
  INSERT INTO daily_missions
    (user_id, cycle_date, mission_id, requirement_type, target_count, progress, reward_coins,
     status, assigned_at, reward_settled)
  VALUES (999, '2000-01-01', 'patrol_duty', 'patrol_complete', 1, 0, 750, 'assigned', 0, 0)
`);
const expired = await ensureDailyMission(999, null, () => 0);
assert.ok(expired);
assert.equal((await db.get(sql`SELECT status FROM daily_missions WHERE user_id = 999 AND cycle_date = '2000-01-01'`)).status, 'expired');

// ---- property fee helpers remain functional (BBQ / Ichiraku ownership) ----
assert.deepEqual(await chargePetFeed(-100, U, 'feed-key-1'), { code: 'no_property', fee: 150 });
const balAfterPets = await balance();
assert.equal((await buyPropertySolo(-100, U, 'bbq', 'prop-1')).code, 'ok');
assert.equal(await balance(), balAfterPets - 100000);
assert.equal((await getPropertyOwnership(-100, 'bbq')).owner1, U);
const balBeforeFee = await balance();
assert.deepEqual(await chargePetFeed(-100, U, 'feed-key-2'), { code: 'ok', fee: 150 });
assert.equal(await balance(), balBeforeFee - 150);
assert.equal((await getPropertyOwnership(-100, 'bbq')).pending1, 150);
assert.equal((await chargePetFeed(-100, U, 'feed-key-2')).code, 'duplicate');
assert.equal(await balance(), balBeforeFee - 150, 'duplicate tap charges once');
await refundPetFeed(-100, U, 150);
assert.equal(await balance(), balBeforeFee, 'refund restores the fee');
assert.equal((await getPropertyOwnership(-100, 'bbq')).pending1, 0);

await db.run(sql`INSERT INTO users (telegram_id, balance) VALUES (43, 0)`);
assert.equal((await chargePetFeed(-100, 43, 'feed-key-3')).code, 'insufficient');

await addPropertyEarnings(-100, 'bbq', 1000);
assert.deepEqual(await claimPropertyEarnings(-100, U, 'bbq'), { code: 'ok', amount: 1000 });
assert.equal((await claimPropertyEarnings(-100, U, 'bbq')).code, 'nothing');

await db.run(sql`INSERT INTO property_ownership
  (group_id, property_id, ownership_type, owner_1, owner_2, share_1, share_2, pending_1, pending_2)
  VALUES (-300, 'bbq', 'partnership', 42, 44, 60, 40, 0, 0)`);
await addPropertyEarnings(-300, 'bbq', 1000);
assert.equal((await getPropertyOwnership(-300, 'bbq')).pending1, 600);
assert.equal((await getPropertyOwnership(-300, 'bbq')).pending2, 400);

// Ichiraku owner cut on pet-food sales
await db.run(sql`INSERT INTO users (telegram_id, balance) VALUES (44, 200000)`);
assert.equal((await buyPropertySolo(-200, 44, 'ichiraku', 'prop-3')).code, 'ok');
assert.equal(await creditIchirakuOwners(-200, 500), 500);
assert.equal((await getPropertyOwnership(-200, 'ichiraku')).pending1, 500);
await db.run(sql`DELETE FROM pet_activity WHERE telegram_id = ${U}`);
await db.run(sql`UPDATE user_pets SET exhausted = 0, energy = 10
  WHERE telegram_id = ${U} AND pet_id = 'axofly'`);
const cutFeed = await buyPetFood(U, 'feast', 'ichiraku-cut', -200);
assert.equal(cutFeed.code, 'ok');
assert.equal(cutFeed.energyAfter - cutFeed.energyBefore, PET_FOOD_MENU.feast.energy);
assert.equal((await getPropertyOwnership(-200, 'ichiraku')).pending1, 2500);

// ---- pet daily mission: feeding progresses only once per purchase ----
const V = 77;
await db.run(sql`INSERT INTO users (telegram_id, balance) VALUES (${V}, 200000)`);
await db.run(sql`INSERT INTO inventory (telegram_id, item_type, item_name, qty)
  VALUES (${V}, 'shinobi', 'Starter Shinobi', 1)`);
assert.equal((await buyPet(V, 'axofly', 'daily-buy')).code, 'ok');
assert.equal((await equipPet(V, 'axofly')).code, 'ok');
await db.run(sql`UPDATE user_pets SET energy = 10 WHERE telegram_id = ${V} AND pet_id = 'axofly'`);
await db.run(sql`
  INSERT INTO daily_missions
    (user_id, cycle_date, mission_id, requirement_type, target_count, progress, reward_coins,
     status, assigned_at, reward_settled)
  VALUES (${V}, ${dailyCycleDate()}, 'feed_companion', 'pet_feed', 1, 0, 750, 'assigned', ${now()}, 0)
`);
const dailyStart = await feedPet(V, 'chakra_treat', 'daily-feed-1');
assert.equal(dailyStart.code, 'ok');
const dailyDone = await getDailyMission(V);
assert.equal(dailyDone.progress, 1, 'feeding progresses the daily mission');
assert.equal(dailyDone.status, 'completed');
assert.equal((await getDailyMission(V)).rewardSettled, 1, 'daily reward settles once');
assert.equal((await feedPet(V, 'chakra_treat', 'daily-feed-1')).code, 'duplicate');

// ---- legacy open-ended Rest rows still complete after 30 minutes ----
await db.run(sql`DELETE FROM pet_activity WHERE telegram_id = ${V}`);
await db.run(sql`UPDATE user_pets SET exhausted = 1, energy = 0
  WHERE telegram_id = ${V} AND pet_id = 'axofly'`);
await db.run(sql`
  INSERT INTO pet_activity
    (telegram_id, pet_id, activity_type, status, started_at, ends_at, cooldown_until,
     chat_id, shinobi_name)
  VALUES (${V}, 'axofly', 'rest', 'active', ${now() - 1900}, 0, 0, 0, NULL)
`);
const legacyDone = await settlePetActivities(V);
assert.equal(legacyDone.length, 1, 'old open-ended rest settles');
assert.equal(legacyDone[0].activityType, 'rest');
assert.equal(legacyDone[0].xp, 0, 'legacy rest pays no XP');
assert.equal((await petRow(V, 'axofly')).exhausted, 0);
assert.equal((await petRow(V, 'axofly')).energy, PET_MAX_ENERGY);

console.log('pet engine integration: OK');
