/** Pure daily-mission definitions — safe to import without the SDK. */

const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

export function dailyCycleDate(nowMs = Date.now()) {
  return new Date(nowMs + IST_OFFSET_MS).toISOString().slice(0, 10);
}

export const DAILY_DIFFICULTY = {
  easy: '🟢 Easy', medium: '🟡 Medium', hard: '🔴 Hard',
};

export const DAILY_TEMPLATES = {
  bounty_hunter: {
    id: 'bounty_hunter', name: 'Bounty Hunter', emoji: '🗡️', difficulty: 'hard',
    description: 'Successfully eliminate 1 player.',
    hint: 'Reply to a player with /kill (Itachi must be equipped).',
    rewardCoins: 2500, requirementType: 'kill_success', targetCount: 1,
  },
  rogue_shinobi: {
    id: 'rogue_shinobi', name: 'Rogue Shinobi', emoji: '💰', difficulty: 'medium',
    description: 'Successfully /rob 1 player.',
    hint: 'Reply to a player with /rob (Itachi must be equipped).',
    rewardCoins: 1500, requirementType: 'rob_success', targetCount: 1,
  },
  patrol_duty: {
    id: 'patrol_duty', name: 'Patrol Duty', emoji: '🏃', difficulty: 'easy',
    description: 'Complete 1 Patrol.',
    hint: 'Send a Shinobi on patrol from the Village Gate or /patrol.',
    rewardCoins: 750, requirementType: 'patrol_complete', targetCount: 1,
  },
  mission_duty: {
    id: 'mission_duty', name: 'Mission Duty', emoji: '⚔️', difficulty: 'medium',
    description: 'Complete 1 normal Shinobi Mission.',
    hint: 'Dispatch a mission-capable Shinobi from Hokage Office or /mission.',
    rewardCoins: 1000, requirementType: 'mission_complete', targetCount: 1,
  },
  shinobi_training: {
    id: 'shinobi_training', name: 'Shinobi Training', emoji: '🏋️', difficulty: 'medium',
    description: 'Gain Shinobi EXP through an eligible activity.',
    hint: 'Earn XP from /claim, patrol, mission, or other Shinobi activities.',
    rewardCoins: 1500, requirementType: 'shinobi_xp', targetCount: 1,
  },
  feed_companion: {
    id: 'feed_companion', name: 'Feed Your Companion', emoji: '🍖', difficulty: 'easy',
    description: 'Successfully Feed an eligible pet.',
    hint: 'Feed your pet at the BBQ on the map.',
    rewardCoins: 750, requirementType: 'pet_feed', targetCount: 1,
  },
  playtime: {
    id: 'playtime', name: 'Playtime', emoji: '🎾', difficulty: 'easy',
    description: 'Successfully Play with an eligible pet.',
    hint: 'Play with your pet at the BBQ on the map.',
    rewardCoins: 750, requirementType: 'pet_play', targetCount: 1,
  },
  pet_training: {
    id: 'pet_training', name: 'Pet Training', emoji: '🐾', difficulty: 'medium',
    description: 'Successfully Train an eligible pet.',
    hint: 'Train your pet at the Training Ground.',
    rewardCoins: 1500, requirementType: 'pet_train', targetCount: 1,
  },
};
