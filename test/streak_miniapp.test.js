import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

function loadStreak() {
  const sandbox = {};
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read('web', 'js', 'streak.js'), sandbox, { filename: 'web/js/streak.js' });
  return sandbox.FBStreak;
}

test('Mini App streak view follows the bot rules for every day state', () => {
  const S = loadStreak();
  assert.ok(S && typeof S.view === 'function', 'FBStreak is exported');

  // Consecutive day: streak 3 yesterday means day 4 is claimable today.
  const ready = S.view({ streak: 3, lastClaim: '2026-10-23', today: '2026-10-24' });
  assert.equal(ready.claimedToday, false);
  assert.equal(ready.nextDay, 4);
  assert.equal(ready.completed, 3);
  assert.equal(ready.progressPct, 43);
  assert.equal(ready.missed, false);
  assert.equal([...ready.days].map((d) => d.state).join(','),
    'done,done,done,ready,upcoming,upcoming,upcoming');
  assert.equal(ready.days[3].reward.coins, S.DAY_COINS);
  assert.equal(ready.days[3].reward.chakra, S.DAY_CHAKRA);

  // Already claimed today: today's cell is claimed, never "ready".
  const claimed = S.view({ streak: 4, lastClaim: '2026-10-24', today: '2026-10-24' });
  assert.equal(claimed.claimedToday, true);
  assert.equal(claimed.claimedDay, 4);
  assert.equal(claimed.nextDay, null);
  assert.equal(claimed.progressPct, 57);
  assert.equal([...claimed.days].map((d) => d.state).join(','),
    'done,done,done,claimed,upcoming,upcoming,upcoming');

  // A missed day resets the next claim to day 1.
  const missed = S.view({ streak: 5, lastClaim: '2026-10-22', today: '2026-10-24' });
  assert.equal(missed.missed, true);
  assert.equal(missed.nextDay, 1);
  assert.equal(missed.completed, 0);
  assert.equal(missed.progressPct, 0);
  assert.equal(missed.headline, 'Streak reset');
  assert.equal(missed.days[0].state, 'ready');

  // Day 7 paid today completes the cycle; tomorrow starts again at day 1.
  const complete = S.view({ streak: 7, lastClaim: '2026-10-24', today: '2026-10-24' });
  assert.equal(complete.cycleComplete, true);
  assert.equal(complete.progressPct, 100);
  assert.equal(complete.days[6].state, 'claimed');
  assert.equal(complete.days[6].reward.coins, S.DAY_COINS + S.BONUS_COINS);
  assert.equal(complete.days[6].reward.chakra, S.DAY_CHAKRA + S.BONUS_CHAKRA);

  const restart = S.view({ streak: 7, lastClaim: '2026-10-23', today: '2026-10-24' });
  assert.equal(restart.nextDay, 1, 'after day 7 the cycle restarts at day 1');
  assert.equal(restart.days[0].state, 'ready');

  // A brand-new account with no claim history starts on day 1.
  const fresh = S.view({ streak: 0, lastClaim: '', today: '2026-10-24' });
  assert.equal(fresh.nextDay, 1);
  assert.equal(fresh.completed, 0);
  assert.equal(fresh.missed, false);
});

test('Mini App streak date maths survives month, year and IST boundaries', () => {
  const S = loadStreak();
  assert.equal(S.addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(S.addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(S.addDays('2024-03-01', -1), '2024-02-29', 'leap year');
  assert.equal(S.addDays('nope', 1), null);
  assert.equal(S.dateKey('2026-1-1'), null, 'day keys must be zero padded');

  // The server's IST day key is what decides "today": a claim at 23:59 IST is
  // still the same day, and the day after it is the only continuation.
  const late = S.view({ streak: 2, lastClaim: '2026-10-23', today: '2026-10-24' });
  assert.equal(late.nextDay, 3);
  const nextDay = S.view({ streak: 2, lastClaim: '2026-10-24', today: '2026-10-25' });
  assert.equal(nextDay.nextDay, 3);
  assert.equal(nextDay.missed, false);
});

test('claimDaily stays server-authoritative: duplicate and concurrent claims pay once', () => {
  const output = execFileSync(
    process.execPath,
    ['--experimental-loader', './test/helpers/sdk-loader.mjs', 'test/helpers/run_streak.mjs'],
    { cwd: new URL('..', import.meta.url), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  assert.match(output, /streak: OK/);
});

test('the Mini App renders streak and claim state from the server, never locally', () => {
  const app = read('web', 'js', 'app.js');
  const streak = read('web', 'js', 'streak.js');

  // Claims go through the one authenticated endpoint and use its dashboard.
  assert.match(app, /serverlessCall\(\{\s*action:\s*'claim'\s*\}\)/);
  assert.doesNotMatch(app, /balance\.coins\s*[+\-]?=/);
  assert.doesNotMatch(app, /coins\s*:\s*\w+\.coins\s*\+/);

  // Streak visuals come from the shared model, not an ad-hoc formula.
  assert.match(app, /window\.FBStreak[\s\S]*?\.view\(\{\s*streak:/);
  assert.match(streak, /IST/);
  assert.match(streak, /DAILY_XP|DAY_CHAKRA/);

  // Reward amounts mirror tgcloud/lib/economy.js exactly.
  const economy = read('tgcloud', 'lib', 'economy.js');
  for (const name of ['DAILY_COINS', 'DAILY_CHAKRA', 'BONUS_COINS', 'BONUS_CHAKRA']) {
    const amount = new RegExp(name + '\\s*=\\s*(\\d+)').exec(economy);
    const ui = new RegExp({
      DAILY_COINS: 'DAY_COINS', DAILY_CHAKRA: 'DAY_CHAKRA',
      BONUS_COINS: 'BONUS_COINS', BONUS_CHAKRA: 'BONUS_CHAKRA',
    }[name] + '\\s*=\\s*(\\d+)').exec(streak);
    assert.ok(amount && ui, name + ' is declared');
    assert.equal(ui[1], amount[1], name + ' matches the bot economy');
  }
});

test('Mini App UI uses only custom SVG icons, no emoji', () => {
  const emoji = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/u;
  for (const file of ['app.js', 'icons.js', 'streak.js', 'game.js']) {
    const source = read('web', 'js', file);
    // Strip comments so documentation may still use a pictograph.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const found = code.match(emoji);
    assert.equal(found, null, file + ' contains an emoji: ' + (found && found[0]));
  }
  const html = read('web', 'index.html');
  assert.match(html, /js\/icons\.js/, 'icon library is loaded');
  assert.match(html, /js\/streak\.js/, 'streak model is loaded');
  assert.match(html, /js\/contract\.js[\s\S]*js\/icons\.js[\s\S]*js\/streak\.js[\s\S]*js\/app\.js/,
    'scripts load in dependency order');
});
