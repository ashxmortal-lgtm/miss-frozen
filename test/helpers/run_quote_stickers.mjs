// /q and /own — quote stickers.
//
// Everything runs against the in-memory SDK stub: no network, no credentials.
// The assertions cover extraction, rendering, the Telegram upload workflow, the
// pack database row, and the failure paths (timeout, full pack, invalid name).
import assert from 'node:assert/strict';
import { api, BotApiError } from 'sdk';
import { db, sql } from './sdk_db_stub.mjs';
import { readPngHeader } from '../../tgcloud/lib/quote/png.js';
import { renderQuotePng, wrapText } from '../../tgcloud/lib/quote/render.js';
import { normalizeText } from '../../tgcloud/lib/quote/font.js';
import { extractQuote } from '../../tgcloud/lib/quote/extract.js';
import {
  buildPackName, buildPackTitle, packSuffix, MAX_STATIC_STICKERS, ownQuote,
} from '../../tgcloud/lib/quote/packs.js';
import {
  handleQuoteCommand, parseQuoteCommand, addressedToUs,
} from '../../tgcloud/lib/quote_stickers.js';

await db.run(sql.raw(`CREATE TABLE IF NOT EXISTS quote_sticker_packs (
  telegram_id INTEGER PRIMARY KEY,
  set_name TEXT NOT NULL,
  title TEXT NOT NULL,
  sticker_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'creating',
  last_error TEXT,
  created_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
)`));
await db.run(sql.raw('CREATE UNIQUE INDEX IF NOT EXISTS uidx_quote_pack_name ON quote_sticker_packs (set_name)'));

// ---- mocked Bot API -------------------------------------------------------
const calls = { stickers: [], messages: [], creates: [], adds: [], sets: {} };
let nextCreateError = null;
let nextAddError = null;
let getStickerSetError = null;

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

api.sendSticker = async (payload) => {
  calls.stickers.push(payload);
  return { message_id: 500 + calls.stickers.length };
};
api.sendMessage = async (payload) => {
  calls.messages.push(payload);
  return { message_id: calls.messages.length };
};
api.createNewStickerSet = async (payload) => {
  calls.creates.push(payload);
  await tick();
  if (nextCreateError) {
    const error = nextCreateError;
    nextCreateError = null;
    throw error;
  }
  calls.sets[payload.name] = { name: payload.name, stickers: [{ file_id: 'x' }] };
  return true;
};
api.addStickerToSet = async (payload) => {
  calls.adds.push(payload);
  await tick();
  if (nextAddError) {
    const error = nextAddError;
    nextAddError = null;
    throw error;
  }
  const set = calls.sets[payload.name] || { name: payload.name, stickers: [] };
  set.stickers.push({ file_id: `s${set.stickers.length}` });
  calls.sets[payload.name] = set;
  return true;
};
api.getStickerSet = async ({ name }) => {
  await tick();
  if (getStickerSetError) {
    const error = getStickerSetError;
    getStickerSetError = null;
    throw error;
  }
  const set = calls.sets[name];
  if (!set) throw new BotApiError('Bad Request: STICKERSET_INVALID');
  return set;
};
api.getMe = async () => ({ id: 8888370613, username: 'missfrozen_bot' });

const reset = async () => {
  calls.stickers.length = 0;
  calls.messages.length = 0;
  calls.creates.length = 0;
  calls.adds.length = 0;
  for (const key of Object.keys(calls.sets)) delete calls.sets[key];
  nextCreateError = null;
  nextAddError = null;
  getStickerSetError = null;
  await db.run(sql.raw('DELETE FROM quote_sticker_packs'));
};

const user = (id = 42, extra = {}) => ({ id, first_name: 'Kakashi', username: 'kakashi', is_bot: false, ...extra });

const commandMessage = ({ text = '/q', from = user(), reply = null, chatType = 'private' } = {}) => ({
  message_id: 1000,
  chat: { id: -1001234, type: chatType },
  from,
  text,
  reply_to_message: reply,
});

const textReply = (text, from = user(7, { first_name: 'Sakura', username: 'sakura' })) => ({
  message_id: 900,
  from,
  text,
  chat: { id: -1001234, type: 'group' },
  date: 1700000000,
});

const lastMessage = () => calls.messages.at(-1)?.text || '';

