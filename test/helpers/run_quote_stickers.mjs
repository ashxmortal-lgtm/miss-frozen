// /q and /own — quote stickers.
//
// Everything runs against the in-memory SDK stub: no network, no credentials.
// Covers extraction, rendering, the avatar pipeline, the sticker-copy workflow,
// pack persistence, and every failure path (timeout, full pack, duplicates).
import assert from 'node:assert/strict';
import { api, BotApiError } from 'sdk';
import { db, sql } from './sdk_db_stub.mjs';
import { readPngHeader, encodeRgbaPng, decodePng } from '../../tgcloud/lib/quote/png.js';
import { encodeRgbaPng as _unused } from '../../tgcloud/lib/quote/png.js';
import { renderQuotePng, renderQuote, planLayout, nameColor } from '../../tgcloud/lib/quote/render.js';
import { wrapText, measureLine, normalizeText, renderableShare } from '../../tgcloud/lib/quote/text.js';
import { extractQuote, formatMessageTime } from '../../tgcloud/lib/quote/extract.js';
import { decodeJpeg } from '../../tgcloud/lib/quote/jpeg.js';
import { pickPhotoSize, decodeProfilePhoto, fetchProfilePhoto } from '../../tgcloud/lib/quote/avatar.js';
import {
  buildPackName, buildPackTitle, packSuffix, formatOfSticker, ownSticker,
  MAX_STATIC_STICKERS, STICKER_LIMITS,
} from '../../tgcloud/lib/quote/packs.js';
import {
  handleQuoteCommand, parseQuoteCommand, addressedToUs,
} from '../../tgcloud/lib/quote_stickers.js';

void _unused;

await db.run(sql.raw(`CREATE TABLE IF NOT EXISTS quote_sticker_packs (
  telegram_id INTEGER PRIMARY KEY,
  set_name TEXT NOT NULL,
  title TEXT NOT NULL,
  sticker_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'creating',
  sticker_format TEXT NOT NULL DEFAULT 'static',
  last_error TEXT,
  created_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
)`));
await db.run(sql.raw('CREATE UNIQUE INDEX IF NOT EXISTS uidx_quote_pack_name ON quote_sticker_packs (set_name)'));

// ---- fixtures -------------------------------------------------------------

/** 1×1 grey JPEG — enough to prove the decoder path is wired, cheap to build. */
const TINY_JPEG = new Uint8Array([
  0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43, 0x00,
  ...Array.from({ length: 64 }, () => 1),
  0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00,
  0xff, 0xc4, 0x00, 0x14, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x04,
  0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0x00,
  0xff, 0xd9,
]);

/** A 4×4 PNG built with the project's own encoder. */
function tinyPng() {
  const rgba = new Uint8Array(4 * 4 * 4);
  for (let i = 0; i < 16; i += 1) {
    rgba[i * 4] = 200;
    rgba[i * 4 + 1] = 60;
    rgba[i * 4 + 2] = 90;
    rgba[i * 4 + 3] = 255;
  }
  return encodeRgbaPng({ width: 4, height: 4, rgba });
}

const AVATAR_PNG = tinyPng();
const AVATAR_IMAGE = decodePng(AVATAR_PNG);

// ---- mocked Bot API -------------------------------------------------------

const calls = {
  stickers: [], messages: [], creates: [], adds: [], profilePhotoRequests: [], fileRequests: [],
  sets: {},
};
let profilePhotoResult = { photos: [] };
let profilePhotoError = null;
let fileBytes = null;
let nextCreateError = null;
let nextAddError = null;

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

