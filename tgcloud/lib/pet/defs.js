/**
 * Pet System V1 — verified against the Aww pet.py source appendix.
 * Pure constants and deterministic helpers only; no SDK imports.
 */

export const PET_IMAGE_CHAT_ID = -1003889508991;

export const PETS = {
  axofly: {
    id: 'axofly',
    emoji: '🦋',
    name: 'Axofly',
    price: 30000,
    abilityKey: 'flutter_fortune',
    abilityName: 'Flutter Fortune',
    abilityDesc: 'Chance to boost /kill /rob /claim /patrol /mission rewards + mild Shinobi XP.',
    // t.me/c/3889508991/540 — resolved through the storage-channel file_id cache.
    imageMessageId: 540,
    // level -> [trigger chance, base-reward bonus fraction]
    rewardBoost: {
      1: [0.08, 0.10],
      2: [0.12, 0.10],
      3: [0.15, 0.15],
      4: [0.18, 0.20],
      5: [0.22, 0.25],
    },
    // level -> additive Shinobi XP bonus
    shinobiXpBonus: { 1: 0.02, 2: 0.03, 3: 0.04, 4: 0.05, 5: 0.07 },
  },
  capycorn: {
    id: 'capycorn',
    emoji: '🦄',
    name: 'Capycorn',
    price: 40000,
    abilityKey: 'royal_pace',
    abilityName: 'Royal Pace',
    abilityDesc: 'Reduces Mission & Patrol duration and cooldown.',
    // t.me/c/3889508991/541 — resolved through the storage-channel file_id cache.
    imageMessageId: 541,
    // level -> [duration reduction, cooldown reduction]
    timeReduction: {
      1: [0.03, 0.02],
      2: [0.04, 0.03],
      3: [0.05, 0.04],
      4: [0.07, 0.05],
      5: [0.10, 0.07],
    },
  },
};

export const PET_IDS = Object.keys(PETS);
export const PET_BY_NAME = Object.fromEntries(
  Object.values(PETS).map((pet) => [pet.name.toLowerCase(), pet.id]),
);

export const PET_MAX_LEVEL = 5;
export const PET_XP_THRESHOLDS = { 1: 0, 2: 1000, 3: 3000, 4: 7000, 5: 15000 };
export const PET_XP_CAP = 15000;

export const PET_MAX_ENERGY = 100;
export const PET_ENERGY_REGEN_AMOUNT = 10;
export const PET_ENERGY_REGEN_SECONDS = 2 * 3600;
export const REST_ENERGY_REGEN_AMOUNT = 15;
export const REST_ENERGY_REGEN_SECONDS = 3600;

/**
 * Timed activities. Feed is no longer timed (food is instant), but the entry is
 * kept so any feed session started before this update still settles correctly.
 */
export const PET_ACTIVITIES = {
  feed: {
    key: 'feed', emoji: '🍖', label: 'Feed', location: 'bbq',
    durationMinutes: 30, cooldownHours: 6, xp: 50, energyCost: 10, legacy: true,
  },
  play: {
    key: 'play', emoji: '🎾', label: 'Play', location: 'bbq',
    durationMinutes: 30, cooldownHours: 0, xp: 75, energyCost: 15,
    locksShinobi: true, exhausts: true,
  },
  train: {
    key: 'train', emoji: '🏋️', label: 'Train', location: 'training',
    durationMinutes: 120, cooldownHours: 0, xp: 150, energyCost: 30,
    locksShinobi: false, exhausts: true,
  },
  rest: {
    key: 'rest', emoji: '😴', label: 'Rest', location: 'hotsprings',
    durationMinutes: 30, cooldownHours: 0, xp: 0, energyCost: 0,
    locksShinobi: false, requiresExhausted: true, restoresEnergy: true,
  },
};

/** Activities a player can start from the UI. */
export const STARTABLE_ACTIVITIES = ['play', 'train', 'rest'];

export const PET_FOOD_MENU = {
  ninja_meal: { emoji: '🍱', name: 'Ninja Pet Meal', cost: 500, petXp: 100, energy: 10 },
  chakra_treat: { emoji: '🍬', name: 'Chakra Treat', cost: 1000, petXp: 250, energy: 25 },
  feast: { emoji: '🍥', name: 'Ichiraku Feast', cost: 2000, petXp: 500, energy: 50 },
};

