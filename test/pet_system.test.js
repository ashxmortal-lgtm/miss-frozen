import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  PETS, PET_XP_THRESHOLDS, PET_XP_CAP, PET_MAX_ENERGY,
  PET_ACTIVITIES, PET_FOOD_MENU, PET_NAMETAG_PRICE, PET_NAMETAG_MAX_LEN,
  PET_FEED_FEE, ICHIRAKU_OWNER_CUT_PCT,
  petLevelForXp, petXpForNextLevel, petRegenEnergy, petRewardBonusFor,
  petShinobiXpBonusFor, petTimeReductionFor, reducedActivitySeconds,
  reducedCooldownSeconds, sanitizePetName, petNameLength,
} from '../tgcloud/lib/pet/defs.js';
import { DAILY_TEMPLATES, dailyCycleDate } from '../tgcloud/lib/daily_defs.js';

const read = (path) => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');

test('both pets keep the source prices, abilities and image ids', () => {
  assert.equal(PETS.axofly.price, 30000);
  assert.equal(PETS.capycorn.price, 40000);
  assert.equal(PETS.axofly.abilityName, 'Flutter Fortune');
  assert.equal(PETS.capycorn.abilityName, 'Royal Pace');
  assert.equal(PETS.axofly.imageMessageId, 349);
  assert.equal(PETS.capycorn.imageMessageId, 353);
  assert.deepEqual(Object.keys(PETS), ['axofly', 'capycorn']);
});

test('pet XP thresholds, level cap and next-level helper are exact', () => {
  assert.deepEqual(PET_XP_THRESHOLDS, { 1: 0, 2: 1000, 3: 3000, 4: 7000, 5: 15000 });
  assert.equal(PET_XP_CAP, 15000);
  const cases = [
    [0, 1], [999, 1], [1000, 2], [2999, 2], [3000, 3],
    [6999, 3], [7000, 4], [14999, 4], [15000, 5], [999999, 5],
  ];
  for (const [xp, level] of cases) assert.equal(petLevelForXp(xp), level);
  assert.equal(petXpForNextLevel(1), 1000);
  assert.equal(petXpForNextLevel(4), 15000);
  assert.equal(petXpForNextLevel(5), null);
});

test('energy regeneration: +10 / 2h, +15 / 1h resting, remainder preserved, 100 cap', () => {
  const start = 1_000_000;
  assert.deepEqual(petRegenEnergy(40, start, false, start + 7199), {
    energy: 40, lastEnergyAt: start, gained: 0,
  });
  assert.deepEqual(petRegenEnergy(40, start, false, start + 7200), {
    energy: 50, lastEnergyAt: start + 7200, gained: 10,
  });
  const remainder = petRegenEnergy(40, start, false, start + 7200 * 2 + 600);
  assert.equal(remainder.energy, 60);
  assert.equal(remainder.lastEnergyAt, start + 7200 * 2, 'incomplete interval is kept');
  assert.equal(petRegenEnergy(40, start, true, start + 3600).energy, 55);
  const capped = petRegenEnergy(95, start, false, start + 7200 * 10);
  assert.equal(capped.energy, PET_MAX_ENERGY);
  assert.equal(petRegenEnergy(0, start + 50, false, start).energy, 0, 'future clock never drains');
});

test('Axofly Flutter Fortune rolls per level and never rolls a zero base', () => {
  const expected = {
    1: [0.08, 0.10], 2: [0.12, 0.10], 3: [0.15, 0.15], 4: [0.18, 0.20], 5: [0.22, 0.25],
  };
  for (const [level, [chance, fraction]] of Object.entries(expected)) {
    const hit = petRewardBonusFor(1000, 'axofly', Number(level), chance - 0.0001);
    assert.equal(hit.triggered, true);
    assert.equal(hit.bonus, Math.trunc(1000 * fraction));
    assert.equal(petRewardBonusFor(1000, 'axofly', Number(level), chance).triggered, false);
    assert.equal(petShinobiXpBonusFor('axofly', Number(level)), [0.02, 0.03, 0.04, 0.05, 0.07][level - 1]);
  }
  assert.deepEqual(petRewardBonusFor(0, 'axofly', 5, 0), { bonus: 0, triggered: false });
  assert.deepEqual(petRewardBonusFor(1000, 'capycorn', 5, 0), { bonus: 0, triggered: false });
  assert.deepEqual(petRewardBonusFor(1000, 'axofly', 5, 0.99), { bonus: 0, triggered: false });
});

