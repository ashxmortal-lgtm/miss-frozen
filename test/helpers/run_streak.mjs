// Drives the real claimDaily() economy path against the SDK database stub:
// IST day boundaries, consecutive / missed days, the 7-day cycle, duplicate
// and concurrent claims, and Sakura's level-scaled bonus.
import assert from 'node:assert/strict';
import { db } from './sdk_db_stub.mjs';
import {
  claimDaily, dayKey, DAILY_COINS, DAILY_CHAKRA, BONUS_COINS, BONUS_CHAKRA, DAILY_XP,
} from '../../tgcloud/lib/economy.js';

// The SDK stub has no query builder; claimDaily() only needs getBalance()'s
// `db.select().from(users).where(...).get()` shape, so answer it from the row of
// the user under test (set by claim()) while every assertion reads raw SQL.
let activeId = null;
db.select = () => ({
  from() { return this; },
  where() { return this; },
  async get() {
    return db.get({ text: 'SELECT * FROM users WHERE telegram_id = ?', params: [activeId] });
  },
});
const claim = (id) => { activeId = id; return claimDaily(id); };

const row = async (id) => db.get({
  text: 'SELECT balance, xp, last_claim_date, claim_streak FROM users WHERE telegram_id = ?',
  params: [id],
});
const chakra = async (id) => {
  const r = await db.get({
    text: "SELECT qty FROM inventory WHERE telegram_id = ? AND item_name = 'Chakra'",
    params: [id],
  });
  return r ? r.qty : 0;
};
const seed = (id) => db.run({
  text: 'INSERT OR IGNORE INTO users (telegram_id, balance) VALUES (?, 0)',
  params: [id],
});
const setDay = (id, date, streak) => db.run({
  text: 'UPDATE users SET last_claim_date = ?, claim_streak = ? WHERE telegram_id = ?',
  params: [date, streak, id],
});

// ---- IST boundary ---------------------------------------------------------------
// 18:29:59Z is 23:59:59 IST; 18:30:00Z is 00:00:00 IST the next day.
const realNow = Date.now;
const at = (iso) => { Date.now = () => Date.parse(iso); };
at('2026-10-24T18:29:59Z');
assert.equal(dayKey(0), '2026-10-24', 'just before IST midnight');
assert.equal(dayKey(-1), '2026-10-23');
at('2026-10-24T18:30:00Z');
assert.equal(dayKey(0), '2026-10-25', 'IST midnight rolls the day key');
assert.equal(dayKey(-1), '2026-10-24');
at('2026-03-01T18:29:00Z');
assert.equal(dayKey(-1), '2026-02-28', 'month boundary');
at('2026-12-31T18:29:00Z');
assert.equal(dayKey(1), '2027-01-01', 'year boundary');
Date.now = realNow;

// ---- claims run on a fixed IST clock so every assertion is deterministic --------
at('2026-10-24T10:00:00+05:30');
assert.equal(dayKey(0), '2026-10-24');

// ---- first claim -----------------------------------------------------------------
const A = 501;
await seed(A);
const first = await claim(A);
assert.equal(first.claimed, true, 'first claim pays');
assert.equal(first.streak, 1);
assert.equal(first.bonus, false);
assert.equal(first.coins, DAILY_COINS);
assert.equal(first.chakra, DAILY_CHAKRA);
assert.equal(first.xp, DAILY_XP);
let a = await row(A);
// A daily-mission reward may settle alongside the claim, so the streak fields —
// not the absolute balance — are what this test pins down.
assert.ok(a.balance >= DAILY_COINS, 'claim coins are credited');
assert.ok(a.xp >= DAILY_XP, 'claim xp is credited');
assert.equal(a.claim_streak, 1);
assert.equal(a.last_claim_date, dayKey(0));
assert.equal(await chakra(A), DAILY_CHAKRA, 'chakra is credited to the inventory row');