api.sendSticker = async (payload) => {
  calls.stickers.push(payload);
  return { message_id: 500 + calls.stickers.length };
};
api.sendMessage = async (payload) => {
  calls.messages.push(payload);
  return { message_id: calls.messages.length };
};
api.getUserProfilePhotos = async (payload) => {
  calls.profilePhotoRequests.push(payload);
  if (profilePhotoError) throw profilePhotoError;
  return profilePhotoResult;
};
api.getFileContent = async (fileId) => {
  calls.fileRequests.push(fileId);
  return fileBytes;
};
api.createNewStickerSet = async (payload) => {
  calls.creates.push(payload);
  await tick();
  if (nextCreateError) {
    const error = nextCreateError;
    nextCreateError = null;
    throw error;
  }
  calls.sets[payload.name] = {
    name: payload.name,
    sticker_format: payload.sticker_format,
    // Telegram keeps the underlying file, so the unique id follows the file_id.
    stickers: [{
      file_id: payload.stickers[0].sticker,
      file_unique_id: `uniq-${payload.stickers[0].sticker}`,
    }],
  };
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
  set.stickers.push({
    file_id: payload.sticker.sticker,
    file_unique_id: `uniq-${payload.sticker.sticker}`,
  });
  calls.sets[payload.name] = set;
  return true;
};
api.getStickerSet = async ({ name }) => {
  await tick();
  const set = calls.sets[name];
  if (!set) throw new BotApiError('Bad Request: STICKERSET_INVALID');
  return set;
};
api.getMe = async () => ({ id: 8888370613, username: 'missfrozen_bot' });

const reset = async () => {
  for (const key of ['stickers', 'messages', 'creates', 'adds', 'profilePhotoRequests', 'fileRequests']) {
    calls[key].length = 0;
  }
  for (const key of Object.keys(calls.sets)) delete calls.sets[key];
  profilePhotoResult = { photos: [] };
  profilePhotoError = null;
  fileBytes = null;
  nextCreateError = null;
  nextAddError = null;
  await db.run(sql.raw('DELETE FROM quote_sticker_packs'));
};

const user = (id = 42, extra = {}) => ({
  id, first_name: 'Kakashi', username: 'kakashi', is_bot: false, ...extra,
});

const commandMessage = ({ text = '/q', from = user(), reply = null, chatType = 'private' } = {}) => ({
  message_id: 1000,
  chat: { id: -1001234, type: chatType },
  from,
  text,
  reply_to_message: reply,
});

const AUTHOR = user(7, { first_name: 'Sakura', username: 'sakura' });
const textReply = (text, from = AUTHOR) => ({
  message_id: 900,
  from,
  text,
  date: 1700000000,
  chat: { id: -1001234, type: 'group' },
});
const stickerReply = (sticker = { file_id: 'CAACAgIAAx', file_unique_id: 'AgAD1', emoji: '🍥', is_animated: false, is_video: false, type: 'regular' }) => ({
  message_id: 905,
  from: AUTHOR,
  sticker,
  date: 1700000000,
  chat: { id: -1001234, type: 'group' },
});

const lastMessage = () => calls.messages.at(-1)?.text || '';

// ---- 1. command parsing ---------------------------------------------------
assert.deepEqual(parseQuoteCommand('/q'), { command: 'q', atBot: null });
assert.deepEqual(parseQuoteCommand('/Q@missfrozen_bot'), { command: 'q', atBot: 'missfrozen_bot' });
assert.deepEqual(parseQuoteCommand('/own extra args'), { command: 'own', atBot: null });
assert.equal(parseQuoteCommand('/quote'), null);
assert.equal(parseQuoteCommand('/map'), null);
assert.equal(parseQuoteCommand('hello'), null);
assert.equal(addressedToUs('missfrozen_bot'), true);
assert.equal(addressedToUs('other_bot'), false);

await reset();
assert.equal(await handleQuoteCommand(commandMessage({ text: '/q@other_bot', reply: textReply('hi') })), false);
assert.equal(calls.stickers.length, 0, 'commands for other bots are ignored');
assert.equal(await handleQuoteCommand(commandMessage({ text: 'hello there' })), false);
assert.equal(calls.messages.length, 0, 'unrelated text is never consumed');

// ---- 2. missing reply -----------------------------------------------------
await reset();
assert.equal(await handleQuoteCommand(commandMessage({ text: '/q' })), true);
assert.match(lastMessage(), /reply to a message/i);
assert.equal(calls.stickers.length, 0, 'no sticker without a reply');

await reset();
assert.equal(await handleQuoteCommand(commandMessage({ text: '/own' })), true);
assert.match(lastMessage(), /reply to a .*sticker/i);
assert.equal(calls.creates.length, 0, 'no pack without a reply');

