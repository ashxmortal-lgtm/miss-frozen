import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  PETS, PET_IMAGE_CHAT_ID, PET_XP_THRESHOLDS, PET_XP_CAP, PET_MAX_ENERGY,
  PET_ACTIVITIES, STARTABLE_ACTIVITIES, PET_FOOD_MENU, PET_NAMETAG_PRICE,
  PET_NAMETAG_MAX_LEN, PET_FEED_FEE, ICHIRAKU_OWNER_CUT_PCT,
  petLevelForXp, petXpForNextLevel, petRegenEnergy, petRewardBonusFor,
  petShinobiXpBonusFor, petTimeReductionFor, reducedActivitySeconds,
  reducedCooldownSeconds, sanitizePetName, petNameLength,
} from '../tgcloud/lib/pet/defs.js';
import { DAILY_TEMPLATES, dailyCycleDate } from '../tgcloud/lib/daily_defs.js';

const read = (path) => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');

test('both pets keep the source prices, abilities and storage photo ids', () => {
  assert.equal(PETS.axofly.price, 30000);
  assert.equal(PETS.capycorn.price, 40000);
  assert.equal(PETS.axofly.abilityName, 'Flutter Fortune');
  assert.equal(PETS.capycorn.abilityName, 'Royal Pace');
  // t.me/c/3889508991/540 and /541 — private message links resolved via the
  // storage-channel file_id cache, never passed to sendPhoto as URLs.
  assert.equal(PETS.axofly.imageMessageId, 540);
  assert.equal(PETS.capycorn.imageMessageId, 541);
  assert.equal(PET_IMAGE_CHAT_ID, -1003889508991);
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

test('activity durations match the session spec and food is instant', () => {
  // Play 30 minutes, Train 2 hours, Rest 30 minutes. Feed is no longer timed.
  assert.equal(PET_ACTIVITIES.play.durationMinutes, 30);
  assert.equal(PET_ACTIVITIES.play.xp, 75);
  assert.equal(PET_ACTIVITIES.play.energyCost, 15);
  assert.equal(PET_ACTIVITIES.play.locksShinobi, true);
  assert.equal(PET_ACTIVITIES.play.exhausts, true);
  assert.equal(PET_ACTIVITIES.train.durationMinutes, 120);
  assert.equal(PET_ACTIVITIES.train.xp, 150);
  assert.equal(PET_ACTIVITIES.train.energyCost, 30);
  assert.equal(PET_ACTIVITIES.train.locksShinobi, false);
  assert.equal(PET_ACTIVITIES.train.exhausts, true);
  assert.equal(PET_ACTIVITIES.rest.durationMinutes, 30);
  assert.equal(PET_ACTIVITIES.rest.xp, 0, 'rest never pays XP');
  assert.equal(PET_ACTIVITIES.rest.requiresExhausted, true);
  assert.equal(PET_ACTIVITIES.rest.restoresEnergy, true);
  assert.deepEqual(STARTABLE_ACTIVITIES, ['play', 'train', 'rest']);
  assert.deepEqual(
    Object.values(PET_FOOD_MENU).map((f) => [f.cost, f.petXp, f.energy]),
    [[500, 100, 10], [1000, 250, 25], [2000, 500, 50]],
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

test('pet food purchases pay the Ichiraku owners; BBQ fee helpers stay intact', () => {
  const property = read('tgcloud/lib/property.js');
  assert.match(property, /petFeedFee: PET_FEED_FEE/);
  assert.match(property, /getPropertyOwnership\(groupId, 'bbq'\)/);
  assert.match(property, /if \(!ownership\) return \{ code: 'no_property'/);
  assert.match(property, /balance >= \$\{fee\}/);
  assert.match(property, /addPropertyEarnings\(groupId, 'bbq', fee\)/);
  assert.match(property, /reversePropertyEarnings\(groupId, 'bbq', value\)/);
  const store = read('tgcloud/lib/pet/store.js');
  assert.match(store, /creditIchirakuOwners\(chatId, def\.cost\)/);
});

test('/buy and /equip serve both catalogues with multi-word names', () => {
  const buy = read('tgcloud/lib/buy.js');
  // "pet" prefix is optional and the rest of the words form the name.
  assert.match(buy, /if \(String\(rest\[0\] \|\| ''\)\.toLowerCase\(\) === 'pet'\) rest\.shift\(\);/);
  assert.match(buy, /const key = rest\.join\(' '\)\.trim\(\)\.toLowerCase\(\);/);
  // A pet match buys a pet; everything else falls through to the shinobi/jutsu
  // catalogue with the full multi-word name.
  assert.match(buy, /const pet = findPet\(args\);/);
  assert.match(buy, /const item = findItem\(args\.join\(' '\)\);/);
  assert.match(buy, /if \(!item\) \{\n      return ITEM_NOT_FOUND_TEXT;/);
  // Duplicate taps stay silent, ownership and balance errors have dialogues.
  assert.match(buy, /if \(r\.code === 'duplicate'\) return null;/);
  assert.match(buy, /if \(r\.code === 'already_owned'\) return alreadyOwnedText\(pet\.name\);/);
  assert.match(buy, /insufficientCoinsText\(fmt\(r\.price \?\? pet\.price\), fmt\(r\.balance \?\? 0\)\)/);

  const eq = read('tgcloud/lib/economy_handler.js');
  // Pets are checked before shinobi; the shinobi path is untouched.
  assert.ok(eq.indexOf('const petDef = Object.values(PETS).find(') < eq.indexOf('const r = await equipShinobi(message.from.id, args);'));
  assert.match(eq, /const r = await equipPet\(message\.from\.id, petDef\.id\);/);
  assert.match(eq, /equipSuccessText\(petDef\.name\)/);
  assert.match(eq, /notOwnedText\(petDef\.name\)/);
  assert.match(eq, /Max 3 shinobi equipped/);
});

test('/inventory shows live pet status and the Gate shows no pet activity', () => {
  const inv = read('tgcloud/lib/inventory.js');
  assert.match(inv, /await listPets\(uid\)/);
  assert.match(inv, /statusInline\(pet\.status, pet\.statusEndsAt\)/);

  // Spec: the Village Gate must not surface pet activity.
  const gate = read('tgcloud/lib/map/handler.js');
  const gateBody = gate.slice(gate.indexOf('async function gateBody'), gate.indexOf('// --- Training Ground'));
  assert.doesNotMatch(gateBody, /listPets/);
  assert.doesNotMatch(gateBody, /petStatusText/);
  assert.doesNotMatch(gateBody, /pets/i);

  const status = read('tgcloud/lib/rpg/status.js');
  assert.match(status, /LEFT JOIN user_pets up ON up\.telegram_id = pa\.telegram_id AND up\.pet_id = pa\.pet_id/);
  assert.match(status, /`Playing with \$\{petLabel\}`/);
  assert.match(status, /due: dueText\(act\.ends_at, t\)/);

  // Status vocabulary used by both screens.
  const text = read('tgcloud/lib/pet/text.js');
  for (const label of ['🟢 ʀᴇᴀᴅʏ', '🎾 ᴘʟᴀʏɪɴɢ', '🏋️ ᴛʀᴀɪɴɪɴɢ', '😴 ʀᴇꜱᴛɪɴɢ', '⚠️ ᴇxʜᴀᴜꜱᴛᴇᴅ']) {
    assert.ok(text.includes(label), label);
  }
});

test('patrols, missions and shinobi training reject a shinobi locked in Play', () => {
  const activities = read('tgcloud/lib/activities.js');
  assert.match(activities, /if \(row\.kind === 'pet'\) return \{ status: 'busy_pet', shinobi, until: row\.ends_at \};/);
  const training = read('tgcloud/lib/rpg/training.js');
  assert.match(training, /if \(busy && busy\.status === 'active' && Number\(busy\.ends_at \|\| 0\) > t\) \{/);
  assert.match(training, /return \{ code: 'busy', shinobi, kind: busy\.kind, until: busy\.ends_at \};/);
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
  // BBQ: join / feed · instant recovery · play / back
  assert.match(ui, /Join BBQ/);
  assert.match(ui, /Feed pet/);
  assert.match(ui, /Instant shinobi recovery/);
  assert.match(ui, /Play with pet/);
  // Hot Springs: relax / rest · recall / back
  assert.match(ui, /Relax shinobis/);
  assert.match(ui, /Rest pet/);
  assert.match(ui, /Recall shinobis/);
  // Ramen shop entry + the pet-food caption live in the handler.
  assert.match(ui, /🍱 Pet Food/);
  assert.match(handler, /petFoodCaptionHtml\(\)/);
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
  for (const cmd of ['/pet', '/pet_store', '/pet_rename']) {
    assert.match(reg, new RegExp(`cmd: '${cmd}'`), cmd);
  }
  // The standalone pet commands are gone: /buy and /equip serve both catalogs.
  assert.doesNotMatch(reg, /'\/buy_pet'|'\/equip_pet'/);
  const handler = read('tgcloud/lib/economy_handler.js');
  for (const cmd of ['pet', 'pet_store', 'pet_rename']) {
    assert.match(handler, new RegExp(`cmd === '${cmd}'`), cmd);
  }
  assert.doesNotMatch(handler, /buy_pet|equip_pet/);
  assert.match(handler, /petDef = Object\.values\(PETS\)/);
  assert.match(read('tgcloud/lib/buy.js'), /buyPet\(user\.id, pet\.id/);
  assert.match(handler, /handlePetCommand/);
  assert.match(read('tgcloud/lib/pet/ui.js'), /'\/pet', '\/pet_store', '\/pet_rename'/);
  const ui = read('tgcloud/lib/pet/ui.js');
  for (const sub of ['name', 'buy', 'feed', 'play', 'train', 'rest', 'stats', 'store']) {
    assert.match(ui, new RegExp(`sub === '${sub}'`), sub);
  }
});

test('every pet callback is routed with a server-side owner and pet guard', () => {
  const ui = read('tgcloud/lib/pet/ui.js');
  const handler = read('tgcloud/lib/map/handler.js');

  // Every map_pet_* action the UI emits has a handler branch.
  // The card path is `pet_*`; only the map picker/back/food emit `map_pet_*`.
  const actions = new Set();
  for (const m of ui.matchAll(/`(map_pet_[a-z_]+):/g)) actions.add(m[1]);
  assert.ok(actions.size >= 5, `map pet actions are wired (${[...actions].join(', ')})`);
  for (const action of actions) {
    assert.match(handler, new RegExp(`action === '${action}'`), action);
  }

  // Every pet_* action the UI emits is routed in the pet callback router.
  const petActions = new Set();
  for (const m of ui.matchAll(/`(pet_[a-z_]+):/g)) petActions.add(m[1]);
  for (const action of petActions) {
    assert.match(ui, new RegExp(`action === '${action}'`), action);
  }

  // Owner guard runs before any row lookup.
  assert.match(ui, /const ownerId = Number\(parts\[1\]\) \|\| 0;/);
  assert.match(ui, /if \(ownerId !== userId\) \{ await answer\(cb, WRONG_OWNER_TEXT, true\); return true; \}/);
  // Every pet id taken from a callback is re-read from the caller's own rows.
  assert.match(ui, /async function ownedPet\(userId, petId\)/);
  assert.match(ui, /return getPet\(userId, String\(petId\)\.toLowerCase\(\)\)/);
  // Map callbacks: owner is the second segment for uid-first shapes and the
  // last segment for pet-first shapes; both are parsed by parseCb.
  assert.match(handler, /if \(action\.startsWith\('map_pet_'\) && \/\^\\d\+\$\/\.test\(parts\[1\] \|\| ''\)\) ownerId = Number\(parts\[1\]\)/);
  // Stale / malformed callbacks answer instead of throwing.
  assert.match(ui, /await answer\(cb, STALE_MENU_TEXT, true\);/);
  assert.match(ui, /await answer\(cb, UNEXPECTED_ERROR_TEXT, true\);/);
});

test('only the equipped pet can take activities and every session is guarded', () => {
  const store = read('tgcloud/lib/pet/store.js');
  assert.match(store, /if \(!pet\.equipped\) return \{ code: 'not_equipped' \}/);
  assert.match(store, /const reason = await shinobiAvailability\(userId, shinobi\)/);
  assert.match(store, /if \(reason === 'pet_busy'\)/);
  assert.match(store, /INSERT OR IGNORE INTO pet_activity/);
  assert.match(store, /if \(won\.rowsAffected === 0\) continue;/, 'guarded delete is the completion claim');
  assert.match(read('tgcloud/schema.js'), /feedCooldownUntil: integer\('feed_cooldown_until'\)/);
  assert.match(read('tgcloud/schema.js'), /exhausted: integer\('exhausted'\)/);
  assert.match(read('tgcloud/schema.js'), /partnerPet: text\('partner_pet'\)/);
  assert.match(store, /exhausted = 1/);
  assert.match(store, /exhausted = 0/);
  assert.match(read('tgcloud/lib/map/handler.js'), /performPetStart\(user\.id, petId, 'train'/);
});
