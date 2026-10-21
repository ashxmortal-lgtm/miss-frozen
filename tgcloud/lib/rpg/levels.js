/**
 * Frozen Blooded progression tables — pure data + pure functions only
 * (unit-testable without the database).
 */

// Itachi: [kills required, rob %, title]. Max level 5.
// Counted from users.kills — only successful kills increment that counter.
export const ITACHI_LEVELS = [
  { level: 1, kills: 0, robPct: 20, title: 'anbu itachi' },
  { level: 2, kills: 25, robPct: 30, title: 'sharingan itachi' },
  { level: 3, kills: 75, robPct: 40, title: 'mangekyō itachi' },
  { level: 4, kills: 150, robPct: 55, title: 'akatsuki itachi' },
  { level: 5, kills: 300, robPct: 70, title: 'uchiha prodigy' },
];

/** Itachi level (1–5) for a successful-kill count. */
export function itachiLevelOf(kills) {
  let lv = 0;
  for (let i = 0; i < ITACHI_LEVELS.length; i++) {
    if (kills >= ITACHI_LEVELS[i].kills) lv = i;
  }
  return lv + 1;
}

/** Rob percentage (20–70) for the attacker's Itachi level. */
export function itachiRobPct(kills) {
  return ITACHI_LEVELS[itachiLevelOf(kills) - 1].robPct;
}

// Naruto: Shadow Clone activation window by Naruto level. Max level 4.
export const NARUTO_CLONE_WINDOW = { 1: 5, 2: 10, 3: 30, 4: 60 };
export function cloneWindowSec(narutoLevel) {
  return NARUTO_CLONE_WINDOW[Math.min(4, Math.max(1, narutoLevel))] || 5;
}

// Sakura: /claim boost by Sakura level. Max level 4.
export const SAKURA_CLAIM_BONUS = {
  1: { coins: 100, chakra: 50 },
  2: { coins: 150, chakra: 80 },
  3: { coins: 300, chakra: 100 },
  4: { coins: 500, chakra: 120 },
};
export function sakuraClaimBonus(sakuraLevel) {
  return SAKURA_CLAIM_BONUS[Math.min(4, Math.max(1, sakuraLevel))] || SAKURA_CLAIM_BONUS[1];
}

// Sakura: patrol/mission bonus by Sakura level — a random amount inside the
// range (inclusive). Separate from the /claim boost above.
export const SAKURA_ACTIVITY_BONUS = {
  1: { min: 100, max: 200 },
  2: { min: 200, max: 350 },
  3: { min: 400, max: 550 },
  4: { min: 500, max: 700 },
};
export function sakuraActivityRange(sakuraLevel) {
  return SAKURA_ACTIVITY_BONUS[Math.min(4, Math.max(1, sakuraLevel))] || SAKURA_ACTIVITY_BONUS[1];
}
/** Random patrol/mission bonus for a Sakura level. `random` is injectable for tests. */
export function sakuraActivityBonus(sakuraLevel, random = Math.random()) {
  const { min, max } = sakuraActivityRange(sakuraLevel);
  return min + Math.floor(random * (max - min + 1));
}

// Itachi kill bounty — existing ability copy: "/kill → 🍥 50–300".
export const KILL_COINS_MIN = 50;
export const KILL_COINS_MAX = 300;

// Death lasts 24 hours, then the target revives automatically.
export const DEATH_DURATION_SEC = 24 * 3600;
// A robbed target can't be robbed again for 24 hours.
export const ROB_LOCKOUT_SEC = 24 * 3600;
// Jiraiya protection duration.
export const PROTECT_DURATION_SEC = 24 * 3600;
// Sakura's Healing / Katsuyu's Healing / Byakugan cooldowns.
export const HEAL_COOLDOWN_SEC = 24 * 3600;
export const BYAKUGAN_COOLDOWN_SEC = 24 * 3600;
// Katsuyu's Healing unlocks after this many successful Sakura Healing uses.
export const KATSUYU_UNLOCK_USES = 3;
export const KATSUYU_CHAKRA = 200;
// Katsuyu protection granted automatically on Katsuyu revival.
export const KATSUYU_PROTECT_SEC = 24 * 3600;

// Exhaustion: after N consecutive patrols the shinobi needs this long to recover.
export const PATROLS_BEFORE_EXHAUSTION = 2;
export const EXHAUSTION_RECOVERY_SEC = 30 * 60;

// Tsunade search: 6-hour sessions, max 2 starts per IST day, costs chakra.
export const SEARCH_DURATION_SEC = 6 * 3600;
export const SEARCH_CHAKRA_COST = 600;
export const SEARCH_MAX_PER_DAY = 2;
// A discovery is guaranteed by the 10th completed search.
export const SEARCH_MAX_ATTEMPTS = 10;

// Training: one session per day per shinobi; next slot is tomorrow 09:00 IST.
export const TRAIN_DAY_INTERVAL_SEC = 24 * 3600;
/**
 * Next training slot: 24h after the current session, floored/rounded to the
 * next 09:00 IST when the 24h mark lands mid-day — kept simple: +24h exactly.
 * (Existing training UI shows the exact persisted timestamp.)
 */
export function nextTrainSlot(nowSec) {
  return nowSec + TRAIN_DAY_INTERVAL_SEC;
}

// Sakura needs two successful sessions per level-up (six total for lv 1→4).
export const SAKURA_SESSIONS_PER_LEVEL = 2;
// Naruto (trained by Jiraiya) levels up the same way: two sessions per level.
// Each level lengthens the Shadow Clone window (5 → 10 → 30 → 60 sec).
export const NARUTO_SESSIONS_PER_LEVEL = 2;
export const SAKURA_MAX_LEVEL = 4;
export const NARUTO_MAX_LEVEL = 4;
export const ITACHI_MAX_LEVEL = 5;

/**
 * Discovery roll for Tsunade — mirrors the existing Jiraiya formula
 * (activities.jiraiyaFound): escalating odds, guaranteed by attempt 10.
 * `n` = completed searches counted after this one (1-based).
 */
export function tsunadeFound(n, random = Math.random()) {
  if (n >= SEARCH_MAX_ATTEMPTS) return true;
  const remaining = Math.max(1, SEARCH_MAX_ATTEMPTS - n + 1);
  return random < n / (n + remaining);
}

// Jiraiya discovery on Naruto patrols: random with escalating odds, and
// guaranteed by the 15th completed Naruto patrol.
export const JIRAIYA_MAX_PATROLS = 15;
/**
 * `n` = completed Naruto patrols counted after this one (1-based).
 * Odds = n / (n + remaining), where remaining shrinks to 1 at patrol 15.
 */
export function jiraiyaFound(n, random = Math.random()) {
  if (n >= JIRAIYA_MAX_PATROLS) return true;
  const remaining = Math.max(1, JIRAIYA_MAX_PATROLS - n + 1);
  return random < n / (n + remaining);
}