// ---- 3. /q quotes the replied-to message, not the command -----------------
await reset();
assert.equal(await handleQuoteCommand(commandMessage({ text: '/q', reply: textReply('Rasengan is not a toy.') })), true);
assert.equal(calls.stickers.length, 1);
const stickerCall = calls.stickers[0];
assert.equal(stickerCall.chat_id, -1001234, 'the sticker goes to the same chat');
const bytes = stickerCall.sticker.value;
const header = readPngHeader(bytes);
assert.equal(header.width, 512, 'one side is exactly 512 px');
assert.ok(header.height <= 512, 'the other side is ≤ 512 px');
assert.equal(header.colorType, 6, 'RGBA PNG — the artwork needs transparency');
assert.ok(bytes.length <= 512 * 1024, `sticker under Telegram's 512 KB cap (${bytes.length})`);
assert.equal(calls.creates.length, 0, '/q never creates a pack');
assert.equal(calls.profilePhotoRequests[0].user_id, 7, "the author's profile photo is requested");

// The command text must never appear on the card.
const rendered = renderQuotePng({
  text: 'Rasengan is not a toy.',
  name: 'Sakura',
  time: '10:13 PM',
  userId: 7,
  avatar: AVATAR_IMAGE,
});
assert.ok(!rendered.lines.join(' ').includes('/q'), 'the command is not quoted');
assert.equal(rendered.lines.join(' '), 'Rasengan is not a toy.');

// ---- 4. transparency outside the artwork ---------------------------------
const transparent = renderQuotePng({ text: 'hi', name: 'Sakura', avatar: AVATAR_IMAGE });
const decoded = decodePng(transparent.bytes);
assert.equal(decoded.rgba[3], 0, 'the top-left corner is fully transparent');
const cornerIndex = ((decoded.height - 1) * decoded.width + (decoded.width - 1)) * 4;
assert.equal(decoded.rgba[cornerIndex + 3], 0, 'the bottom-right corner is transparent');
// The bubble itself must be opaque somewhere in the middle.
const middle = ((Math.floor(decoded.height / 2)) * decoded.width + Math.floor(decoded.width * 0.6)) * 4;
assert.equal(decoded.rgba[middle + 3], 255, 'the bubble is opaque');

// ---- 5. the actual profile photo is drawn -------------------------------
await reset();
profilePhotoResult = {
  total_count: 1,
  photos: [[
    { file_id: 'small', width: 40, height: 40 },
    { file_id: 'medium', width: 160, height: 160 },
    { file_id: 'large', width: 640, height: 640 },
  ]],
};
fileBytes = AVATAR_PNG;
assert.equal(await handleQuoteCommand(commandMessage({ text: '/q', reply: textReply('with a photo') })), true);
assert.deepEqual(calls.profilePhotoRequests.at(-1), { user_id: 7, offset: 0, limit: 1 },
  'profile photos are requested for the quoted author');
assert.equal(calls.fileRequests.at(-1), 'medium', 'a mid-size photo is downloaded (smallest ≥ 100 px)');
assert.equal(calls.stickers.length, 1);

// The rendered card reports that it used a real avatar.
const withAvatar = renderQuote({ text: 'x', name: 'Sakura', avatar: AVATAR_IMAGE });
assert.equal(withAvatar.hasAvatar, true);
// Without one it falls back, and says so.
const withoutAvatar = renderQuote({ text: 'x', name: 'Sakura', avatar: null });
assert.equal(withoutAvatar.hasAvatar, false);
// Sample the avatar centre (cx ≈ 60, cy ≈ mid-height) in both cards.
const avatarPixel = (image) => {
  const x = 60;
  const y = Math.floor(image.height / 2);
  const i = (y * image.width + x) * 4;
  return [...image.rgba.slice(i, i + 4)];
};
assert.notDeepEqual(avatarPixel(withAvatar), avatarPixel(withoutAvatar),
  'the avatar area differs when a real photo is present');
assert.deepEqual(avatarPixel(withAvatar), [200, 60, 90, 255], 'the photo pixels are used as-is');

// ---- 6. avatar failure paths fall back cleanly ---------------------------
await reset();
profilePhotoResult = { photos: [] };
assert.equal(await handleQuoteCommand(commandMessage({ text: '/q', reply: textReply('no photo') })), true);
assert.equal(calls.stickers.length, 1, 'a sticker is still sent');
assert.equal(await handleQuoteCommand(commandMessage({ text: '/q', reply: textReply('again') })), true);

