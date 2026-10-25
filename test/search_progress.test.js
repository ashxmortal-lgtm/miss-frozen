import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// Round 14 — the /search_tsuna status card: heading on top, a real rich
// divider, and every line below the heading quoted.
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('the search card is heading → divider → quoted lines', () => {
  const tsunade = read('tgcloud/lib/rpg/tsunade.js');
  assert.match(tsunade, /const SEARCH_PROGRESS_HEADING = '🔎 𝐒𝐄𝐀𝐑𝐂𝐇 𝐈𝐍 𝐏𝐑𝐎𝐆𝐑𝐄𝐒𝐒';/);
  const block = tsunade.slice(
    tsunade.indexOf('export function searchProgressContent'),
    tsunade.indexOf('export async function searchRow'),
  );
  assert.match(block, /blocks: \[P\(SEARCH_PROGRESS_HEADING\), \{ type: 'divider' \}, quote\(/, 'heading + divider + quote');
  assert.match(block, /🍥 Naruto and 🐸 Jiraiya are on the hunt for Lady Tsunade!/);
  assert.match(block, /⏳ 𝐂𝐎𝐌𝐏𝐋𝐄𝐓𝐄𝐒 𝐀𝐓 \$\{finish\}/);
  assert.match(block, /🕒 time left: \$\{left\}/);
  assert.match(block, /text: `\$\{SEARCH_PROGRESS_HEADING\}\\n\\n<blockquote>/, 'classic fallback keeps the quote');
  assert.match(tsunade, /return searchProgressContent\(row, t\);/, 'the live command returns the card');
});

test('/search_tsuna sends the blocks and keeps a classic fallback', () => {
  const handler = read('tgcloud/lib/economy_handler.js');
  const branch = handler.slice(
    handler.indexOf("} else if (cmd === 'search_tsuna') {"),
    handler.indexOf("} else if (cmd === 'claim' || cmd === 'daily') {"),
  );
  assert.match(branch, /sendRich\(message\.chat\.id, \{/, 'rich message first');
  assert.match(branch, /rich_message: \{ blocks: out\.blocks, skip_entity_detection: false \}/);
  assert.match(branch, /text: style\(out\.text \|\| ''\)/, 'classic fallback keeps the same words');
  assert.match(handler, /import \{ send, sendRich, sweepMessages, trackUser \} from '\.\/chat\.js';/);
});

test('search progress card end to end (divider, quote, bold timer)', () => {
  const output = execFileSync(
    process.execPath,
    ['--experimental-loader', './test/helpers/sdk-loader.mjs', 'test/helpers/run_search_progress.mjs'],
    { cwd: new URL('..', import.meta.url), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  assert.match(output, /search progress: OK/);
});