// ---- 1. command parsing ---------------------------------------------------
assert.deepEqual(parseQuoteCommand('/q'), { command: 'q', atBot: null });
assert.deepEqual(parseQuoteCommand('/Q@missfrozen_bot'), { command: 'q', atBot: 'missfrozen_bot' });
assert.deepEqual(parseQuoteCommand('/own extra args'), { command: 'own', atBot: null });
assert.equal(parseQuoteCommand('/qwerty'), null);
assert.equal(parseQuoteCommand('/quote'), null);
assert.equal(parseQuoteCommand('hello'), null);
assert.equal(parseQuoteCommand('/map'), null);
assert.equal(addressedToUs('missfrozen_bot'), true);
assert.equal(addressedToUs('MISSFROZEN_BOT'), true);
assert.equal(addressedToUs('other_bot'), false);
assert.equal(addressedToUs(null), true);

// A command addressed to another bot is not consumed.
await reset();
assert.equal(await handleQuoteCommand(commandMessage({ text: '/q@other_bot', reply: textReply('hi') })), false);
assert.equal(calls.stickers.length, 0);

// Unrelated text is never consumed and produces no output.
assert.equal(await handleQuoteCommand(commandMessage({ text: 'hello there' })), false);
assert.equal(calls.messages.length, 0);

// ---- 2. /q without a reply ------------------------------------------------
await reset();
assert.equal(await handleQuoteCommand(commandMessage({ text: '/q' })), true);
assert.equal(calls.stickers.length, 0, 'no sticker without a reply');
assert.match(lastMessage(), /reply to a message/i);

await reset();
assert.equal(await handleQuoteCommand(commandMessage({ text: '/own' })), true);
assert.match(lastMessage(), /reply to a message/i);
assert.equal(calls.creates.length, 0);

// ---- 3. /q with a text reply ---------------------------------------------
await reset();
assert.equal(await handleQuoteCommand(commandMessage({ text: '/q', reply: textReply('Rasengan is not a toy.') })), true);
assert.equal(calls.stickers.length, 1);
const sticker = calls.stickers[0];
assert.equal(sticker.chat_id, -1001234, 'sticker goes to the same chat');
const bytes = sticker.sticker.value;
const header = readPngHeader(bytes);
assert.equal(header.width, 512, 'one side must be exactly 512');
assert.ok(header.height <= 512, 'other side ≤ 512');
assert.equal(header.colorType, 3, 'indexed PNG');
assert.ok(bytes.length <= 512 * 1024, `sticker under 512 KB (got ${bytes.length})`);
assert.equal(sticker.sticker.filename, 'quote.png');
assert.equal(calls.creates.length, 0, '/q never creates a pack');

// ---- 4. /q with a photo + caption ---------------------------------------
await reset();
const photoReply = {
  ...textReply(''),
  text: undefined,
  caption: 'Konoha at dawn 🌅',
  caption_entities: [],
  photo: [{ file_id: 'small' }, { file_id: 'large' }],
};
assert.equal(await handleQuoteCommand(commandMessage({ text: '/q', reply: photoReply })), true);
assert.equal(calls.stickers.length, 1);
const photoQuote = extractQuote(photoReply);
assert.equal(photoQuote.ok, true);
assert.equal(photoQuote.text, 'Konoha at dawn 🌅');
assert.equal(photoQuote.mediaKind, 'photo');
assert.equal(photoQuote.kind, '', 'a caption needs no media label');

// ---- 5. media with no caption is labelled, not faked --------------------
await reset();
const voiceReply = { message_id: 901, from: user(8, { first_name: 'Naruto' }), voice: { file_id: 'v' }, chat: { id: 1 } };
assert.equal(await handleQuoteCommand(commandMessage({ text: '/q', reply: voiceReply })), true);
assert.equal(calls.stickers.length, 1);
assert.equal(extractQuote(voiceReply).kind, 'Voice message');

const stickerReply = { message_id: 902, from: user(9, { first_name: 'Itachi' }), sticker: { emoji: '🥀', file_id: 's' }, chat: { id: 1 } };
assert.equal(extractQuote(stickerReply).kind, '🥀 Sticker');
assert.equal(extractQuote(stickerReply).ok, true);

// A reply with neither text nor media cannot be quoted.
await reset();
assert.equal(await handleQuoteCommand(commandMessage({ text: '/q', reply: { message_id: 903, from: user(10), chat: { id: 1 } } })), true);
assert.equal(calls.stickers.length, 0);
assert.match(lastMessage(), /nothing to quote/i);