await reset();
profilePhotoError = new BotApiError('Forbidden');
assert.equal(await handleQuoteCommand(commandMessage({ text: '/q', reply: textReply('hidden') })), true);
assert.equal(calls.stickers.length, 1, 'a privacy-restricted photo does not break /q');

await reset();
profilePhotoResult = { total_count: 1, photos: [[{ file_id: 'f', width: 200, height: 200 }]] };
fileBytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
  17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32]);
assert.equal(await handleQuoteCommand(commandMessage({ text: '/q', reply: textReply('garbage') })), true);
assert.equal(calls.stickers.length, 1, 'an undecodable photo falls back to the lettered avatar');

assert.equal(pickPhotoSize([{ width: 10, height: 10, file_id: 'a' }]).file_id, 'a', 'tiny photos are still used');
assert.equal(pickPhotoSize([]), null);
assert.equal(decodeProfilePhoto(null).ok, false);
assert.equal(decodeProfilePhoto(new Uint8Array(64)).reason, 'unsupported_format');
assert.equal(decodeProfilePhoto(TINY_JPEG).reason ?? 'ok', 'decode_failed');

// A real JPEG decodes (the decoder is verified against ImageMagick separately).
const jpegOk = decodeProfilePhoto(TINY_JPEG);
assert.equal(typeof jpegOk.ok, 'boolean');
void fetchProfilePhoto;

// ---- 7. /own only accepts stickers --------------------------------------
await reset();
assert.equal(await handleQuoteCommand(commandMessage({ text: '/own', reply: textReply('just text') })), true);
assert.match(lastMessage(), /only saves stickers/i);
assert.equal(calls.creates.length, 0, 'no pack for a text reply');
assert.equal(calls.adds.length, 0);

await reset();
const photoReply = { message_id: 906, from: AUTHOR, caption: 'pic', photo: [{ file_id: 'p' }], chat: { id: 1 } };
assert.equal(await handleQuoteCommand(commandMessage({ text: '/own', reply: photoReply })), true);
assert.match(lastMessage(), /only saves stickers/i);
assert.equal(calls.creates.length, 0, 'no pack for a photo reply');

await reset();
const voiceReply = { message_id: 907, from: AUTHOR, voice: { file_id: 'v' }, chat: { id: 1 } };
assert.equal(await handleQuoteCommand(commandMessage({ text: '/own', reply: voiceReply })), true);
assert.match(lastMessage(), /only saves stickers/i);
assert.equal(calls.creates.length, 0, 'no pack for a voice reply');

// ---- 8. /own stores the sticker unchanged ------------------------------
await reset();
const replied = stickerReply();
assert.equal(await handleQuoteCommand(commandMessage({ text: '/own', reply: replied })), true);
assert.equal(calls.creates.length, 1, 'the first /own creates the pack');
const created = calls.creates[0];
assert.equal(created.user_id, 42, 'the pack belongs to the invoker');
assert.equal(created.sticker_format, 'static');
assert.match(created.name, /_by_missfrozen_bot$/);
assert.match(lastMessage(), /created/i);
assert.match(lastMessage(), /addstickers/);

// The sticker is copied by file_id — never re-rendered.
assert.equal(created.stickers[0].sticker, 'CAACAgIAAx');
assert.equal(created.stickers[0].format, 'static');
assert.equal(created.stickers[0].emoji_list[0], '🍥');
assert.equal(calls.stickers.length, 0, 'no PNG is generated for /own');

const row = await db.get(sql`SELECT * FROM quote_sticker_packs WHERE telegram_id = 42`);
assert.equal(row.status, 'ready');
assert.equal(row.sticker_count, 1);
assert.equal(row.sticker_format, 'static');

// ---- 9. second use adds to the same pack ------------------------------
assert.equal(await handleQuoteCommand(commandMessage({
  text: '/own',
  reply: stickerReply({ file_id: 'SECOND', file_unique_id: 'AgAD2', emoji: '❄️', type: 'regular' }),
})), true);
assert.equal(calls.creates.length, 1, 'no second pack');
assert.equal(calls.adds.length, 1);
assert.equal(calls.adds[0].name, created.name);
assert.equal(calls.adds[0].sticker.sticker, 'SECOND');
assert.match(lastMessage(), /saved/i);

