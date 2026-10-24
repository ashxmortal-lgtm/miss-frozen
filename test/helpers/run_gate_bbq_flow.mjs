// Live Gate → BBQ → patrol flow: an exhausted shinobi shows the recovery
// shortcut at the Gate, the recovery window pays 200 🍥 and immediately offers
// the patrol picker with the healed unit preselected, and sending dispatches a
// real patrol. Drives the real handler against the in-memory SDK shims.
import assert from 'node:assert/strict';
import { db, sql } from './sdk_db_stub.mjs';
import { api as sdkApi } from 'sdk';

const sent = [];
const answers = [];
sdkApi.answerCallbackQuery = async (payload) => { answers.push(payload); return true; };
sdkApi.sendRichMessage = async (payload) => {
  sent.push(payload);
  return { message_id: 900 + sent.length };
};
sdkApi.editMessageText = async (payload) => {
  sent.push(payload);
  return true;
};
sdkApi.sendMessage = async (payload) => {
  sent.push(payload);
  return { message_id: 800 + sent.length };
};

// Tables the production `tgcloud migrate` creates; the flow needs them here.
await db.run(sql.raw(`CREATE TABLE IF NOT EXISTS map_gate_selection (
  telegram_id INTEGER NOT NULL, shinobi TEXT NOT NULL, PRIMARY KEY (telegram_id, shinobi)
)`));
await db.run(sql.raw(`CREATE TABLE IF NOT EXISTS tsunade_search (
  telegram_id INTEGER PRIMARY KEY, status TEXT NOT NULL DEFAULT 'idle',
  ends_at INTEGER NOT NULL DEFAULT 0, found INTEGER NOT NULL DEFAULT 0
)`));
await db.run(sql.raw(`CREATE TABLE IF NOT EXISTS pending_patrol_rewards (
  id INTEGER PRIMARY KEY AUTOINCREMENT, telegram_id INTEGER NOT NULL,
  shinobi TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'patrol',
  reward INTEGER NOT NULL DEFAULT 0, completed_at INTEGER NOT NULL DEFAULT 0,
  claimed INTEGER NOT NULL DEFAULT 0
)`));

const { handleMapCallback } = await import('../../tgcloud/lib/map/handler.js');

const U = 9101;
const CHAT = -1009101;
const now = () => Math.floor(Date.now() / 1000);

async function callback(data) {
  sent.length = 0;
  await handleMapCallback({
    id: 'cb-test',
    data,
    from: { id: U, first_name: 'Tester', username: 'tester' },
    message: { message_id: 55, chat: { id: CHAT, type: 'supergroup', title: 'Konoha' } },
  });
  return sent
    .map((p) => p?.rich_message?.html || p?.text || '')
    .join('\n');
}

// Buttons keep their callback_data (labels are small-caps styled on the wire).
const buttons = (html) => [...html.matchAll(/<tg-button[^>]*data="([^"]*)"[^>]*>([^<]*)<\/tg-button>/g)]
  .map((m) => ({ data: m[1], text: m[2] }));
const hasData = (html, data) => buttons(html).some((b) => b.data === data);

// ---- seed: one exhausted shinobi, 1,000 🍥 ----------------------------------
await db.run(sql`INSERT INTO users (telegram_id, balance, xp, first_name) VALUES (${U}, 1000, 0, 'Tester')`);
await db.run(sql`INSERT INTO inventory (telegram_id, item_type, item_name, qty) VALUES (${U}, 'shinobi', 'Naruto', 1)`);
const exhaustedUntil = now() + 1200;
await db.run(sql`
  INSERT INTO shinobi_state (telegram_id, shinobi, level, exhausted_until)
  VALUES (${U}, 'Naruto', 1, ${exhaustedUntil})
`);

// ---- Gate: the BBQ recovery shortcut appears --------------------------------
const gate = await callback(`map_loc_gate:${U}`);
assert.ok(hasData(gate, `map_bbq_heal:${U}`), 'the Gate shows the BBQ recovery shortcut');
assert.ok(hasData(gate, `map_patrol_pick:${U}`));
assert.ok(hasData(gate, `map_home:${U}`));

// ---- BBQ recovery selection window -----------------------------------------
const heal = await callback(`map_bbq_heal:${U}`);
assert.ok(hasData(heal, `map_bbq_htog:Naruto:${U}`), 'the exhausted shinobi is listed');
assert.ok(hasData(heal, `map_bbq_hpay:${U}`));
await callback(`map_bbq_htog:Naruto:${U}`);

// ---- Paying turns the same screen into the patrol picker -------------------
const pay = await callback(`map_bbq_hpay:${U}`);
assert.ok(hasData(pay, `map_psend:${U}`), 'send on patrol is offered right after the recovery');
assert.ok(hasData(pay, `map_btog:Naruto:${U}`), 'the healed shinobi is preselected');
assert.ok(hasData(pay, `map_ball:${U}`));
assert.ok(hasData(pay, `map_loc_bbq:${U}`), 'back to the BBQ');

const stateAfterHeal = await db.get(sql`SELECT exhausted_until FROM shinobi_state WHERE telegram_id = ${U} AND shinobi = 'Naruto'`);
assert.equal(Number(stateAfterHeal.exhausted_until), 0, 'exhaustion cleared');
const balance = await db.get(sql`SELECT balance FROM users WHERE telegram_id = ${U}`);
assert.equal(Number(balance.balance), 800, '200 🍥 charged for the recovery');

// Toggling inside that window keeps the BBQ context instead of jumping to the Gate.
const toggled = await callback(`map_btog:Naruto:${U}`);
assert.ok(hasData(toggled, `map_btog:Naruto:${U}`), 'still the BBQ picker');
assert.ok(hasData(toggled, `map_loc_bbq:${U}`));
assert.ok(!hasData(toggled, `map_patrol_pick:${U}`), 'the picker does not jump back to the Gate');
// Select-all inside the BBQ picker also stays on that screen and reselects.
const all = await callback(`map_ball:${U}`);
assert.ok(hasData(all, `map_btog:Naruto:${U}`));
assert.ok(!hasData(all, `map_patrol_pick:${U}`), 'select-all stays in the BBQ picker');

// ---- Send on patrol ---------------------------------------------------------
const roster = await callback(`map_psend:${U}`);

assert.ok(hasData(roster, `map_patrol_pick:${U}`), 'the Gate roster is back');
const row = await db.get(sql`SELECT kind, status, ends_at FROM activities WHERE telegram_id = ${U} AND shinobi = 'Naruto'`);
assert.equal(row.status, 'active', 'the patrol is running');
assert.equal(row.kind, 'patrol');
assert.ok(Number(row.ends_at) > now(), 'the patrol returns later');

// The status table is refreshed and the BBQ shortcut is gone again.
assert.ok(!hasData(roster, `map_bbq_heal:${U}`), 'shortcut hides once nobody is exhausted');

console.log('gate bbq flow: OK');