export const PET_NAMETAG_KEY = 'pet_nametag';
export const PET_NAMETAG_NAME = 'Pet Nametag';
export const PET_NAMETAG_PRICE = 3000;
export const PET_NAMETAG_MAX_LEN = 24;

export const PET_FEED_FEE = 150;
export const ICHIRAKU_OWNER_CUT_PCT = 100;

export function petLevelForXp(xp) {
  const safe = Math.max(0, Math.min(PET_XP_CAP, Math.trunc(Number(xp) || 0)));
  let level = 1;
  for (let lv = 1; lv <= PET_MAX_LEVEL; lv += 1) {
    if (safe >= PET_XP_THRESHOLDS[lv]) level = lv;
    else break;
  }
  return level;
}

export function petXpForNextLevel(level) {
  if (level >= PET_MAX_LEVEL) return null;
  return PET_XP_THRESHOLDS[level + 1] || null;
}

/**
 * Source-equivalent elapsed-time regeneration. Timestamp is advanced only by
 * whole completed intervals; a full meter resets the clock to now.
 */
export function petRegenEnergy(energy, lastEnergyAt, resting, nowSec) {
  const max = PET_MAX_ENERGY;
  const current = Math.max(0, Math.min(max, Math.trunc(Number(energy) || 0)));
  const now = Math.trunc(Number(nowSec) || 0);
  let last = Math.trunc(Number(lastEnergyAt) || 0);
  if (!last || last > now) last = now;
  const amount = resting ? REST_ENERGY_REGEN_AMOUNT : PET_ENERGY_REGEN_AMOUNT;
  const interval = resting ? REST_ENERGY_REGEN_SECONDS : PET_ENERGY_REGEN_SECONDS;
  const ticks = Math.floor((now - last) / interval);
  if (ticks <= 0) return { energy: current, lastEnergyAt: last, gained: 0 };
  const next = Math.min(max, current + ticks * amount);
  const nextLast = next >= max ? now : last + ticks * interval;
  return { energy: next, lastEnergyAt: nextLast, gained: next - current };
}

/** Deterministic/injectable Axofly roll. Base <= 0 never rolls. */
export function petRewardBonusFor(baseReward, petId, level, random = Math.random()) {
  const base = Math.trunc(Number(baseReward) || 0);
  if (base <= 0 || petId !== 'axofly') return { bonus: 0, triggered: false };
  const data = PETS.axofly.rewardBoost[level];
  if (!data) return { bonus: 0, triggered: false };
  const [chance, fraction] = data;
  if (random >= chance) return { bonus: 0, triggered: false };
  const bonus = Math.max(0, Math.trunc(base * fraction));
  return { bonus, triggered: bonus > 0 };
}

export function petShinobiXpBonusFor(petId, level) {
  if (petId !== 'axofly') return 0;
  return Number(PETS.axofly.shinobiXpBonus[level] || 0);
}

export function petTimeReductionFor(petId, level) {
  if (petId !== 'capycorn') return { durationFrac: 0, cooldownFrac: 0 };
  const data = PETS.capycorn.timeReduction[level];
  if (!data) return { durationFrac: 0, cooldownFrac: 0 };
  return { durationFrac: Number(data[0]), cooldownFrac: Number(data[1]) };
}

/** Source patrol arithmetic: whole minutes, minimum one minute. */
export function reducedActivitySeconds(durationSeconds, reductionFrac) {
  const minutes = Math.max(0, Math.trunc(Number(durationSeconds) || 0) / 60);
  const frac = Math.max(0, Math.min(1, Number(reductionFrac) || 0));
  return Math.max(60, Math.trunc(minutes * (1 - frac)) * 60);
}

export function reducedCooldownSeconds(cooldownSeconds, reductionFrac) {
  const frac = Math.max(0, Math.min(1, Number(reductionFrac) || 0));
  return Math.max(0, Math.floor((Number(cooldownSeconds) || 0) * (1 - frac)));
}

export function sanitizePetName(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function petNameLength(value) {
  return Array.from(sanitizePetName(value)).length;
}