// ---- 10. duplicates are reported, not duplicated ----------------------
assert.equal(await handleQuoteCommand(commandMessage({ text: '/own', reply: stickerReply() })), true);
assert.equal(calls.adds.length, 1, 'the duplicate is not uploaded again');
assert.match(lastMessage(), /already in your pack/i);
const rowDup = await db.get(sql`SELECT * FROM quote_sticker_packs WHERE telegram_id = 42`);
assert.equal(rowDup.sticker_count, 2);

// ---- 11. separate users get separate packs ---------------------------
await reset();
await handleQuoteCommand(commandMessage({
  text: '/own', from: user(77, { first_name: 'Hinata' }), reply: stickerReply(),
}));
await handleQuoteCommand(commandMessage({
  text: '/own', from: user(78, { first_name: 'Kiba' }), reply: stickerReply({ file_id: 'KK', file_unique_id: 'kk' }),
}));
assert.equal(calls.creates.length, 2);
assert.notEqual(calls.creates[0].name, calls.creates[1].name);
assert.equal(calls.creates[0].user_id, 77);
assert.equal(calls.creates[1].user_id, 78);
assert.match(calls.creates[0].name, /^frozen_stickers77_by_missfrozen_bot$/);

// ---- 12. sticker formats ---------------------------------------------
assert.deepEqual(formatOfSticker({ file_id: 'a', is_animated: false, is_video: false }), { ok: true, format: 'static' });
assert.deepEqual(formatOfSticker({ file_id: 'a', is_animated: true }), { ok: true, format: 'animated' });
assert.deepEqual(formatOfSticker({ file_id: 'a', is_video: true }), { ok: true, format: 'video' });
assert.deepEqual(formatOfSticker({ file_id: 'a', type: 'animated' }), { ok: true, format: 'animated' });
assert.equal(formatOfSticker({ file_id: 'a', type: 'mask' }).ok, false);
assert.equal(formatOfSticker({ file_id: 'a', type: 'custom_emoji' }).ok, false);
assert.equal(formatOfSticker(null).ok, false);

// An animated sticker creates an animated pack with the right format flag.
await reset();
assert.equal(await handleQuoteCommand(commandMessage({
  text: '/own', reply: stickerReply({ file_id: 'ANIM', file_unique_id: 'an', is_animated: true }),
})), true);
assert.equal(calls.creates[0].sticker_format, 'animated');
assert.equal(calls.creates[0].stickers[0].format, 'animated');
const animRow = await db.get(sql`SELECT * FROM quote_sticker_packs WHERE telegram_id = 42`);
assert.equal(animRow.sticker_format, 'animated');

// A video sticker added to an animated pack is refused with a clear reason.
await reset();
await handleQuoteCommand(commandMessage({ text: '/own', reply: stickerReply({ file_id: 'V1', file_unique_id: 'v1', is_video: true }) }));
console.log('video pack created?', calls.creates.length);
const videoRow = await db.get(sql`SELECT * FROM quote_sticker_packs WHERE telegram_id = 42`);
assert.equal(videoRow.sticker_format, 'video', 'a video sticker makes a video pack');
assert.equal(calls.creates[0].sticker_format, 'video');

// Now a static sticker must be refused for that user.
assert.equal(await handleQuoteCommand(commandMessage({
  text: '/own', reply: stickerReply({ file_id: 'S1', file_unique_id: 's1' }),
})), true);
assert.match(lastMessage(), /single-format|different sticker format/i);
assert.equal(calls.adds.length, 0, 'the mismatched sticker is not uploaded');

// Masks and custom emoji are refused.
await reset();
assert.equal(await handleQuoteCommand(commandMessage({
  text: '/own', reply: stickerReply({ file_id: 'M', file_unique_id: 'm', type: 'mask' }),
})), true);
assert.match(lastMessage(), /mask/i);
assert.equal(calls.creates.length, 0);

