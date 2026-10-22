import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { itachiKillReward, itachiRobPct } from '../tgcloud/lib/rpg/levels.js';

const cases = [[0, 24, 100, 120], [25, 74, 120, 180], [75, 149, 150, 200], [150, 299, 200, 250], [300, 9999, 250, 300]];
test('kill rewards use inclusive ranges at every Itachi level boundary', () => {
  for (const [first, last, min, max] of cases) {
    for (const kills of [first, last]) {
      assert.equal(itachiKillReward(kills, 0), min);
      assert.equal(itachiKillReward(kills, 1 - Number.EPSILON), max);
      for (let i = 0; i < 100; i++) {
        const coins = itachiKillReward(kills, i / 100);
        assert.ok(Number.isInteger(coins) && coins >= min && coins <= max);
      }
    }
  }
});

test('robbery percentages remain unchanged', () => {
  assert.deepEqual([0, 25, 75, 150, 300].map(itachiRobPct), [20, 30, 40, 55, 70]);
});

function combat({ kills = 24, dead = false, wins = true } = {}) {
  const source = fs.readFileSync(new URL('../tgcloud/lib/rpg/combat.js', import.meta.url), 'utf8');
  const fn = source.slice(source.indexOf('export async function killTarget'), source.indexOf('function killResultText')).replace('export ', '');
  const updates = [];
  const db = {
    run: async (query) => { if (query.text.includes('UPDATE users')) updates.push(query.values); },
    get: async () => ({ kills }),
  };
  const sql = (strings, ...values) => ({ text: strings.join('?'), values });
  const killTarget = new Function('db', 'sql', 'ensureShinobiState', 'getShinobiState', 'isDead', 'now', 'markDead', 'itachiKillReward',
    `${fn}; return killTarget;`)(db, sql, async () => {}, async () => ({ deadUntil: 123 }), () => dead,
    () => 1, async () => ({ ok: wins, until: 123 }), (count) => itachiKillReward(count, 0));
  return { killTarget, updates };
}

test('successful kill pays according to pre-kill level and increments kills with coins', async () => {
  for (const [kills, , min] of cases) {
    const { killTarget, updates } = combat({ kills });
    const result = await killTarget(1, 2, 'Sasuke');
    assert.equal(result.code, 'ok');
    assert.equal(result.coins, min);
    assert.deepEqual(updates, [[min, 1]]);
  }
});

test('starter, already-dead targets, and lost death races receive no reward', async () => {
  for (const [options, target] of [[{}, 'Starter Shinobi'], [{ dead: true }, 'Sasuke'], [{ wins: false }, 'Sasuke']]) {
    const { killTarget, updates } = combat(options);
    assert.equal((await killTarget(1, 2, target)).code, 'already_dead');
    assert.equal(updates.length, 0);
  }
});
