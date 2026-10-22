import assert from 'node:assert/strict';
import { db, sql } from './sdk_db_stub.mjs';
import {
  buyPet, equipPet, getPet, getEquippedPet, listPets, startPetActivity, settlePetActivities,
  cancelPetActivity, getPetActivity, renamePet, grantSpecialItem, specialItemQty, buyPetFood, buyPetNametag,
  petRewardBonus, petShinobiXpMultiplier, petTimeReduction, getPetStats, ensurePetSchema,
} from '../../tgcloud/lib/pet/store.js';
import {
  ensureDailyMission, getDailyMission, notifyDailyProgress, dailyCycleDate,
} from '../../tgcloud/lib/daily.js';
import { sweepActivities } from '../../tgcloud/lib/activities.js';
import {
  buyPropertySolo, getPropertyOwnership, chargePetFeed, refundPetFeed,
  addPropertyEarnings, claimPropertyEarnings, creditIchirakuOwners,
} from '../../tgcloud/lib/property.js';

const U = 42;
const now = () => Math.floor(Date.now() / 1000);
const balance = async (id = U) => Number((await db.get(sql`SELECT balance FROM users WHERE telegram_id = ${id}`))?.balance || 0);
const petRow = async (id, petId) => db.get(sql`SELECT * FROM user_pets WHERE telegram_id = ${id} AND pet_id = ${petId}`);
const activityRow = async (id, petId) => db.get(sql`SELECT * FROM pet_activity WHERE telegram_id = ${id} AND pet_id = ${petId}`);
const petCooldown = async (id, petId, col) => Number((await petRow(id, petId))?.[col] || 0);
const activityStatus = async (shinobi, id = U) => (await db.get(sql`
  SELECT status, kind, started_at FROM activities WHERE telegram_id = ${id} AND shinobi = ${shinobi}
`)) || {};

await ensurePetSchema();
await db.run(sql`INSERT INTO users (telegram_id, balance, first_name) VALUES (${U}, 200000, 'Tester')`);
await db.run(sql`INSERT INTO inventory (telegram_id, item_type, item_name, qty) VALUES (${U}, 'shinobi', 'Starter Shinobi', 1)`);
await db.run(sql`INSERT INTO inventory (telegram_id, item_type, item_name, qty) VALUES (${U}, 'shinobi', 'Sasuke', 1)`);

// ---- purchase: one charge under duplicate/concurrent taps, no auto-equip ----
const [first, second] = await Promise.all([
  buyPet(U, 'axofly', 'buy-a'),
  buyPet(U, 'axofly', 'buy-b'),
]);
assert.ok([first.code, second.code].includes('ok'), 'one purchase succeeds');
assert.ok([first.code, second.code].some((c) => c === 'already_owned' || c === 'duplicate'));
assert.equal(await balance(), 170000, 'exactly one 30,000 charge');
assert.equal(await getEquippedPet(U), null, 'buying never equips (source get_active_pet)');
assert.equal((await petRow(U, 'axofly')).equipped, 0);
assert.equal((await startPetActivity(U, 'axofly', 'feed', { shinobi: 'Starter Shinobi' })).code, 'not_equipped');
assert.equal((await equipPet(U, 'axofly')).code, 'ok');
assert.equal((await petRow(U, 'axofly')).equipped, 1);
assert.equal((await equipPet(U, 'axofly')).code, 'already_equipped');
assert.equal((await equipPet(U, 'capycorn')).code, 'not_owned');

// ---- shinobi must be chosen, owned and available ----
assert.equal((await startPetActivity(U, 'axofly', 'feed')).code, 'no_shinobi');
assert.equal((await startPetActivity(U, 'axofly', 'feed', { shinobi: 'Naruto' })).code, 'shinobi_unavailable');
await db.run(sql`INSERT INTO activities (telegram_id, shinobi, kind, status, started_at, ends_at)
  VALUES (${U}, 'Sasuke', 'mission', 'active', ${now()}, ${now() + 3600})`);
