// Patrol/mission reward card: the returning user is mentioned, coins carry the
// 🍥 icon, XP uses ⭐, active boosts are named with their coin amounts, and
// Capycorn is only mentioned when it actually shortened the activity.
import assert from 'node:assert/strict';
import { db, sql } from './sdk_db_stub.mjs';

const { rewardCard, settleOwn } = await import('../../tgcloud/lib/activities.js');

const U = 2001;

// ---- pure card -----------------------------------------------------------------
const card = rewardCard({
  id: U, name: 'Tester', username: 'tester',
  kind: 'patrol', shinobi: 'Starter Shinobi',
  coins: 307, xp: 66, sakuraBonus: 150, petBonus: 30, timeCutPct: 3,
  pendingTotal: 307, rankUp: null,
});
const expected = [
  '🏮 𝐓𝐄𝐀𝐌 𝐏𝐀𝐓𝐑𝐎𝐋 𝐑𝐄𝐓𝐔𝐑𝐍𝐄𝐃',
  '',
  'ʜɪᴅᴅᴇɴ ʟᴇᴀғ ᴠɪʟʟᴀɢᴇ ɪs sᴀғᴇ.',
  '',
  '<a href="tg://user?id=2001">Tester</a>',
  '<blockquote>🥷 𝐒𝐭𝐚𝐫𝐭𝐞𝐫 𝐒𝐡𝐢𝐧𝐨𝐛𝐢 → +307 🍥',
  '⭐ +66 xᴘ',
  '🌸 Sakura boost: +150 🍥',
  '🦋 Axofly boost: +30 🍥',
  '🦄 Capycorn: −3% patrol time</blockquote>',
  '',
  '<blockquote>🍥 𝐏𝐞𝐧𝐝𝐢𝐧𝐠 𝐭𝐨𝐭𝐚𝐥: 307 ᴋᴏɴᴏʜᴀ ᴄᴏɪɴs</blockquote>',
].join('\n');
assert.equal(card, expected, 'the patrol return card matches the requested layout');

// The shinobi reward rows are quoted, the pending balance has its own quote,
// and the old "/map -> Hokage" claim instructions are gone (a button replaces
// them, see the map Gate + economy handler).
const rewardQuote = card.slice(card.indexOf('<blockquote>'), card.indexOf('</blockquote>') + 13);
assert.match(rewardQuote, /\+307 🍥/);
assert.match(rewardQuote, /\+66 xᴘ/);
assert.match(rewardQuote, /Sakura boost/);
const pendingQuote = card.slice(card.lastIndexOf('<blockquote>'));
assert.ok(pendingQuote.includes('<blockquote>'));
assert.ok(!rewardQuote.includes('🍥 𝐏𝐞𝐧𝐝𝐢𝐧𝐠'), 'the pending balance is not inside the reward quote');
assert.ok(!card.includes('/map → 🏯'), 'no manual /map → 🏯 claim hint');

// Coins carry the currency icon; the XP row uses ⭐ and never the coin icon.
const coinRow = card.split('\n').find((l) => l.includes('→ +307'));
const xpRow = card.split('\n').find((l) => l.includes('xᴘ'));
assert.match(coinRow, /\+307 🍥$/);
assert.match(xpRow, /^⭐ \+66 xᴘ$/);
assert.ok(!xpRow.includes('🍥'), 'the XP row has no coin icon');

// No boosts → no boost rows at all (Capycorn is not named when it saved nothing).
const plain = rewardCard({
  id: U, name: 'Tester', kind: 'patrol', shinobi: 'Hinata',
  coins: 100, xp: 50, sakuraBonus: 0, petBonus: 0, timeCutPct: 0,
  pendingTotal: 0, rankUp: null,
});
assert.doesNotMatch(plain, /Sakura/);
assert.doesNotMatch(plain, /Axofly/);
assert.doesNotMatch(plain, /Capycorn/);
assert.doesNotMatch(plain, /𝐏𝐞𝐧𝐝𝐢𝐧𝐠/);

// Missions get their own heading and keep the same reward rows.
const mission = rewardCard({
  id: U, name: 'Tester', kind: 'mission', shinobi: 'Sasuke',
  coins: 250, xp: 80, sakuraBonus: 0, petBonus: 0, timeCutPct: 4,
  pendingTotal: 250, rankUp: null,
});
assert.match(mission, /^⚔️ 𝐌𝐈𝐒𝐒𝐈𝐎𝐍 𝐂𝐎𝐌𝐏𝐋𝐄𝐓𝐄\n/);
assert.match(mission, /🦄 Capycorn: −4% mission time/);
assert.match(mission, /⭐ \+80 xᴘ\n/);

// ---- live settle path ----------------------------------------------------------
await db.run(sql`
  CREATE TABLE IF NOT EXISTS pending_patrol_rewards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id INTEGER NOT NULL,
    shinobi TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'patrol',
    reward INTEGER NOT NULL DEFAULT 0,
    completed_at INTEGER NOT NULL DEFAULT 0,
    claimed INTEGER NOT NULL DEFAULT 0
  )
`);
await db.run(sql`INSERT INTO users (telegram_id, balance, xp, first_name) VALUES (${U}, 0, 800, 'Tester')`);
await db.run(sql`INSERT INTO inventory (telegram_id, item_type, item_name, qty) VALUES (${U}, 'shinobi', 'Sakura', 1)`);
await db.run(sql`INSERT INTO inventory (telegram_id, item_type, item_name, qty) VALUES (${U}, 'shinobi', 'Starter Shinobi', 1)`);

const t = Math.floor(Date.now() / 1000);
// Capycorn cut a 60-minute patrol down to 58 minutes (3% rounded to whole minutes).
await db.run(sql`
  INSERT INTO activities (telegram_id, shinobi, kind, status, started_at, ends_at, base_roll, chat_id)
  VALUES (${U}, 'Sakura', 'patrol', 'active', ${t - 3480}, ${t - 5}, 300, -777)
`);

const settled = await settleOwn({ id: U });
assert.equal(settled.blocks.length, 1, 'one finished patrol → one card');
const live = settled.blocks[0];
assert.ok(live.includes(`<a href="tg://user?id=${U}">Tester</a>`), 'the returning user is mentioned');
assert.match(live, /🌸 𝐒𝐚𝐤𝐮𝐫𝐚 → \+\d+ 🍥/, 'Sakura coin row');
assert.match(live, /⭐ \+\d+ xᴘ/);
assert.match(live, /🌸 Sakura boost: \+\d+ 🍥/, 'Sakura boost shown in coins');
assert.match(live, /🦄 Capycorn: −3% patrol time/, 'the shortened patrol names Capycorn');
assert.match(live, /🍥 𝐏𝐞𝐧𝐝𝐢𝐧𝐠 𝐭𝐨𝐭𝐚𝐥: [\d,]+ ᴋᴏɴᴏʜᴀ ᴄᴏɪɴs/);
assert.ok(!live.includes('/map → 🏯'), 'the claim is a button, not a text hint');

const pending = await db.get(sql`
  SELECT SUM(reward) AS total FROM pending_patrol_rewards WHERE telegram_id = ${U} AND claimed = 0
`);
assert.ok(Number(pending.total) > 0, 'coins are parked as pending, not auto-claimed');

console.log('activity reward: OK');