test('Capycorn Royal Pace reductions match every level and only affect missions', () => {
  const expected = {
    1: [0.03, 0.02], 2: [0.04, 0.03], 3: [0.05, 0.04], 4: [0.07, 0.05], 5: [0.10, 0.07],
  };
  for (const [level, [duration, cooldown]] of Object.entries(expected)) {
    assert.deepEqual(petTimeReductionFor('capycorn', Number(level)), {
      durationFrac: duration, cooldownFrac: cooldown,
    });
  }
  assert.deepEqual(petTimeReductionFor('axofly', 5), { durationFrac: 0, cooldownFrac: 0 });
  assert.equal(reducedActivitySeconds(3 * 3600, 0), 3 * 3600);
  assert.equal(reducedActivitySeconds(3 * 3600, 0.10), 162 * 60, 'whole minutes, floored');
  assert.equal(reducedActivitySeconds(60, 0.99), 60, 'never below one minute');
  assert.equal(reducedCooldownSeconds(6 * 3600, 0.07), Math.floor(21600 * 0.93));
});

test('activity, food, nametag and feed-fee constants are the source values', () => {
  assert.equal(PET_ACTIVITIES.feed.durationMinutes, 30);
  assert.equal(PET_ACTIVITIES.feed.cooldownHours, 6);
  assert.equal(PET_ACTIVITIES.feed.xp, 50);
  assert.equal(PET_ACTIVITIES.feed.energyCost, 10);
  assert.equal(PET_ACTIVITIES.play.durationMinutes, 45);
  assert.equal(PET_ACTIVITIES.play.cooldownHours, 4);
  assert.equal(PET_ACTIVITIES.play.xp, 75);
  assert.equal(PET_ACTIVITIES.play.energyCost, 15);
  assert.equal(PET_ACTIVITIES.train.durationMinutes, 120);
  assert.equal(PET_ACTIVITIES.train.cooldownHours, 8);
  assert.equal(PET_ACTIVITIES.train.xp, 150);
  assert.equal(PET_ACTIVITIES.train.energyCost, 30);
  assert.equal(PET_ACTIVITIES.rest.durationMinutes, null);
  assert.deepEqual(
    Object.values(PET_FOOD_MENU).map((f) => [f.cost, f.petXp]),
    [[500, 100], [1000, 250], [2000, 500]],
  );
  assert.equal(PET_NAMETAG_PRICE, 3000);
  assert.equal(PET_NAMETAG_MAX_LEN, 24);
  assert.equal(PET_FEED_FEE, 150);
  assert.equal(ICHIRAKU_OWNER_CUT_PCT, 100);
});

test('pet names are trimmed, control-free and limited to 24 visible characters', () => {
  assert.equal(sanitizePetName('  Fluffy\n\t Jr  '), 'Fluffy Jr');
  assert.equal(petNameLength('🦋'.repeat(24)), 24);
  assert.equal(petNameLength('a'.repeat(25)), 25);
});

test('daily missions rotate per IST day and cover every pet + gameplay hook', () => {
  assert.equal(dailyCycleDate(Date.UTC(2026, 9, 21, 18, 29)), '2026-10-21');
  assert.equal(dailyCycleDate(Date.UTC(2026, 9, 21, 18, 30)), '2026-10-22');
  const types = new Set(Object.values(DAILY_TEMPLATES).map((t) => t.requirementType));
  for (const type of [
    'kill_success', 'rob_success', 'patrol_complete', 'mission_complete',
    'shinobi_xp', 'pet_feed', 'pet_play', 'pet_train',
  ]) assert.ok(types.has(type), type);
  assert.equal(new Set(Object.values(DAILY_TEMPLATES).map((t) => t.id)).size, Object.keys(DAILY_TEMPLATES).length);
});