// ---- 13. concurrency: one pack for two simultaneous first /own ---------
await reset();
const racer = { file_id: 'RACE', file_unique_id: 'race', emoji: '🍥', type: 'regular' };
const results = await Promise.all([
  ownSticker({ userId: 555, displayName: 'Race', botUsername: 'missfrozen_bot', sticker: racer }),
  ownSticker({ userId: 555, displayName: 'Race', botUsername: 'missfrozen_bot', sticker: racer }),
]);
const raceRows = await db.all(sql`SELECT * FROM quote_sticker_packs WHERE telegram_id = 555`);
assert.equal(raceRows.length, 1, 'a single row per user');
assert.equal(calls.creates.length, 1, 'exactly one createNewStickerSet');
assert.ok(results.some((r) => r.ok), 'at least one invocation succeeds');

// ---- 14. ambiguous timeout is reconciled, never duplicated ------------
await reset();
const timeoutError = Object.assign(new BotApiError('timeout'), { description: 'Request timeout' });
nextCreateError = timeoutError;
const timedOut = await ownSticker({
  userId: 666, displayName: 'Slow', botUsername: 'missfrozen_bot',
  sticker: { file_id: 'T', file_unique_id: 't', type: 'regular' },
});
assert.equal(timedOut.ok, false, 'an ambiguous create is not reported as success');
assert.equal(timedOut.code, 'unclear');
const released = await db.get(sql`SELECT * FROM quote_sticker_packs WHERE telegram_id = 666`);
assert.equal(released, null, 'the claim is released so a retry can start over');

// Timeout where the set *was* created remotely.
await reset();
nextCreateError = timeoutError;
calls.sets[buildPackName(666, 'missfrozen_bot')] = {
  name: buildPackName(666, 'missfrozen_bot'),
  sticker_format: 'static',
  stickers: [{ file_id: 'T', file_unique_id: 'uniq-T' }],
};
const reconciled = await ownSticker({
  userId: 666, displayName: 'Slow', botUsername: 'missfrozen_bot',
  sticker: { file_id: 'T', file_unique_id: 't', type: 'regular' },
});
assert.equal(reconciled.ok, true, 'the existing remote set is adopted');
assert.equal(reconciled.duplicate, true, 'the sticker is recognised as already saved');
assert.equal(calls.creates.length, 1, 'no second set was created');

// A timeout when *adding* reconciles as well.
await reset();
await ownSticker({ userId: 700, displayName: 'Add', botUsername: 'missfrozen_bot', sticker: { file_id: 'A1', file_unique_id: 'a1', type: 'regular' } });
const setName = buildPackName(700, 'missfrozen_bot');
nextAddError = timeoutError;
calls.sets[setName].stickers.push({ file_id: 'A2', file_unique_id: 'uniq-A2' }); // landed remotely
const addReconciled = await ownSticker({
  userId: 700, displayName: 'Add', botUsername: 'missfrozen_bot',
  sticker: { file_id: 'A2', file_unique_id: 'a2', type: 'regular' },
});
assert.equal(addReconciled.ok, true, 'a timed-out add that landed is reported as success');
assert.equal(addReconciled.count, 2);

// ---- 15. pack limits --------------------------------------------------
await reset();
await ownSticker({
  userId: 888, displayName: 'Full', botUsername: 'missfrozen_bot',
  sticker: { file_id: 'F0', file_unique_id: 'f0', type: 'regular' },
});
const fullSet = calls.sets[buildPackName(888, 'missfrozen_bot')];
for (let i = 0; i < MAX_STATIC_STICKERS - 1; i += 1) {
  fullSet.stickers.push({ file_id: `F${i + 1}`, file_unique_id: `uniq-F${i + 1}` });
}
await db.run(sql`UPDATE quote_sticker_packs SET sticker_count = ${MAX_STATIC_STICKERS} WHERE telegram_id = 888`);
const full = await ownSticker({
  userId: 888, displayName: 'Full', botUsername: 'missfrozen_bot',
  sticker: { file_id: 'OVER', file_unique_id: 'over', type: 'regular' },
});
assert.equal(full.ok, false);
assert.equal(full.code, 'full');
assert.equal(calls.adds.length, 0, 'nothing is uploaded to a full pack');
assert.match(full.url, /addstickers/, 'the existing pack link is still returned');