const onMission = await startPetActivity(U, 'axofly', 'feed', { shinobi: 'Sasuke' });
assert.equal(onMission.code, 'shinobi_unavailable');
assert.equal(onMission.reason, 'on_mission');
await db.run(sql`DELETE FROM activities WHERE telegram_id = ${U} AND shinobi = 'Sasuke'`);

// ---- feed: energy at start, XP only at completion, Shinobi stays busy ----
const feed = await startPetActivity(U, 'axofly', 'feed', { shinobi: 'Starter Shinobi', chatId: -100 });
assert.equal(feed.code, 'ok');
assert.equal((await petRow(U, 'axofly')).energy, 90, '10 energy deducted on start');
assert.equal((await petRow(U, 'axofly')).xp, 0, 'no XP before completion');
assert.equal((await activityStatus('Starter Shinobi')).status, 'active');
assert.equal((await activityStatus('Starter Shinobi')).kind, 'pet');
assert.equal((await startPetActivity(U, 'axofly', 'play', { shinobi: 'Starter Shinobi' })).code, 'busy');
const otherShinobi = await startPetActivity(U, 'axofly', 'feed', { shinobi: 'Sasuke' });
assert.equal(otherShinobi.code, 'busy', 'one activity per pet at a time');

const t0 = now();
await db.run(sql`UPDATE pet_activity SET started_at = ${t0 - 1800}, ends_at = ${t0 - 5}
  WHERE telegram_id = ${U} AND pet_id = 'axofly'`);
await db.run(sql`UPDATE activities SET started_at = ${t0 - 1800}, ends_at = ${t0 - 5}
  WHERE telegram_id = ${U} AND shinobi = 'Starter Shinobi'`);
const settled = await settlePetActivities(U);
assert.equal(settled.length, 1);
assert.equal(settled[0].xp, 50);
assert.equal((await petRow(U, 'axofly')).xp, 50);
const feedCd = settled[0].cooldownUntil;
assert.ok(feedCd >= t0 + 6 * 3600 - 2 && feedCd <= now() + 6 * 3600,
  `cooldown starts at completion, got ${feedCd}`);

assert.equal(await activityRow(U, 'axofly'), null, 'completed activity row is cleared');
assert.equal(await petCooldown(U, 'axofly', 'feed_cooldown_until'), feedCd);
assert.equal((await activityStatus('Starter Shinobi')).status, 'idle', 'Shinobi released on completion');
assert.equal((await settlePetActivities(U)).length, 0, 'completion settles once');
assert.equal((await petRow(U, 'axofly')).xp, 50, 'retry cannot double XP');

// feed cooldown blocks only feed; play is a separate cooldown (source columns)
assert.equal((await startPetActivity(U, 'axofly', 'feed', { shinobi: 'Starter Shinobi' })).code, 'cooldown');
assert.equal((await startPetActivity(U, 'axofly', 'play', { shinobi: 'Starter Shinobi' })).code, 'ok');
const t1 = now();
await db.run(sql`UPDATE pet_activity SET started_at = ${t1 - 2700}, ends_at = ${t1 - 5}
  WHERE telegram_id = ${U} AND pet_id = 'axofly'`);
assert.equal((await settlePetActivities(U))[0].xp, 75);
assert.equal((await petRow(U, 'axofly')).xp, 125);
const playCd = await petCooldown(U, 'axofly', 'play_cooldown_until');
assert.ok(playCd >= t1 + 4 * 3600 - 2 && playCd <= now() + 4 * 3600);

// ---- train energy gate ----
await db.run(sql`UPDATE user_pets SET energy = 5 WHERE telegram_id = ${U} AND pet_id = 'axofly'`);
const noEnergy = await startPetActivity(U, 'axofly', 'train', { shinobi: 'Starter Shinobi' });
assert.equal(noEnergy.code, 'no_energy');
assert.equal(noEnergy.needed, 30);
await db.run(sql`UPDATE user_pets SET energy = 100 WHERE telegram_id = ${U} AND pet_id = 'axofly'`);