test('schema declares pet, property and daily tables with required keys', () => {
  const schema = read('tgcloud/schema.js');
  for (const name of [
    'user_pets', 'equipped_pet', 'pet_activity', 'pet_stats', 'special_inventory',
    'property_ownership', 'property_partnership_requests', 'daily_missions',
  ]) assert.match(schema, new RegExp(`table\\('${name}'`));
  assert.match(schema, /cooldownSec: integer\('cooldown_sec'\)/);
  assert.match(schema, /uidx_daily_missions'\)\.on\(t\.userId, t\.cycleDate\)/);
});

test('pet persistence is duplicate-safe and cooldown starts at completion', () => {
  const store = read('tgcloud/lib/pet/store.js');
  assert.match(store, /INSERT OR IGNORE INTO users/);
  assert.match(store, /balance = balance - \$\{def\.price\}[\s\S]*?balance >= \$\{def\.price\}/);
  assert.match(store, /once\(`pet_buy:/);
  assert.match(store, /if \(cfg\.cooldownHours > 0\) \{[\s\S]*?cooldownUntil = t \+ cfg\.cooldownHours \* 3600/);
  // Settlement claims with the guarded DELETE only: a consumed marker left by a
  // crash between marker and delete could strand the activity forever.
  assert.doesNotMatch(store, /pet_complete:/);
  assert.match(store, /status = 'active' AND started_at = \$\{row\.started_at\}/);
  assert.match(store, /UPDATE special_inventory SET quantity = quantity - 1[\s\S]*?quantity > 0/);
  assert.match(store, /energy = energy - \$\{cfg\.energyCost\}, last_energy_at = \$\{t\}/);
});

test('BBQ feed fee only charges when the group owns the property and refunds on failure', () => {
  const property = read('tgcloud/lib/property.js');
  assert.match(property, /petFeedFee: PET_FEED_FEE/);
  assert.match(property, /getPropertyOwnership\(groupId, 'bbq'\)/);
  assert.match(property, /if \(!ownership\) return \{ code: 'no_property'/);
  assert.match(property, /balance >= \$\{fee\}/);
  assert.match(property, /addPropertyEarnings\(groupId, 'bbq', fee\)/);
  assert.match(property, /reversePropertyEarnings\(groupId, 'bbq', value\)/);
  const ui = read('tgcloud/lib/pet/ui.js');
  assert.match(ui, /if \(chargeFee && cfg\.key === 'feed' && Number\(chatId\) < 0\)/);
  assert.match(ui, /refundPetFeed\(chatId, userId, fee\)/);
});

test('map exposes every pet entry point and the daily quest screen', () => {
  const ui = read('tgcloud/lib/map/ui.js');
  const handler = read('tgcloud/lib/map/handler.js');
  for (const action of [
    'map_pet_feed', 'map_pet_play', 'map_pet_train', 'map_pet_rest',
    'map_pet_store', 'map_pet_menu', 'map_pet_food', 'map_pet_stats',
    'map_pet_start', 'map_pet_stop', 'map_pet_buy', 'map_pet_view',
    'map_prop_store', 'map_prop_buy', 'map_prop_claim',
  ]) assert.match(handler, new RegExp(`'${action}'`), action);
  assert.match(ui, /🐾 Pet Store/);
  assert.match(ui, /♨️ Rest Pet/);
  assert.match(ui, /🍖 Feed Pet/);
  assert.match(ui, /🐾 Train Pet/);
  assert.match(ui, /🍱 Pet Food/);
  assert.match(handler, /ICHIRAKU PET FOOD/);
  assert.doesNotMatch(handler, /Pet rest is not available/);
  assert.match(handler, /ensureDailyMission\(user\.id, chatId\)/);
  assert.match(handler, /dailyMissionBody\(user, mission\)/);
  assert.match(read('tgcloud/handlers/callback_query.js'), /handlePetCallback\(cq\)/);
});

test('gameplay hooks apply Axofly and Capycorn bonuses', () => {
  const activities = read('tgcloud/lib/activities.js');
  assert.match(activities, /petTimeReduction\(id\)/);
  assert.match(activities, /reducedActivitySeconds\(c\.duration, pace\.durationFrac\)/);
  assert.match(activities, /reducedCooldownSeconds\(c\.cooldown, pace\.cooldownFrac\)/);
  assert.match(activities, /petRewardBonus\(id, coins\)/);
  assert.match(activities, /petShinobiXpMultiplier\(id\)/);
  assert.match(activities, /notifyDailyProgress\(id, .*_complete/);
  assert.match(read('tgcloud/lib/economy.js'), /petRewardBonus\(id, coins\)/);
  assert.match(read('tgcloud/lib/economy.js'), /petShinobiXpMultiplier\(id\)/);
  const combat = read('tgcloud/lib/rpg/combat.js');
  assert.match(combat, /petRewardBonus\(attackerId, r\.coins\)/);
  assert.match(combat, /petRewardBonus\(user\.id, steal\)/);
  assert.match(combat, /notifyDailyProgress\(attackerId, 'kill_success'/);
  assert.match(combat, /notifyDailyProgress\(user\.id, 'rob_success'/);
  // Spec §5: pet daily progress is completion-only; the start path never touches it.
  assert.match(read('tgcloud/lib/pet/store.js'), /notifyDailyProgress\([\s\S]*?pet_settle:/);
  assert.doesNotMatch(read('tgcloud/lib/pet/ui.js'), /notifyDailyProgress/);
  // Base kill bounty remains the verified function (tests depend on it).
  const base = combat.slice(combat.indexOf('export async function killTarget'), combat.indexOf('async function applyKillPetBonus'));
  assert.doesNotMatch(base, /petRewardBonus/);
});

test('/pet command is registered and routed', () => {
  const reg = read('tgcloud/lib/command_registry.js');
  for (const cmd of ['/pet', '/pet_store', '/buy_pet', '/equip_pet', '/pet_rename']) {
    assert.match(reg, new RegExp(`cmd: '${cmd}'`), cmd);
  }
  const handler = read('tgcloud/lib/economy_handler.js');
  for (const cmd of ['pet', 'pet_store', 'buy_pet', 'equip_pet', 'pet_rename']) {
    assert.match(handler, new RegExp(`cmd === '${cmd}'`), cmd);
  }
  assert.match(handler, /handlePetCommand/);
  assert.match(read('tgcloud/lib/pet/ui.js'), /'\/pet', '\/pet_store', '\/buy_pet', '\/equip_pet', '\/pet_rename'/);
  const ui = read('tgcloud/lib/pet/ui.js');
  for (const sub of ['name', 'buy', 'feed', 'play', 'train', 'rest', 'stats', 'store']) {
    assert.match(ui, new RegExp(`sub === '${sub}'`), sub);
  }
});

test('every pet callback is routed and every map pet callback ends with the owner id', () => {
  const ui = read('tgcloud/lib/pet/ui.js');
  const handler = read('tgcloud/lib/map/handler.js');
  const actions = new Set();
  for (const m of ui.matchAll(/`(map_pet_[a-z_]+):/g)) actions.add(m[1]);
  for (const action of actions) {
    assert.match(handler, new RegExp(`action === '${action}'|action === '${action.replace('map_', '')}'`), action);
  }
  // Owner guard in the map router uses the last callback segment.
  for (const m of ui.matchAll(/`(map_pet_[a-z_]+):([^`]*)`/g)) {
    const [, action, rest] = m;
    if (action === 'map_pet_store' || action === 'map_pet_menu' || action === 'map_pet_food'
      || action === 'map_pet_stats' || action === 'map_pet_feed' || action === 'map_pet_play'
      || action === 'map_pet_train' || action === 'map_pet_rest') continue;
    if (action === 'map_pet_start' || action === 'map_pet_noop') {
      // Source shape: the owner id comes right after the action.
      assert.match(rest, /^(userId|user\.id|\$\{userId\})(:|$)/, `${action} must start with the owner id`);
      continue;
    }
    assert.match(rest, /(userId|user\.id)\}$/, `${action} must end with the owner id`);
  }
  const petActions = new Set();
  for (const m of ui.matchAll(/`(pet_[a-z_]+):/g)) petActions.add(m[1]);
  for (const action of petActions) {
    assert.match(ui, new RegExp(`action === '${action}'`), action);
  }
});

