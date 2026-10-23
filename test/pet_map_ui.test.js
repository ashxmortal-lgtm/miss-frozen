import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const read = (path) => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');

// Drives the real BBQ / Hot Springs keyboards, the shared rest sessions and the
// daily quest caption against the in-memory SDK shims.
test('pet map integration: BBQ, Hot Springs, rest sessions and daily quest', () => {
  const output = execFileSync(
    process.execPath,
    ['--experimental-loader', './test/helpers/sdk-loader.mjs', 'test/helpers/run_pet_map.mjs'],
    { cwd: new URL('..', import.meta.url), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  assert.match(output, /pet map integration: OK/);
});

test('map screens follow the pet redesign spec', () => {
  const handler = read('tgcloud/lib/map/handler.js');
  const ui = read('tgcloud/lib/map/ui.js');
  const rich = read('tgcloud/lib/map/rich.js');

  // Gate: no pet activity block at all.
  const gate = handler.slice(handler.indexOf('async function gateBody'), handler.indexOf('// --- Training Ground'));
  assert.doesNotMatch(gate, /listPets|petStatusText|🐾 PETS/);
  assert.match(gate, /statusTableHtml\(status\.rows\)/);

  // Rich divider is a real block; classic rendering never leaks the marker.
  assert.match(handler, /function captionBody\(lines\)/);
  assert.match(handler, /captionBody[\s\S]*?<hr\/>/);
  assert.match(handler, /CAPTION_LOCATIONS[\s\S]*?bbq: BBQ_CAPTION[\s\S]*?hotsprings: HOTSPRINGS_CAPTION/);
  assert.doesNotMatch(handler, /~tg rich divider~/);

  // Hot Springs callbacks: relax the selection, send one, recall one.
  for (const action of ['map_hot_relax', 'map_hot_go', 'map_hot_recall', 'map_hot_stop']) {
    assert.match(handler, new RegExp(`'${action}'`), action);
  }
  assert.match(handler, /startBbq\(user\.id, shinobi, 'hotsprings'\)/);
  assert.match(handler, /listBbqSessions\(user\.id, 'hotsprings'\)/);
  assert.match(handler, /startBbq\(user\.id, shinobi, 'bbq'\)/);
  assert.match(handler, /listBbqSessions\(user\.id, 'bbq'\)/);

  // Ramen shop pet food uses the caption + price buttons (instant buy).
  assert.match(handler, /petFoodCaptionHtml\(\)/);
  assert.match(handler, /petFoodPriceKeyboard\(/);
  assert.match(ui, /🍱 Pet Food/);

  // Feeding is gated on hunger (energy), not only on the activity state.
  assert.match(handler, /pet\.energy >= 100/);
  assert.match(read('tgcloud/lib/pet/ui.js'), /pet\.energy >= PET_MAX_ENERGY/);
});

test('rest sessions and availability are shared by BBQ and Hot Springs', () => {
  const bbq = read('tgcloud/lib/map/bbq.js');
  assert.match(bbq, /CREATE UNIQUE INDEX IF NOT EXISTS uidx_bbq_sessions_owner_shinobi/);
  assert.match(bbq, /location: 'bbq' \| 'hotsprings'|'bbq' \| 'hotsprings'/);
  // Full chakra frees the shinobi automatically.
  assert.match(bbq, /if \(before \+ give >= MAX_CHAKRA\)[\s\S]*?DELETE FROM bbq_sessions/);
  assert.match(bbq, /if \(\(await chakraQty\(telegramId\)\) >= MAX_CHAKRA\) return \{ code: 'full' \};/);
  assert.match(read('tgcloud/schema.js'), /location: text\('location'\)\.notNull\(\)\.default\('bbq'\)/);
  // Busy shinobi cannot be dispatched from the map while recovering.
  assert.match(read('tgcloud/lib/activities.js'), /if \(\(await restingShinobi\(id\)\)\.has\(shinobi\)\) return \{ status: 'busy_rest', shinobi \};/);
  assert.match(read('tgcloud/lib/pet/store.js'), /SELECT 1 AS ok FROM bbq_sessions/);
  assert.match(read('tgcloud/lib/rpg/status.js'), /label: springs \? 'At Hot Springs' : 'At BBQ'/);
});

test('daily quest caption uses the assigned mission data', () => {
  const daily = read('tgcloud/lib/daily.js');
  const body = daily.slice(daily.indexOf('export function dailyMissionBody'), daily.indexOf('export function', daily.indexOf('export function dailyMissionBody') + 10));
  for (const line of [
    '🎯 DAILY QUEST', '📜 ǫᴜᴇꜱᴛ:', '🥷 ᴏʙᴊᴇᴄᴛɪᴠᴇ:',
    '🍥 ʀᴇᴡᴀʀᴅ:', '📊 ꜱᴛᴀᴛᴜꜱ:', '⌛ ᴇxᴘɪʀᴇꜱ:',
  ]) {
    assert.ok(body.includes(line), `daily caption missing ${line}`);
  }
  assert.match(body, /template\.objective/);
  assert.match(body, /mission\.rewardCoins/);
  assert.doesNotMatch(body, /1,500/, 'reward comes from the mission, not a literal');
});