// ---- rest: no Shinobi, +15/hour, blocks other activities ----
assert.equal((await startPetActivity(U, 'axofly', 'rest')).code, 'ok');
await db.run(sql`UPDATE user_pets SET energy = 10, last_energy_at = ${now() - 3600}
  WHERE telegram_id = ${U} AND pet_id = 'axofly'`);
assert.equal((await listPets(U)).find((p) => p.petId === 'axofly').energy, 25, '+15 while resting');
assert.equal((await startPetActivity(U, 'axofly', 'feed', { shinobi: 'Starter Shinobi' })).code, 'busy');
assert.equal((await cancelPetActivity(U, 'axofly')).code, 'ok');
assert.equal((await cancelPetActivity(U, 'axofly')).code, 'no_activity');
assert.equal((await getPetStats(U)).restCount, 1, 'rest is counted once');

// normal regeneration outside rest
await db.run(sql`UPDATE user_pets SET energy = 0, last_energy_at = ${now() - 7200}
  WHERE telegram_id = ${U} AND pet_id = 'axofly'`);
assert.equal((await listPets(U)).find((p) => p.petId === 'axofly').energy, 10, '+10 per 2h');

// ---- the lazy sweep settles pet activities even if /pet is never reopened ----
await db.run(sql`UPDATE user_pets SET train_cooldown_until = 0, energy = 100
  WHERE telegram_id = ${U} AND pet_id = 'axofly'`);
const train = await startPetActivity(U, 'axofly', 'train', { shinobi: 'Starter Shinobi' });
assert.equal(train.code, 'ok');
await db.run(sql`UPDATE pet_activity SET ends_at = ${now() - 1}
  WHERE telegram_id = ${U} AND pet_id = 'axofly'`);
await db.run(sql`UPDATE activities SET ends_at = ${now() - 1}
  WHERE telegram_id = ${U} AND shinobi = 'Starter Shinobi'`);
const swept = await sweepActivities();
assert.ok(swept.some((r) => r.kind === 'pet' && r.id === U), 'sweep reports the pet completion');
assert.ok((await getPet(U, 'axofly')).xp >= 275, 'train XP paid by the sweep');
assert.equal((await activityStatus('Starter Shinobi')).status, 'idle', 'sweep frees the Shinobi');

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

// ---- food XP, cap and nametag ----
await db.run(sql`UPDATE user_pets SET xp = 14990 WHERE telegram_id = ${U} AND pet_id = 'axofly'`);
const food = await buyPetFood(U, 'ninja_meal', 'food-1', -100);
assert.equal(food.code, 'ok');
assert.equal(food.petXp, 10);
assert.equal((await petRow(U, 'axofly')).xp, 15000, 'XP capped at 15,000');
const beforeFoodBalance = await balance();
assert.equal((await buyPetFood(U, 'feast', 'food-2')).code, 'ok');
assert.equal(await balance(), beforeFoodBalance - 2000);
assert.equal((await buyPetFood(U, 'feast', 'food-2')).code, 'duplicate', 'same tap cannot charge twice');

assert.equal((await renamePet(U, 'axofly', 'Fluffy')).code, 'no_nametag');
const balBeforeTag = await balance();
await db.run(sql`UPDATE users SET balance = ${3010} WHERE telegram_id = ${U}`);
const nametagBuy = await buyPetNametag(U, 'tag-key');
assert.equal(nametagBuy.code, 'ok');
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
// stale assignment expires instead of rerolling that day
await db.run(sql`
  INSERT INTO daily_missions
    (user_id, cycle_date, mission_id, requirement_type, target_count, progress, reward_coins,
     status, assigned_at, reward_settled)
  VALUES (999, '2000-01-01', 'patrol_duty', 'patrol_complete', 1, 0, 750, 'assigned', 0, 0)
`);
const expired = await ensureDailyMission(999, null, () => 0);
assert.ok(expired);
assert.equal((await db.get(sql`SELECT status FROM daily_missions WHERE user_id = 999 AND cycle_date = '2000-01-01'`)).status, 'expired');