test('only the equipped pet can take activities and feed needs an owned BBQ', () => {
  const store = read('tgcloud/lib/pet/store.js');
  assert.match(store, /if \(!pet\.equipped\) return \{ code: 'not_equipped' \}/);
  assert.match(store, /const reason = await shinobiAvailability\(userId, shinobi\)/);
  assert.match(store, /if \(reason === 'pet_busy'\) return \{ code: 'shinobi_busy'/);
  assert.match(store, /INSERT OR IGNORE INTO pet_activity/);
  assert.match(read('tgcloud/schema.js'), /feedCooldownUntil: integer\('feed_cooldown_until'\)/);
  assert.match(store, /feed_cooldown_until = \$\{cooldownUntil\}/);
  assert.match(store, /play_cooldown_until = \$\{cooldownUntil\}/);
  assert.match(store, /train_cooldown_until = \$\{cooldownUntil\}/);
  const ui = read('tgcloud/lib/pet/ui.js');
  assert.match(ui, /if \(charge\.code === 'no_property'\) return \{ code: 'no_property', fee: charge\.fee \}/);
  assert.match(ui, /await refundPetFeed\(chatId, userId, fee\)/);
  assert.match(read('tgcloud/lib/map/handler.js'), /performPetStart\(user\.id, type, shinobi, chatId, loc, true\)/);
});
