import { test } from 'node:test';
import assert from 'node:assert/strict';

test('Daily streak calculation and rollover', () => {
  function computeStreak(prevStreak, daysDiff) {
    if (daysDiff === 1) return (prevStreak % 7) + 1;
    if (daysDiff > 1) return 1;
    return prevStreak; // same day, already claimed
  }

  // Consecutive day claims
  assert.equal(computeStreak(1, 1), 2);
  assert.equal(computeStreak(6, 1), 7);
  assert.equal(computeStreak(7, 1), 1, 'Day 7 resets to Day 1 on day 8');

  // Broken streak
  assert.equal(computeStreak(5, 2), 1, 'Missed day resets streak to 1');
  assert.equal(computeStreak(7, 3), 1, 'Missed day resets streak to 1');
});

test('Daily claim reward amounts', () => {
  const DAILY_COINS = 50;
  const DAILY_CHAKRA = 20;
  const BONUS_COINS = 250;
  const BONUS_CHAKRA = 100;

  function calculateReward(streak) {
    const isDay7 = streak === 7;
    return {
      coins: DAILY_COINS + (isDay7 ? BONUS_COINS : 0),
      chakra: DAILY_CHAKRA + (isDay7 ? BONUS_CHAKRA : 0),
      isDay7,
    };
  }

  const day1 = calculateReward(1);
  assert.equal(day1.coins, 50);
  assert.equal(day1.chakra, 20);
  assert.equal(day1.isDay7, false);

  const day7 = calculateReward(7);
  assert.equal(day7.coins, 300);
  assert.equal(day7.chakra, 120);
  assert.equal(day7.isDay7, true);
});
