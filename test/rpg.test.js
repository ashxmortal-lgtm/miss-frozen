import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  istDateTime, istHm, inRemaining, isToday, dueText,
} from '../tgcloud/lib/rpg/time.js';
import {
  ITACHI_LEVELS, itachiLevelOf, itachiRobPct, cloneWindowSec, sakuraClaimBonus,
  tsunadeFound, PATROLS_BEFORE_EXHAUSTION, EXHAUSTION_RECOVERY_SEC,
  SEARCH_MAX_ATTEMPTS, DEATH_DURATION_SEC,
} from '../tgcloud/lib/rpg/levels.js';

// Fixed reference instants (unix seconds).
// 2026-10-18T13:15:00Z = 18:45 IST; 2026-10-19T02:30:00Z = 08:00 IST next day.
const T1 = Math.floor(Date.UTC(2026, 9, 18, 13, 15, 0) / 1000);
const T2 = Math.floor(Date.UTC(2026, 9, 19, 2, 30, 0) / 1000);

test('IST formatting: 13:15 UTC is 18:45 IST', () => {
  assert.equal(istHm(T1), '18:45');
  assert.equal(istDateTime(T1), '18 Oct, 18:45 IST');
});

test('IST formatting crosses the date line correctly', () => {
  assert.equal(istDateTime(T2), '19 Oct, 08:00 IST');
});

test('inRemaining formats hours, minutes and seconds', () => {
  assert.equal(inRemaining(T1 + 18 * 60 + 24, T1), 'in 18m 24s');
  assert.equal(inRemaining(T1 + 3600, T1), 'in 1h 00m');
  assert.equal(inRemaining(T1 + 2 * 86400 + 3 * 3600, T1), 'in 2d 3h');
  assert.equal(inRemaining(T1, T1 + 60), 'in 0s');
});

test('isToday / dueText use IST day boundaries and add remaining time', () => {
  const sameDay = T1 + 30 * 60; // still 18 Oct IST (19:15), 30m in the future
  assert.equal(isToday(sameDay, T1), true);
  assert.equal(isToday(T2, T1), false);
  assert.equal(dueText(sameDay, T1), '19:15 IST (in 30m 00s)');
  assert.equal(dueText(T1 - 30 * 60, T1), '18:15 IST', 'past times show no countdown');
  assert.match(dueText(T2, T1), /^19 Oct, 08:00 IST \(in/);
});

test('Itachi progression table matches the spec', () => {
  assert.deepEqual(ITACHI_LEVELS.map((l) => [l.kills, l.robPct]), [
    [0, 20], [25, 30], [75, 40], [150, 55], [300, 70],
  ]);
  assert.equal(itachiLevelOf(0), 1);
  assert.equal(itachiLevelOf(24), 1);
  assert.equal(itachiLevelOf(25), 2);
  assert.equal(itachiLevelOf(74), 2);
  assert.equal(itachiLevelOf(300), 5);
  assert.equal(itachiLevelOf(9999), 5, 'level 5 is the cap');
  assert.equal(itachiRobPct(0), 20);
  assert.equal(itachiRobPct(300), 70);
});

test('Naruto clone window grows with level (5/10/30/60s)', () => {
  assert.equal(cloneWindowSec(1), 5);
  assert.equal(cloneWindowSec(2), 10);
  assert.equal(cloneWindowSec(3), 30);
  assert.equal(cloneWindowSec(4), 60);
  assert.equal(cloneWindowSec(99), 60, 'level 4 is the cap');
});

test('Sakura claim bonus per level', () => {
  assert.deepEqual(sakuraClaimBonus(1), { coins: 100, chakra: 50 });
  assert.deepEqual(sakuraClaimBonus(2), { coins: 150, chakra: 80 });
  assert.deepEqual(sakuraClaimBonus(3), { coins: 300, chakra: 100 });
  assert.deepEqual(sakuraClaimBonus(4), { coins: 500, chakra: 120 });
  assert.deepEqual(sakuraClaimBonus(9), { coins: 500, chakra: 120 }, 'level 4 is the cap');
});

test('Tsunade discovery: guaranteed by the 10th search, random before', () => {
  assert.equal(tsunadeFound(10, 0.999), true, 'guaranteed at attempt 10');
  assert.equal(tsunadeFound(15, 0.999), true);
  assert.equal(tsunadeFound(1, 0.999), false, 'avoided at attempt 1 with high roll');
  assert.equal(tsunadeFound(1, 0.001), true, 'early discovery possible');
  // Odds escalate: attempt 5 succeeds on ~50% (5/(5+6)) — check the threshold.
  assert.equal(tsunadeFound(5, 0.45), true);
  assert.equal(tsunadeFound(5, 0.55), false);
});

test('exhaustion and death constants match the spec', () => {
  assert.equal(PATROLS_BEFORE_EXHAUSTION, 2);
  assert.equal(EXHAUSTION_RECOVERY_SEC, 30 * 60);
  assert.equal(DEATH_DURATION_SEC, 24 * 3600);
  assert.equal(SEARCH_MAX_ATTEMPTS, 10);
});
