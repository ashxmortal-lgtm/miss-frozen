import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mapKeyboard, villageKeyboard, storeKeyboard } from '../tgcloud/lib/map/ui.js';

// Load the pure rendering helpers without the platform-only SDK imports.
const source = fs.readFileSync(new URL('../tgcloud/lib/map/rich.js', import.meta.url), 'utf8');
const helpers = source.slice(source.indexOf('export function richBtn'), source.indexOf('function inputRichMessage'))
  .replaceAll('export function', 'function');
const render = new Function('escapeHtml', `${helpers}; return richHtml;`)(
  (s) => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'),
);

test('Konoha location menu preserves all labels, actions and compact row ordering', () => {
  const rows = mapKeyboard(42).inline_keyboard;
  assert.deepEqual(rows.map((r) => r.length), [2, 2, 2, 1, 1]);
  assert.deepEqual(rows.flat().map(({ text, callback_data }) => [text, callback_data]), [
    ['🏯 Hokage Office', 'map_loc_hokage:42'],
    ['🍖 BBQ', 'map_loc_bbq:42'],
    ['🍜 Ichiraku Ramen', 'map_loc_ichiraku:42'],
    ['🚪 Gate', 'map_loc_gate:42'],
    ['🥷 Training Ground', 'map_loc_training:42'],
    ['🏪 Stores', 'map_loc_store:42'],
    ['♨️ Hot Springs', 'map_loc_hotsprings:42'],
    ['❌ Close', 'map_close:42'],
  ]);
});

test('only location-menu buttons use the native neutral surface', () => {
  const html = render('<p>Map</p>', mapKeyboard(42));
  assert.equal((html.match(/<tg-button type=/g) || []).length, 8);
  assert.equal((html.match(/<tg-button-row align="center">/g) || []).length, 5);
  assert.doesNotMatch(html, /style=/);
  for (const keyboard of [villageKeyboard(42), storeKeyboard(42)]) {
    assert.match(render('', keyboard), /style="transparent"/);
  }
});