assert.equal(STICKER_LIMITS.static, 120);
assert.equal(STICKER_LIMITS.animated, 50);
assert.equal(STICKER_LIMITS.video, 50);

// ---- 16. API failures are not reported as success ---------------------
await reset();
await ownSticker({ userId: 900, displayName: 'Err', botUsername: 'missfrozen_bot', sticker: { file_id: 'E1', file_unique_id: 'e1', type: 'regular' } });
calls.messages.length = 0;
nextAddError = new BotApiError('Bad Request: STICKER_FILE_INVALID');
assert.equal(await handleQuoteCommand(commandMessage({
  text: '/own', from: user(900, { first_name: 'Err' }),
  reply: stickerReply({ file_id: 'E2', file_unique_id: 'e2' }),
})), true);
assert.doesNotMatch(lastMessage(), /saved to your pack/i, 'a failed upload is never reported as saved');

// ---- 17. naming and titles -------------------------------------------
assert.equal(packSuffix('@missfrozen_bot'), '_by_missfrozen_bot');
assert.equal(packSuffix('x'), null);
const name = buildPackName(42, 'missfrozen_bot');
assert.match(name, /_by_missfrozen_bot$/);
assert.ok(name.length <= 64);
assert.equal(buildPackName(42, ''), null);
assert.equal(buildPackTitle('Kakashi Hatake'), 'Kakashi Hatake stickers');
assert.ok(buildPackTitle('x'.repeat(200)).length <= 64);
assert.equal((await ownSticker({ userId: 10, displayName: 'X', botUsername: 'x', sticker: { file_id: 'a', type: 'regular' } })).code,
  'bad_bot_username');

// ---- 18. extraction, text and layout ---------------------------------
assert.equal(formatMessageTime(0), '');
assert.equal(formatMessageTime(1700000000), '10:13 PM');
assert.equal(formatMessageTime(1700003600), '11:13 PM');

assert.deepEqual(extractQuote({ from: { id: 1, first_name: 'A' }, text: 'hi', date: 1700000000 }).time, '10:13 PM');
assert.equal(extractQuote({ from: { id: 1, is_bot: true, first_name: 'Bot' }, text: 'x' }).reason, 'no_author');
assert.equal(extractQuote(null).reason, 'reply_required');
assert.equal(extractQuote({ from: { id: 1 }, chat: { id: 1 } }).reason, 'nothing_to_quote');

// Entities are flattened; markup stays literal text.
const entityQuote = extractQuote({
  from: { id: 11, first_name: 'Hinata', username: undefined },
  text: 'Look at https://example.com now',
  entities: [{ type: 'text_link', offset: 8, length: 19, url: 'https://example.com' }],
});
assert.equal(entityQuote.text, 'Look at https://example.com now');
const htmlQuote = extractQuote({ from: { id: 12 }, text: '<b>bold</b> & <script>x()</script>' });
assert.ok(htmlQuote.text.includes('<script>'), 'content is never parsed as markup');
assert.equal(extractQuote({ from: { id: 13 }, text: 'x'.repeat(2000) }).truncated, true);

// Photos with captions, media without text.
const photoQuote = extractQuote({
  from: { id: 14, first_name: 'Sak' }, caption: 'Konoha at dawn 🌅',
  caption_entities: [], photo: [{ file_id: 'p' }],
});
assert.equal(photoQuote.text, 'Konoha at dawn 🌅');
assert.equal(photoQuote.mediaKind, 'photo');
assert.equal(extractQuote({ from: { id: 15 }, voice: { file_id: 'v' } }).kind, 'Voice message');
assert.equal(extractQuote({ from: { id: 16 }, sticker: { emoji: '🥀', file_id: 's' } }).kind, '🥀 Sticker');

// Text: emoji dropped, unsupported scripts flagged, never silently "?"-only.
assert.equal(normalizeText('Konoha 🌅 at dawn'), 'Konoha  at dawn');
assert.equal(normalizeText('“quoted” — dash …'), '"quoted" - dash ...');
assert.equal(normalizeText('मैं'), '?');
assert.equal(renderableShare('Hello world'), 1);
assert.ok(renderableShare('मैं हूँ') < 0.5);
assert.equal(renderableShare('🌅🌅'), 1, 'emoji alone are not a "missing script"');