// ---- property + BBQ feed fee ----
const fee = await chargePetFeed(-100, U, 'feed-key-1');
assert.deepEqual(fee, { code: 'no_property', fee: 150 });
const balAfterPets = await balance();
assert.equal((await buyPropertySolo(-100, U, 'bbq', 'prop-1')).code, 'ok');
assert.equal(await balance(), balAfterPets - 100000);
assert.equal((await buyPropertySolo(-100, U, 'bbq', 'prop-2')).code, 'owned');
assert.equal((await getPropertyOwnership(-100, 'bbq')).owner1, U);

const balBeforeFee = await balance();
const paid = await chargePetFeed(-100, U, 'feed-key-2');
assert.deepEqual(paid, { code: 'ok', fee: 150 });
assert.equal(await balance(), balBeforeFee - 150);
assert.equal((await getPropertyOwnership(-100, 'bbq')).pending1, 150);
const dup = await chargePetFeed(-100, U, 'feed-key-2');
assert.equal(dup.code, 'duplicate');
assert.equal(await balance(), balBeforeFee - 150, 'duplicate tap charges once');
await refundPetFeed(-100, U, 150);
assert.equal(await balance(), balBeforeFee, 'failed start refunds the fee');
assert.equal((await getPropertyOwnership(-100, 'bbq')).pending1, 0);

await db.run(sql`INSERT INTO users (telegram_id, balance) VALUES (43, 0)`);
assert.equal((await chargePetFeed(-100, 43, 'feed-key-3')).code, 'insufficient');

await addPropertyEarnings(-100, 'bbq', 1000);
const claim = await claimPropertyEarnings(-100, U, 'bbq');
assert.deepEqual(claim, { code: 'ok', amount: 1000 });
assert.equal((await claimPropertyEarnings(-100, U, 'bbq')).code, 'nothing');

// partnership split
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

// ---- pet daily mission: progress only when the activity COMPLETES (spec §5) ----
const V = 77;
await db.run(sql`INSERT INTO users (telegram_id, balance) VALUES (${V}, 200000)`);
await db.run(sql`INSERT INTO inventory (telegram_id, item_type, item_name, qty)
  VALUES (${V}, 'shinobi', 'Starter Shinobi', 1)`);
assert.equal((await buyPet(V, 'axofly', 'daily-buy')).code, 'ok');
assert.equal((await equipPet(V, 'axofly')).code, 'ok');
await db.run(sql`
  INSERT INTO daily_missions
    (user_id, cycle_date, mission_id, requirement_type, target_count, progress, reward_coins,
     status, assigned_at, reward_settled)
  VALUES (${V}, ${dailyCycleDate()}, 'feed_companion', 'pet_feed', 1, 0, 750, 'assigned', ${now()}, 0)
`);
const dailyStart = await startPetActivity(V, 'axofly', 'feed', { shinobi: 'Starter Shinobi' });
assert.equal(dailyStart.code, 'ok');
assert.equal((await getDailyMission(V)).progress, 0, 'start does not progress the daily mission');
await db.run(sql`UPDATE pet_activity SET started_at = ${now() - 1900}, ends_at = ${now() - 5}
  WHERE telegram_id = ${V} AND pet_id = 'axofly'`);
await db.run(sql`UPDATE activities SET started_at = ${now() - 1900}, ends_at = ${now() - 5}
  WHERE telegram_id = ${V} AND shinobi = 'Starter Shinobi'`);
const dailyBalance = await balance(V);
assert.equal((await settlePetActivities(V)).length, 1);
const dailyDone = await getDailyMission(V);
assert.equal(dailyDone.progress, 1, 'completion progresses the daily mission');
assert.equal(dailyDone.status, 'completed');
assert.equal(await balance(V), dailyBalance + 750, 'daily reward pays exactly once');
assert.equal((await settlePetActivities(V)).length, 0);
assert.equal(await balance(V), dailyBalance + 750, 'a retried settle cannot pay twice');
assert.equal((await getDailyMission(V)).rewardSettled, 1);

console.log('pet engine integration: OK');