// Messages from channels/bots have no quotable author.
await reset();
assert.equal(await handleQuoteCommand(commandMessage({
  text: '/q',
  reply: { message_id: 904, from: { id: 1, is_bot: true, first_name: 'Bot' }, text: 'beep', chat: { id: 1 } },
})), true);
assert.equal(calls.stickers.length, 0);
assert.match(lastMessage(), /no author/i);

// ---- 6. extraction details ----------------------------------------------
// Entities are flattened, never rendered as markup.
const entityQuote = extractQuote({
  message_id: 905,
  from: user(11, { first_name: 'Hinata', username: undefined }),
  text: 'Look at https://example.com now',
  entities: [{ type: 'text_link', offset: 8, length: 19, url: 'https://example.com' }],
  chat: { id: 1 },
});
assert.equal(entityQuote.ok, true);
assert.equal(entityQuote.text, 'Look at https://example.com now');
assert.equal(entityQuote.handle, '');

// HTML-looking text stays literal data for the renderer.
const htmlish = extractQuote({ message_id: 906, from: user(12), text: '<b>bold</b> & <script>x()</script>', chat: { id: 1 } });
assert.equal(htmlish.ok, true);
assert.ok(htmlish.text.includes('<script>'), 'content is preserved verbatim, never parsed');

// Very long text is truncated, and blank-line runs collapse.
const longText = `${'あ'.repeat(20)}\n\n\n\n${'word '.repeat(400)}`;
const longQuote = extractQuote({ message_id: 907, from: user(13), text: longText, chat: { id: 1 } });
assert.equal(longQuote.truncated, true);
assert.ok(longQuote.text.length <= 900);
assert.ok(!longQuote.text.includes('\n\n\n'), 'blank runs collapse');

// ---- 7. font + wrapping --------------------------------------------------
assert.equal(normalizeText('hello'), 'HELLO');
assert.equal(normalizeText('“quoted” — dash …'), '"QUOTED" - DASH ...');
assert.equal(normalizeText('🐸'), '', 'emoji are dropped, not turned into "?"');
assert.equal(normalizeText('Konoha 🌅 at dawn'), 'KONOHA  AT DAWN');
assert.equal(normalizeText('मैं'), '?', 'unsupported scripts keep one placeholder per run');
assert.ok(normalizeText('a\nb').includes('\n'));

const wrapped = wrapText('the quick brown fox jumps over the lazy dog', 40);
assert.ok(wrapped.length > 1, 'long lines wrap');
for (const line of wrapped) assert.ok(line.length < 40);

const hard = wrapText('A'.repeat(80), 20);
assert.ok(hard.length >= 4, 'over-long words hard-break');
assert.equal(wrapText('a\nb', 200).length, 2, 'explicit newlines are honoured');

// ---- 8. rendering variants ----------------------------------------------
const shortPng = renderQuotePng({ text: 'gg', name: 'Sakura' });
assert.equal(shortPng.width, 512);
assert.ok(shortPng.height >= 360 && shortPng.height <= 512);
assert.equal(readPngHeader(shortPng.bytes).width, 512);

const longPng = renderQuotePng({ text: 'long '.repeat(600), name: 'A'.repeat(60) });
assert.equal(longPng.height, 512, 'over-long text clamps to the maximum height');
assert.ok(longPng.bytes.length <= 512 * 1024);
assert.equal(longPng.clipped, true);

const unicodePng = renderQuotePng({ text: 'नमस्ते 🐸 “quotes” — ok', name: 'ナルト' });
assert.equal(readPngHeader(unicodePng.bytes).height <= 512, true);
assert.ok(unicodePng.bytes.length > 1000);

// Emoji are decorative: they never fill the card with "?".
const emojiPng = renderQuotePng({ text: 'Konoha at dawn 🌅❄️✨', name: 'Kakashi' });
assert.equal(emojiPng.unsupportedScript, false, 'a Latin quote with emoji needs no note');

// A quote made only of emoji falls back to a label instead of an empty card.
const onlyEmoji = renderQuotePng({ text: '😂😂😂', name: 'Naruto' });
assert.equal(onlyEmoji.label, 'Emoji');
assert.equal(onlyEmoji.lines.length, 0);