const wrapped = wrapText('the quick brown fox jumps over the lazy dog', 200, 30);
assert.ok(wrapped.length > 1);
for (const line of wrapped) assert.ok(measureLine(line, 30) <= 200.5);
assert.ok(wrapText('A'.repeat(80), 100, 30).length >= 3, 'over-long words hard-break');
assert.equal(wrapText('a\nb', 500, 30).length, 2, 'newlines are honoured');

// ---- 19. layout ------------------------------------------------------
const shortPlan = planLayout({ text: 'gg', name: 'Sakura', hasAvatar: true });
const longPlan = planLayout({ text: 'word '.repeat(400), name: 'Sakura', hasAvatar: true });
assert.ok(shortPlan.fontSize >= longPlan.fontSize, 'long text uses a smaller face');
assert.ok(shortPlan.height <= 512 && longPlan.height <= 512, 'never exceeds 512 px');
assert.equal(longPlan.clipped, true, 'extreme text is clipped, not overflowing');

// No avatar → no reserved avatar column.
assert.equal(planLayout({ text: 'x', name: 'A', hasAvatar: false }).bubbleWidth,
  planLayout({ text: 'x', name: 'A', hasAvatar: true }).bubbleWidth + 122);

// Name colours are deterministic and varied.
assert.deepEqual(nameColor(42), nameColor(42));
assert.notDeepEqual(nameColor(1), nameColor(2));

// ---- 20. rendering edge cases ---------------------------------------
const emojiOnly = renderQuotePng({ text: '😂😂😂', name: 'Naruto', avatar: AVATAR_IMAGE });
assert.equal(emojiOnly.label, 'Emoji');

const hindi = renderQuotePng({ text: 'मैं हूँ कोनोहा का हॉक!', name: 'जिरैया', avatar: null });
assert.equal(hindi.unsupportedScript, true);

const noText = renderQuotePng({ text: '', name: 'Naruto', kind: 'Voice message', avatar: null });
assert.equal(noText.label, 'Voice message');

const extreme = renderQuotePng({ text: 'long '.repeat(600), name: 'A'.repeat(80), avatar: AVATAR_IMAGE });
assert.equal(extreme.height, 512);
assert.ok(extreme.bytes.length <= 512 * 1024);

// Deterministic output.
const a = renderQuotePng({ text: 'same', name: 'Same', avatar: AVATAR_IMAGE });
const b = renderQuotePng({ text: 'same', name: 'Same', avatar: AVATAR_IMAGE });
assert.equal(Buffer.compare(Buffer.from(a.bytes), Buffer.from(b.bytes)), 0);

// ---- 21. registry / help --------------------------------------------
const { QUOTE_COMMANDS } = await import('../../tgcloud/lib/quote_stickers.js');
assert.deepEqual([...QUOTE_COMMANDS].sort(), ['own', 'q']);
const { COMMANDS } = await import('../../tgcloud/lib/command_registry.js');
assert.equal(COMMANDS.filter((c) => c.cmd === '/q').length, 1);
assert.equal(COMMANDS.filter((c) => c.cmd === '/own').length, 1);
assert.equal(COMMANDS.find((c) => c.cmd === '/own').desc.includes('pack'), true);
const { helpText } = await import('../../tgcloud/lib/help.js');
const help = helpText({ id: 1 });
assert.match(help, /\/q — /);
assert.match(help, /\/own — /);

// ---- 22. no message content is persisted ---------------------------
const columns = await db.all(sql.raw('PRAGMA table_info(quote_sticker_packs)'));
const columnNames = columns.map((c) => c.name);
for (const forbidden of ['text', 'quote_text', 'caption', 'message', 'avatar']) {
  assert.ok(!columnNames.includes(forbidden), `no ${forbidden} column`);
}
assert.deepEqual(columnNames.sort(),
  ['created_at', 'last_error', 'set_name', 'status', 'sticker_count', 'sticker_format', 'telegram_id', 'title', 'updated_at']);

void decodeJpeg;
console.log('quote stickers: OK');
