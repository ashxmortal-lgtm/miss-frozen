import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// Round 15 — a bought jutsu is a passive unlock, so /equip must stop answering
// with the "recruit this shinobi" card.
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('/equip knows the jutsu catalogue before it treats a name as a shinobi', () => {
  const handler = read('tgcloud/lib/economy_handler.js');
  assert.match(handler, /import \{ SCREENS, screenText, screenKeyboard, findItem, fmt, JUTSU \} from '\.\/store\.js';/);

  const fn = handler.slice(handler.indexOf('export async function handleEquip'), handler.indexOf('const r = await equipShinobi'));
  assert.match(fn, /const jutsu = JUTSU\.find\(/, 'the jutsu catalogue is checked before the shinobi path');
  assert.match(fn, /is already unlocked — jutsu are always active and never equipped/);
  assert.match(fn, /\/buy \$\{escapeHtml\(jutsu\.name\)\}/, 'the unlock path is /buy');
  assert.match(fn, /reply in a group with <code>\/mt your message<\/code>/);
  assert.ok(
    handler.indexOf('const jutsu = JUTSU.find(') < handler.indexOf('const r = await equipShinobi('),
    'the jutsu branch runs before equipShinobi',
  );

  // The shinobi branch keeps its recruit card for real shinobi names.
  assert.match(handler, /Recruit at \/shinobi_store/);
});

test('/mt recognises a purchased Mind Transmission Jutsu', () => {
  const mt = read('tgcloud/lib/mt.js');
  const fn = mt.slice(mt.indexOf('async function hasMtJutsu'), mt.indexOf('/**\n * Ephemeral messages must be tied'));
  assert.match(fn, /SELECT qty FROM inventory/, 'the owned jutsu is read from inventory');
  assert.match(fn, /item_name LIKE '%Mind Transmission%'/, 'a purchased row matches regardless of item_type');
  assert.doesNotMatch(fn, /db\.select\(\)/, 'no dependency on the query builder');
});

test('/buy tells the player a jutsu is live without /equip', () => {
  const buy = read('tgcloud/lib/buy.js');
  assert.match(buy, /ʀᴇᴀᴅʏ ᴛᴏ ᴜsᴇ — ɴᴏ \/equip ɴᴇᴇᴅᴇᴅ\./);
  assert.match(buy, /ɢʀᴏᴜᴘ: ʀᴇᴘʟʏ ᴛᴏ ᴀ ᴍᴇᴍʙᴇʀ ᴡɪᴛʜ \/mt \[ᴍᴇssᴀɢᴇ\]/);
});

test('/equip + /mt after buying the jutsu (end to end)', () => {
  const output = execFileSync(
    process.execPath,
    ['--experimental-loader', './test/helpers/sdk-loader.mjs', 'test/helpers/run_equip_jutsu.mjs'],
    { cwd: new URL('..', import.meta.url), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  assert.match(output, /equip jutsu: OK/);
});