// Unsupported script: rendered honestly with a note, and a Latin name fallback.
const hindiPng = renderQuotePng({ text: 'मैं हूँ कोनोहा का हॉक!', name: 'जिरैया', handle: '@jiraiya' });
assert.equal(hindiPng.unsupportedScript, true, 'the card says the script is unsupported');
assert.ok(hindiPng.lines.length >= 1);

// Identical input renders identical bytes (no hidden state).
const a = renderQuotePng({ text: 'same', name: 'Same' });
const b = renderQuotePng({ text: 'same', name: 'Same' });
assert.equal(Buffer.compare(Buffer.from(a.bytes), Buffer.from(b.bytes)), 0);

// ---- 9. pack naming ------------------------------------------------------
assert.equal(packSuffix('@missfrozen_bot'), '_by_missfrozen_bot');
assert.equal(packSuffix('x'), null);
const name = buildPackName(42, 'missfrozen_bot');
assert.match(name, /_by_missfrozen_bot$/);
assert.ok(name.length <= 64);
assert.equal(buildPackName(42, ''), null);
assert.equal(buildPackTitle('Kakashi Hatake'), 'Kakashi Hatake quotes');
assert.ok(buildPackTitle('x'.repeat(200)).length <= 64);

// ---- 10. /own — first use creates the pack ------------------------------
await reset();
assert.equal(await handleQuoteCommand(commandMessage({ text: '/own', reply: textReply('First quote!') })), true);
assert.equal(calls.creates.length, 1, 'first /own creates a set');
assert.equal(calls.adds.length, 0, 'creation uploads the first sticker');
const created = calls.creates[0];
assert.equal(created.user_id, 42, 'pack owner is the invoker');
assert.equal(created.name, buildPackName(42, 'missfrozen_bot'));
assert.equal(created.title, 'Kakashi quotes');
assert.equal(created.stickers.length, 1);
assert.equal(created.stickers[0].format, 'static');
assert.ok(created.stickers[0].sticker.value.length > 1000);
assert.match(lastMessage(), /addstickers/);
assert.match(lastMessage(), /created/i);

const rowAfter = await db.get(sql`SELECT * FROM quote_sticker_packs WHERE telegram_id = 42`);
assert.equal(rowAfter.status, 'ready');
assert.equal(rowAfter.sticker_count, 1);
assert.equal(rowAfter.set_name, created.name);

// ---- 11. /own — second use adds to the same pack ------------------------
assert.equal(await handleQuoteCommand(commandMessage({ text: '/own', reply: textReply('Second quote!') })), true);
assert.equal(calls.creates.length, 1, 'no second pack');
assert.equal(calls.adds.length, 1, 'sticker added to the existing pack');
assert.equal(calls.adds[0].name, created.name);
assert.equal(calls.adds[0].user_id, 42);
const rowAfter2 = await db.get(sql`SELECT * FROM quote_sticker_packs WHERE telegram_id = 42`);
assert.equal(rowAfter2.sticker_count, 2);
assert.match(lastMessage(), /saved/i);

// ---- 12. different users get different packs ---------------------------
await reset();
await handleQuoteCommand(commandMessage({ text: '/own', from: user(77, { first_name: 'Hinata' }), reply: textReply('mine') }));
assert.equal(calls.creates.length, 1);
assert.equal(calls.creates[0].user_id, 77);
assert.match(calls.creates[0].name, /^frozen_quotes77_by_missfrozen_bot$/);

// ---- 13. concurrent first /own never creates two packs ------------------
await reset();
const concurrent = await Promise.all([
  ownQuote({ userId: 555, displayName: 'Race', botUsername: 'missfrozen_bot', pngBytes: shortPng.bytes }),
  ownQuote({ userId: 555, displayName: 'Race', botUsername: 'missfrozen_bot', pngBytes: shortPng.bytes }),
]);
assert.equal(calls.creates.length, 1, 'exactly one createNewStickerSet');
const rows = await db.all(sql`SELECT * FROM quote_sticker_packs WHERE telegram_id = 555`);
assert.equal(rows.length, 1, 'one row per user');
assert.equal(rows[0].set_name, buildPackName(555, 'missfrozen_bot'));
assert.ok(concurrent.some((r) => r.ok), 'at least one invocation succeeds');

