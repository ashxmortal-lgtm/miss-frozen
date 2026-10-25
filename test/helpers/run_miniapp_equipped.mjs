// Mini App equipped shinobi sync.
//
// The Mini App renders profile.equippedList as the three slot cards on Home and
// on /profile. It must always carry exactly what the bot shows (/inventory
// EQUIPPED, /equip): user_equipped in slot order, the legacy users.equipped
// column as fallback, and never an empty list.
import assert from 'node:assert/strict';
import { db, sql } from './sdk_db_stub.mjs';
import miniapp from '../../tgcloud/endpoints/miniapp.js';

await db.run(sql.raw(`CREATE TABLE IF NOT EXISTS user_equipped (
  telegram_id INTEGER NOT NULL,
  shinobi TEXT NOT NULL,
  slot INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (telegram_id, shinobi)
)`));
await db.run(sql.raw(`CREATE TABLE IF NOT EXISTS user_skills (
  telegram_id INTEGER PRIMARY KEY,
  protected_until INTEGER NOT NULL DEFAULT 0,
  byakugan_at INTEGER NOT NULL DEFAULT 0,
  sakura_heal_at INTEGER NOT NULL DEFAULT 0,
  sakura_heal_uses INTEGER NOT NULL DEFAULT 0,
  katsuyu_heal_at INTEGER NOT NULL DEFAULT 0,
  dead_until INTEGER NOT NULL DEFAULT 0,
  last_robbed_at INTEGER NOT NULL DEFAULT 0
)`));

// The SDK stub has no query builder; answer the dashboard's inventory read for
// whichever account is being bootstrapped.
let activeId = null;
db.select = () => ({
  from() { return this; },
  where() { return this; },
  async get() {
    return db.get({ text: 'SELECT * FROM users WHERE telegram_id = ?', params: [activeId] });
  },
  async all() {
    return db.all({ text: 'SELECT * FROM inventory WHERE telegram_id = ?', params: [activeId] });
  },
});

const bootstrap = async (id) => {
  activeId = id;
  const dashboard = await miniapp(
    { action: 'bootstrap' },
    { initData: { user: { id, first_name: 'Tester' } } },
  );
  return dashboard;
};

const addUser = async (id, name, equipped) => {
  await db.run(sql`INSERT OR REPLACE INTO users (telegram_id, balance, xp, first_name, equipped)
    VALUES (${id}, 100, 2000, ${name}, ${equipped})`);
};

const own = async (id, name, qty = 1) => {
  await db.run(sql`INSERT OR IGNORE INTO inventory (telegram_id, item_type, item_name, qty)
    VALUES (${id}, 'shinobi', ${name}, ${qty})`);
};

const equip = async (id, name, slot) => {
  await db.run(sql`INSERT OR IGNORE INTO user_equipped (telegram_id, shinobi, slot)
    VALUES (${id}, ${name}, ${slot})`);
};

// ---- 1. slots come from user_equipped, in slot order -----------------------
const SLOTTED = 9101;
await addUser(SLOTTED, 'Slotted', 'Naruto');
await own(SLOTTED, 'Naruto');
await own(SLOTTED, 'Sasuke');
// Inserted out of order on purpose: slot decides, not insert time.
await equip(SLOTTED, 'Sasuke', 2);
await equip(SLOTTED, 'Naruto', 1);

const slotted = await bootstrap(SLOTTED);
assert.deepEqual(slotted.profile.equippedList, ['Naruto', 'Sasuke'], 'slot order, both slots');
assert.equal(slotted.profile.life.equipped, 'Naruto', 'primary equip matches slot 1');
assert.ok(slotted.profile.equippedList.length <= 3, 'max three slots');

// ---- 2. legacy users.equipped only (no user_equipped rows yet) -------------
const LEGACY = 9102;
await addUser(LEGACY, 'Legacy', 'Sakura');
await own(LEGACY, 'Sakura');

const legacy = await bootstrap(LEGACY);
assert.deepEqual(legacy.profile.equippedList, ['Sakura'], 'legacy column still syncs');
assert.equal(legacy.profile.life.equipped, 'Sakura');

// ---- 3. the slot table read fails → legacy fallback, never empty -----------
const BROKEN = 9103;
await addUser(BROKEN, 'Broken', 'Itachi');
await own(BROKEN, 'Itachi');

const keptTable = 'user_equipped';
await db.run(sql.raw('ALTER TABLE user_equipped RENAME TO user_equipped_hidden'));
try {
  const broken = await bootstrap(BROKEN);
  assert.deepEqual(broken.profile.equippedList, ['Itachi'], 'a failed slot read falls back to the primary equip');
} finally {
  await db.run(sql.raw(`ALTER TABLE user_equipped_hidden RENAME TO ${keptTable}`));
}

// ---- 4. nothing equipped anywhere → the starter, still not empty -----------
const EMPTY = 9104;
await addUser(EMPTY, 'Empty', null);

const empty = await bootstrap(EMPTY);
assert.deepEqual(empty.profile.equippedList, ['Starter Shinobi'], 'never an empty list');
assert.equal(empty.profile.life.equipped, 'Starter Shinobi');

// ---- 5. the same list on /profile and in the mini app ----------------------
const { profileData } = await import('../../tgcloud/lib/profile.js');
const botRecord = await profileData({ id: SLOTTED, first_name: 'Slotted' });
assert.deepEqual(botRecord.equippedList, slotted.profile.equippedList, 'one record for both screens');

console.log('miniapp equipped: OK');
