// /search_tsuna — the "SEARCH IN PROGRESS" card: heading on top, rich divider,
// and every line below the heading quoted.
import assert from 'node:assert/strict';
import { db } from './sdk_db_stub.mjs';
import {
  searchProgressContent, handleSearchTsuna,
} from '../../tgcloud/lib/rpg/tsunade.js';

// Mathematical bold digits (U+1D7CE..U+1D7D7) for every time on the card.
const BOLD = Array.from({ length: 10 }, (_, d) => String.fromCodePoint(0x1D7CE + d));
const bold = (text) => String(text).replace(/\d/g, (d) => BOLD[Number(d)]);

// 25 Oct 2026, 14:30 IST (09:00 UTC).
const ENDS_AT = Math.floor(Date.UTC(2026, 9, 25, 9, 0, 0) / 1000);
const T = ENDS_AT - (2 * 3600 + 26 * 60); // 12:04 IST → 2h 26m left

const row = { status: 'active', startedAt: T - 3600, endsAt: ENDS_AT, totalSearches: 3 };
const card = searchProgressContent(row, T);

// ---- 1. heading, divider, quoted lines -------------------------------------
assert.equal(card.blocks.length, 3, 'heading + divider + quote');
assert.deepEqual(card.blocks[0], { type: 'paragraph', text: '🔎 𝐒𝐄𝐀𝐑𝐂𝐇 𝐈𝐍 𝐏𝐑𝐎𝐆𝐑𝐄𝐒𝐒' },
  'the heading stays outside the quote');
assert.deepEqual(card.blocks[1], { type: 'divider' }, 'a real Telegram rich divider');
const quoteBlock = card.blocks[2];
assert.equal(quoteBlock.type, 'blockquote', 'everything below the heading is quoted');
assert.equal(quoteBlock.blocks.length, 3, 'three quoted lines');
const line = (i) => quoteBlock.blocks[i].text;
assert.equal(line(0), '🍥 ɴᴀʀᴜᴛᴏ ᴀɴᴅ 🐸 ᴊɪʀᴀɪʏᴀ ᴀʀᴇ ᴏɴ ᴛʜᴇ ʜᴜɴᴛ ꜰᴏʀ ʟᴀᴅʏ ᴛꜱᴜɴᴀᴅᴇ!');
assert.equal(line(1), `⏳ 𝐂𝐎𝐌𝐏𝐋𝐄𝐓𝐄𝐒 𝐀𝐓 ${bold('14:30')} 𝐈𝐒𝐓`, 'bold IST completion time');
assert.equal(line(2), `🕒 ᴛɪᴍᴇ ʟᴇꜰᴛ: ${bold('2')}ʜ ${bold('26')}ᴍ`, 'bold countdown');
for (const block of quoteBlock.blocks) assert.equal(block.type, 'paragraph');

// ---- 2. classic fallback keeps the same words, without the rich divider ----
assert.match(card.text, /^🔎 𝐒𝐄𝐀𝐑𝐂𝐇 𝐈𝐍 𝐏𝐑𝐎𝐆𝐑𝐄𝐒𝐒\n\n<blockquote>/, 'heading, then the quote');
assert.match(card.text, /<blockquote>[\s\S]*🍥 ɴᴀʀᴜᴛᴏ ᴀɴᴅ 🐸 ᴊɪʀᴀɪʏᴀ[\s\S]*<\/blockquote>/);
assert.ok(card.text.includes(`⏳ 𝐂𝐎𝐌𝐏𝐋𝐄𝐓𝐄𝐒 𝐀𝐓 ${bold('14:30')} 𝐈𝐒𝐓`), 'same completion line');
assert.ok(card.text.includes(`🕒 ᴛɪᴍᴇ ʟᴇꜰᴛ: ${bold('2')}ʜ ${bold('26')}ᴍ`), 'same countdown line');
assert.doesNotMatch(card.text, /divider/, 'no rich marker in the classic text');

// ---- 3. a completion on another IST day keeps the date ---------------------
const tomorrow = searchProgressContent(
  { endsAt: ENDS_AT + 24 * 3600, totalSearches: 1 },
  ENDS_AT - 3600,
);
assert.equal(tomorrow.blocks[2].blocks[1].text,
  `⏳ 𝐂𝐎𝐌𝐏𝐋𝐄𝐓𝐄𝐒 𝐀𝐓 ${bold('26')} ᴏᴄᴛ, ${bold('14:30')} 𝐈𝐒𝐓`,
  'next-day searches show the date');

// ---- 4. the live command returns the card while a search runs --------------
await db.run({
  text: `CREATE TABLE IF NOT EXISTS users (telegram_id INTEGER PRIMARY KEY, first_name TEXT)`,
  params: [],
});
await db.run({
  text: `CREATE TABLE IF NOT EXISTS inventory (
    telegram_id INTEGER, item_type TEXT, item_name TEXT, qty INTEGER DEFAULT 1)`,
  params: [],
});
await db.run({
  text: `CREATE TABLE IF NOT EXISTS tsunade_search (
    id INTEGER PRIMARY KEY AUTOINCREMENT, telegram_id INTEGER UNIQUE, status TEXT,
    started_at INTEGER DEFAULT 0, ends_at INTEGER DEFAULT 0, day_key TEXT,
    day_count INTEGER DEFAULT 0, total_searches INTEGER DEFAULT 0,
    found INTEGER DEFAULT 0, found_at INTEGER DEFAULT 0)`,
  params: [],
});

const SEARCHER = 5001;
await db.run({
  text: `INSERT OR REPLACE INTO users (telegram_id, first_name) VALUES (?, 'Hunter')`,
  params: [SEARCHER],
});
for (const name of ['Naruto', 'Jiraiya']) {
  await db.run({
    text: `INSERT OR IGNORE INTO inventory (telegram_id, item_type, item_name, qty)
           VALUES (?, 'shinobi', ?, 1)`,
    params: [SEARCHER, name],
  });
}
const nowSec = Math.floor(Date.now() / 1000);
await db.run({
  text: `INSERT OR REPLACE INTO tsunade_search
           (telegram_id, status, started_at, ends_at, day_key, day_count, total_searches, found)
         VALUES (?, 'active', ?, ?, '2026-10-25', 1, 4, 0)`,
  params: [SEARCHER, nowSec - 60, nowSec + 6 * 3600],
});

const out = await handleSearchTsuna({
  from: { id: SEARCHER, first_name: 'Hunter' },
  chat: { id: -900, type: 'supergroup', title: 'Leaf' },
  text: '/search_tsuna',
});
assert.ok(out && typeof out === 'object' && Array.isArray(out.blocks), 'the rich card is returned');
assert.equal(out.blocks[0].text, '🔎 𝐒𝐄𝐀𝐑𝐂𝐇 𝐈𝐍 𝐏𝐑𝐎𝐆𝐑𝐄𝐒𝐒');
assert.equal(out.blocks[1].type, 'divider');
assert.equal(out.blocks[2].type, 'blockquote');
assert.match(out.blocks[2].blocks[2].text,
  /🕒 ᴛɪᴍᴇ ʟᴇꜰᴛ: [\u{1D7CE}-\u{1D7D7}]{1,2}ʜ( [\u{1D7CE}-\u{1D7D7}]{2}ᴍ)?$/u,
  'live countdown');

console.log('search progress: OK');