// ---- duplicate claim the same day -----------------------------------------------
const beforeDup = await row(A);
const dup = await claim(A);
assert.equal(dup.claimed, false, 'second claim on the same day does not pay');
a = await row(A);
assert.equal(a.balance, beforeDup.balance, 'balance unchanged by the duplicate');
assert.equal(a.xp, beforeDup.xp, 'xp unchanged by the duplicate');
assert.equal(await chakra(A), DAILY_CHAKRA, 'chakra unchanged by the duplicate');

// ---- consecutive day -------------------------------------------------------------
const B = 502;
await seed(B);
await setDay(B, dayKey(-1), 3);
const next = await claim(B);
assert.equal(next.claimed, true);
assert.equal(next.streak, 4, 'yesterday + today continues the streak');
assert.equal(next.coins, DAILY_COINS, 'a mid-cycle day pays the daily amount');

// ---- missed day ------------------------------------------------------------------
const C = 503;
await seed(C);
await setDay(C, dayKey(-2), 5);
const reset = await claim(C);
assert.equal(reset.claimed, true);
assert.equal(reset.streak, 1, 'a missed day restarts the streak at day 1');

// ---- cycle -----------------------------------------------------------------------
const D = 504;
await seed(D);
await setDay(D, dayKey(-1), 7);
const cycle = await claim(D);
assert.equal(cycle.streak, 1, 'day 7 rolls back to day 1 on the next consecutive claim');
assert.equal(cycle.bonus, false);

const E = 505;
await seed(E);
await setDay(E, dayKey(-1), 6);
const day7 = await claim(E);
assert.equal(day7.streak, 7);
assert.equal(day7.bonus, true, 'day 7 pays the bonus');
assert.equal(day7.coins, DAILY_COINS + BONUS_COINS);
assert.equal(day7.chakra, DAILY_CHAKRA + BONUS_CHAKRA);

// ---- Sakura level bonus ----------------------------------------------------------
const F = 506;
await seed(F);
await db.run({ text: "INSERT INTO inventory (telegram_id, item_type, item_name, qty) VALUES (?, 'shinobi', 'Sakura', 1)", params: [F] });
await db.run({ text: "INSERT INTO shinobi_state (telegram_id, shinobi, level) VALUES (?, 'Sakura', 40)", params: [F] });
const sak = await claim(F);
assert.equal(sak.claimed, true);
assert.equal(sak.sakura, true);
assert.ok(sak.sakuraCoins > 0 && sak.sakuraChakra > 0, 'Sakura owners get the scaled bonus');
assert.equal(sak.coins, DAILY_COINS + sak.sakuraCoins);
assert.equal(sak.chakra, DAILY_CHAKRA + sak.sakuraChakra);

// ---- concurrent claims: exactly one winner ---------------------------------------
const G = 507;
await seed(G);
const results = await Promise.all([1, 2, 3, 4, 5].map(() => claimDaily(G)));
assert.equal(results.filter((r) => r.claimed).length, 1, 'only one concurrent claim pays');
const g = await row(G);
assert.equal(g.claim_streak, 1, 'concurrent claims settle one streak step');
assert.equal(await chakra(G), DAILY_CHAKRA, 'concurrent claims credit chakra once');

// ---- same IST day never re-pays; IST midnight starts a new day -------------------
const H = 508;
await seed(H);
const before = await claim(H);
assert.equal(before.claimed, true);

at('2026-10-24T23:59:00+05:30');
const sameNight = await claim(H);
assert.equal(sameNight.claimed, false, 'still the same IST day just before midnight');
assert.equal(sameNight.streak, 1);

at('2026-10-25T00:00:30+05:30');
const afterMidnight = await claim(H);
assert.equal(afterMidnight.claimed, true, 'IST midnight starts a new claim day');
assert.equal(afterMidnight.streak, 2, 'a new IST day continues the streak');
assert.equal(await chakra(H), DAILY_CHAKRA * 2);

Date.now = realNow;

console.log('streak: OK');