// ---- 14. timeout on create → reconcile with getStickerSet --------------
await reset();
const timeoutError = Object.assign(new BotApiError('timeout'), { description: 'Request timeout' });
// First: the set was NOT created remotely → the claim is released for a retry.
nextCreateError = timeoutError;
const timedOut = await ownQuote({ userId: 666, displayName: 'Slow', botUsername: 'missfrozen_bot', pngBytes: shortPng.bytes });
assert.equal(timedOut.ok, false);
assert.equal(timedOut.code, 'unclear');
const released = await db.get(sql`SELECT * FROM quote_sticker_packs WHERE telegram_id = 666`);
assert.equal(released, null, 'claim released so a retry can start over');

// Second: the set WAS created remotely but the response was lost.
await reset();
nextCreateError = timeoutError;
calls.sets[buildPackName(666, 'missfrozen_bot')] = { name: buildPackName(666, 'missfrozen_bot'), stickers: [{ file_id: 'a' }] };
const reconciled = await ownQuote({ userId: 666, displayName: 'Slow', botUsername: 'missfrozen_bot', pngBytes: shortPng.bytes });
assert.equal(reconciled.ok, true, 'a timeout is reconciled, not reported as failure');
assert.equal(reconciled.created, true);
assert.match(reconciled.url, /addstickers/);
assert.equal(calls.creates.length, 1);

// ---- 15. full pack ------------------------------------------------------
await reset();
calls.sets[buildPackName(888, 'missfrozen_bot')] = { name: buildPackName(888, 'missfrozen_bot'), stickers: [] };
await db.run(sql`INSERT INTO quote_sticker_packs (telegram_id, set_name, title, sticker_count, status)
  VALUES (888, ${buildPackName(888, 'missfrozen_bot')}, 'Full quotes', ${MAX_STATIC_STICKERS}, 'ready')`);
const full = await ownQuote({ userId: 888, displayName: 'Full', botUsername: 'missfrozen_bot', pngBytes: shortPng.bytes });
assert.equal(full.ok, false);
assert.equal(full.code, 'full');
assert.equal(calls.adds.length, 0, 'nothing uploaded to a full pack');

await reset();
assert.equal(await handleQuoteCommand(commandMessage({ text: '/own', from: user(999, { first_name: 'Full' }), reply: textReply('x') })), true);
await db.run(sql`UPDATE quote_sticker_packs SET sticker_count = ${MAX_STATIC_STICKERS} WHERE telegram_id = 999`);
assert.equal(await handleQuoteCommand(commandMessage({ text: '/own', from: user(999, { first_name: 'Full' }), reply: textReply('y') })), true);
assert.match(lastMessage(), /full/i);
assert.match(lastMessage(), /addstickers/, 'the full-pack message still links the pack');

// ---- 16. upload failure does not claim success -------------------------
await reset();
await handleQuoteCommand(commandMessage({ text: '/own', reply: textReply('seed') }));
calls.messages.length = 0;
nextAddError = new BotApiError('Bad Request: STICKER_FILE_INVALID');
await handleQuoteCommand(commandMessage({ text: '/own', reply: textReply('again') }));
assert.doesNotMatch(lastMessage(), /saved/i, 'a failed upload is not reported as saved');

// ---- 17. invalid bot username ------------------------------------------
await reset();
const badBot = await ownQuote({ userId: 10, displayName: 'X', botUsername: 'x', pngBytes: shortPng.bytes });
assert.equal(badBot.ok, false);
assert.equal(badBot.code, 'bad_bot_username');

// ---- 18. the schema and registry stay compatible -----------------------
const { QUOTE_COMMANDS } = await import('../../tgcloud/lib/quote_stickers.js');
assert.deepEqual([...QUOTE_COMMANDS].sort(), ['own', 'q']);
const { COMMANDS } = await import('../../tgcloud/lib/command_registry.js');
const qEntry = COMMANDS.find((c) => c.cmd === '/q');
const ownEntry = COMMANDS.find((c) => c.cmd === '/own');
assert.ok(qEntry && ownEntry, '/q and /own are in the command registry');
assert.equal(qEntry.access, 'user');
assert.equal(ownEntry.access, 'user');
assert.equal(COMMANDS.filter((c) => c.cmd === '/q').length, 1, 'no duplicate /q alias');
assert.equal(COMMANDS.filter((c) => c.cmd === '/own').length, 1, 'no duplicate /own alias');
const { helpText } = await import('../../tgcloud/lib/help.js');
const help = helpText({ id: 1 });
assert.match(help, /\/q — /);
assert.match(help, /\/own — /);

console.log('quote stickers: OK');
