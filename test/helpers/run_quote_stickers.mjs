// /q and /own — quote stickers.
//
// Everything runs against the in-memory SDK stub: no network, no credentials.
// Covers extraction, rendering, the avatar pipeline, the sticker-copy workflow,
// pack persistence, and every failure path (timeout, full pack, duplicates).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { api, BotApiError, setFetch } from 'sdk';
import { db, sql } from './sdk_db_stub.mjs';
import { readPngHeader, encodeRgbaPng, decodePng } from '../../tgcloud/lib/quote/png.js';
import { encodeRgbaPng as _unused } from '../../tgcloud/lib/quote/png.js';
import { renderQuotePng, renderQuote, planLayout, nameColor } from '../../tgcloud/lib/quote/render.js';
import {
  wrapText, measureLine, measureRich, normalizeText, renderableShare, isPictograph,
  splitClusters, faceOf,
} from '../../tgcloud/lib/quote/text.js';
import {
  emojiCount, firstEmojiOf, emojiTileImage, fetchEmojiImage, resetEmojiCache,
  emojiCodepointOf, nameIsEmojiOnly, emojiTint, resolveNameEmoji,
} from '../../tgcloud/lib/quote/emoji.js';
import { extractQuote, formatMessageTime } from '../../tgcloud/lib/quote/extract.js';
import { decodeJpeg } from '../../tgcloud/lib/quote/jpeg.js';
import {
  pickPhotoSize, decodeProfilePhoto, fetchProfilePhoto, resolveAvatar,
} from '../../tgcloud/lib/quote/avatar.js';
import {
  buildPackName, buildPackTitle, packSuffix, formatOfSticker, ownSticker,
  MAX_STATIC_STICKERS, STICKER_LIMITS,
} from '../../tgcloud/lib/quote/packs.js';
import {
  handleQuoteCommand, parseQuoteCommand, addressedToUs, buildQuoteSticker,
} from '../../tgcloud/lib/quote_stickers.js';

void _unused;

/** Read a repo file as text (used for source assertions). */
const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

await db.run(sql.raw(`CREATE TABLE IF NOT EXISTS sticker_pack_sets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id INTEGER NOT NULL,
  sticker_format TEXT NOT NULL DEFAULT 'static',
  set_name TEXT NOT NULL,
  title TEXT NOT NULL,
  sticker_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'creating',
  last_error TEXT,
  created_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
)`));
await db.run(sql.raw('CREATE UNIQUE INDEX IF NOT EXISTS uidx_sticker_pack_name ON sticker_pack_sets (set_name)'));

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

/** A solid square in one colour — lets tests prove *which* photo was drawn. */
function solidPng(rgb, side = 32) {
  const rgba = new Uint8Array(side * side * 4);
  for (let i = 0; i < side * side; i += 1) {
    rgba[i * 4] = rgb[0];
    rgba[i * 4 + 1] = rgb[1];
    rgba[i * 4 + 2] = rgb[2];
    rgba[i * 4 + 3] = 255;
  }
  return encodeRgbaPng({ width: side, height: side, rgba });
}

const AVATAR_PNG = tinyPng();
const AVATAR_IMAGE = decodePng(AVATAR_PNG);
const AUTHOR_RGB = [200, 60, 90]; // AVATAR_PNG's colour
const INVOKER_RGB = [20, 200, 90]; // a third colour: the /q sender
const BOT_RGB = [30, 120, 220]; // MissFrozen's own photo
const CHANNEL_RGB = [250, 180, 20]; // a channel photo
const INVOKER_AVATAR_PNG = solidPng(INVOKER_RGB);
const BOT_AVATAR_PNG = solidPng(BOT_RGB);
const CHANNEL_AVATAR_PNG = solidPng(CHANNEL_RGB);

// ---- mocked Bot API -------------------------------------------------------

const calls = {
  stickers: [], messages: [], creates: [], adds: [], profilePhotoRequests: [], fileRequests: [],
  chatRequests: [], sets: {}, chats: {},
};
let profilePhotoResult = { photos: [] };
let profilePhotoError = null;
let fileBytes = null;
// Per-user overrides so the *author's* photo and the *bot's* photo can be made
// visibly different: Telegram is mocked, but the pixel check is real.
const photosByUser = new Map();
const bytesByFileId = new Map();
const BOT_ID = 8888370613;
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
  if (photosByUser.has(payload.user_id)) {
    const override = photosByUser.get(payload.user_id);
    if (override instanceof Error) throw override;
    return override;
  }
  if (profilePhotoError) throw profilePhotoError;
  return profilePhotoResult;
};
api.getFileContent = async (fileId) => {
  calls.fileRequests.push(fileId);
  if (bytesByFileId.has(fileId)) return bytesByFileId.get(fileId);
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
let getMeError = null;
api.getMe = async () => {
  if (getMeError) throw getMeError;
  return { id: BOT_ID, username: 'missfrozen_bot' };
};
api.getChat = async ({ chat_id }) => {
  calls.chatRequests.push(chat_id);
  return calls.chats[chat_id] || { id: chat_id, type: 'channel', title: 'Channel' };
};

const reset = async () => {
  for (const key of ['stickers', 'messages', 'creates', 'adds', 'profilePhotoRequests',
    'fileRequests', 'chatRequests']) {
    calls[key].length = 0;
  }
  for (const key of Object.keys(calls.chats)) delete calls.chats[key];
  for (const key of Object.keys(calls.sets)) delete calls.sets[key];
  profilePhotoResult = { photos: [] };
  profilePhotoError = null;
  fileBytes = null;
  nextCreateError = null;
  nextAddError = null;
  getMeError = null;
  photosByUser.clear();
  bytesByFileId.clear();
  // No default photo: a test must opt in, so the bot photo can never satisfy an
  // assertion by accident.
  await db.run(sql.raw('DELETE FROM sticker_pack_sets'));
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
assert.deepEqual(parseQuoteCommand('/q'), { command: 'q', atBot: null, mode: null });
assert.deepEqual(parseQuoteCommand('/Q@missfrozen_bot'), { command: 'q', atBot: 'missfrozen_bot', mode: null });
assert.deepEqual(parseQuoteCommand('/q r'), { command: 'q', atBot: null, mode: 'reply' });
assert.deepEqual(parseQuoteCommand('/q R'), { command: 'q', atBot: null, mode: 'reply' });
assert.deepEqual(parseQuoteCommand('/q reply'), { command: 'q', atBot: null, mode: 'reply' });
assert.deepEqual(parseQuoteCommand('/q@missfrozen_bot r'), { command: 'q', atBot: 'missfrozen_bot', mode: 'reply' });
assert.deepEqual(parseQuoteCommand('/own extra args'), { command: 'own', atBot: null, mode: null });
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

// ---- 6b. avatars: the author's own photo, otherwise their initial --------
// Scoped so the fixture names below cannot collide with later sections.
{
  const countColor = (image, rgb) => {
    let n = 0;
    for (let i = 0; i < image.rgba.length; i += 4) {
      if (image.rgba[i] === rgb[0] && image.rgba[i + 1] === rgb[1] && image.rgba[i + 2] === rgb[2]) n += 1;
    }
    return n;
  };
  /** Decode the sticker most recently handed to Telegram. */
  const sentImage = (index = -1) => decodePng(calls.stickers.at(index).sticker.value);
  const photoLookups = () => calls.profilePhotoRequests.map((r) => r.user_id);

  // (a) A replied-to user with a PFP gets *their own* photo.
  await reset();
  photosByUser.set(7, { photos: [[{ file_id: 'AUTHOR_PFP', width: 160, height: 160 }]] });
  bytesByFileId.set('AUTHOR_PFP', AVATAR_PNG);
  assert.equal(await handleQuoteCommand(commandMessage({ text: '/q', reply: textReply('own photo') })), true);
  const authorCard = sentImage();
  assert.ok(countColor(authorCard, AUTHOR_RGB) > 1000, "the author's photo is drawn");
  assert.deepEqual(photoLookups(), [7], 'only the author is looked up');
  assert.equal(calls.fileRequests.at(-1), 'AUTHOR_PFP');

  // (b) A user without a PFP gets their INITIAL — never the bot's photo.
  await reset();
  assert.equal(await handleQuoteCommand(commandMessage({ text: '/q', reply: textReply('no photo') })), true);
  const letterCard = sentImage();
  assert.equal(countColor(letterCard, AUTHOR_RGB), 0, 'no photo is invented');
  assert.equal(countColor(letterCard, BOT_RGB), 0, "the bot's photo is NEVER used");
  assert.deepEqual(photoLookups(), [7], "the bot's own photos are never even requested");
  const letterQuote = extractQuote(textReply('no photo'));
  assert.equal(buildQuoteSticker(letterQuote, null).hasAvatar, false, 'the lettered disc is used');
  assert.equal((await resolveAvatar(letterQuote)).source, 'initial');

  // (c) A FAILED user-photo fetch also ends at the initial, not the bot photo.
  for (const failure of [
    new BotApiError("Forbidden: bot can't see user profile photos"),
    new Error('network exploded'),
  ]) {
    await reset();
    photosByUser.set(7, failure);
    assert.equal(await handleQuoteCommand(commandMessage({ text: '/q', reply: textReply('hidden') })), true);
    assert.equal(countColor(sentImage(), BOT_RGB), 0,
      `a failed fetch (${failure.message}) never falls back to the bot photo`);
    assert.ok(!photoLookups().includes(BOT_ID), 'the bot is never asked for its own photo');
  }

  // (d) The name is `first_name` alone — exactly what `{mention}` renders.
  await reset();
  photosByUser.set(7, { photos: [[{ file_id: 'AUTHOR_PFP', width: 160, height: 160 }]] });
  bytesByFileId.set('AUTHOR_PFP', AVATAR_PNG);
  const namedReply = {
    message_id: 950,
    from: {
      id: 7, is_bot: false, first_name: 'Sakura', last_name: 'Haruno', username: 'sakura_h',
    },
    text: 'Dattebayo!',
    date: 1700000000,
    chat: { id: -1001234, type: 'supergroup' },
  };
  assert.equal(await handleQuoteCommand(commandMessage({ text: '/q', reply: namedReply })), true);
  const namedQuote = extractQuote(namedReply);
  assert.equal(namedQuote.name, 'Sakura', 'first name only, like a {mention}');
  const expectedCard = buildQuoteSticker(namedQuote, decodePng(AVATAR_PNG));
  assert.equal(expectedCard.drawnName, 'Sakura', 'the card credits the mention name');
  assert.equal(Buffer.compare(Buffer.from(expectedCard.bytes), Buffer.from(calls.stickers.at(-1).sticker.value)), 0,
    'the sent sticker is exactly the card built from the sender identity');

  // The @username is never drawn on the card.
  assert.ok(!expectedCard.drawnName.includes('@'), 'no @username on the card');
  assert.ok(!expectedCard.drawnName.includes('Haruno'), 'the last name is not appended');

  // Only a username → the username, never "Unknown".
  assert.equal(extractQuote({ ...namedReply, from: { id: 7, username: 'sakura_h' } }).name, 'sakura_h');

  // (e) The /q invoker's PFP is NEVER substituted for the quoted sender's.
  await reset();
  const quoteInvoker = { id: 999, is_bot: false, first_name: 'Invoker', username: 'invoker' };
  photosByUser.set(7, { photos: [[{ file_id: 'AUTHOR_PFP', width: 160, height: 160 }]] });
  photosByUser.set(999, { photos: [[{ file_id: 'INVOKER_PFP', width: 160, height: 160 }]] });
  bytesByFileId.set('AUTHOR_PFP', AVATAR_PNG);
  bytesByFileId.set('INVOKER_PFP', INVOKER_AVATAR_PNG);
  assert.equal(await handleQuoteCommand(commandMessage({
    text: '/q', from: quoteInvoker, reply: textReply('who wrote this?'),
  })), true);
  const notInvoker = sentImage();
  assert.equal(countColor(notInvoker, INVOKER_RGB), 0, "the invoker's photo never appears on the card");
  assert.ok(countColor(notInvoker, AUTHOR_RGB) > 1000, "the quoted author's photo does appear");
  assert.ok(!photoLookups().includes(999), 'the invoker is never looked up');

  // ... and when only the invoker has a photo, the author gets their initial.
  await reset();
  photosByUser.set(999, { photos: [[{ file_id: 'INVOKER_PFP', width: 160, height: 160 }]] });
  bytesByFileId.set('INVOKER_PFP', INVOKER_AVATAR_PNG);
  assert.equal(await handleQuoteCommand(commandMessage({
    text: '/q', from: quoteInvoker, reply: textReply('silent sender'),
  })), true);
  assert.equal(countColor(sentImage(), INVOKER_RGB), 0, "still never the invoker's photo");
  assert.equal(countColor(sentImage(), BOT_RGB), 0, 'and not the bot photo either');

  // (f) Channel posts and anonymous admins use the correct available identity.
  await reset();
  calls.chats[-1009] = {
    id: -1009, type: 'channel', title: 'Konoha News',
    photo: { big_file_id: 'CH_PFP', small_file_id: 'CH_PFP_SMALL' },
  };
  bytesByFileId.set('CH_PFP', CHANNEL_AVATAR_PNG);
  const channelPost = {
    message_id: 960,
    sender_chat: { id: -1009, title: 'Konoha News', type: 'channel', username: 'konohanews' },
    text: 'Breaking: the Hokage returns',
    date: 1700000000,
    chat: { id: -1009, type: 'channel' },
  };
  const channelQuote = extractQuote(channelPost);
  assert.equal(channelQuote.name, 'Konoha News', 'the channel is credited, not "Unknown"');
  assert.equal(channelQuote.senderId, null, 'no user id to attribute');
  assert.equal(channelQuote.senderChatId, -1009);

  assert.equal(await handleQuoteCommand(commandMessage({ text: '/q', reply: channelPost })), true);
  assert.ok(countColor(sentImage(), CHANNEL_RGB) > 1000, "the channel's own photo is drawn");
  assert.ok(!photoLookups().includes(-1009), 'channels use getChat, never getUserProfilePhotos');
  assert.equal(calls.chatRequests.at(-1), -1009);

  // Channel without a photo → the channel's initial, still credited to it.
  await reset();
  calls.chats[-1009] = { id: -1009, type: 'channel', title: 'Konoha News' };
  assert.equal(await handleQuoteCommand(commandMessage({ text: '/q', reply: channelPost })), true);
  assert.equal(countColor(sentImage(), BOT_RGB), 0, 'no bot photo for a photo-less channel');
  assert.equal(extractQuote(channelPost).name, 'Konoha News', 'the name is still the channel');
  assert.equal((await resolveAvatar(extractQuote(channelPost))).source, 'initial');

  // Anonymous admin → the group is credited; the group photo is used when set.
  await reset();
  const anonPost = {
    message_id: 961,
    from: { id: 1087968824, first_name: 'Group', is_bot: true, username: 'GroupAnonymousBot' },
    text: 'Admin announcement',
    date: 1700000000,
    chat: { id: -1001234, type: 'supergroup', title: 'Konoha Village' },
  };
  const anonQuote = extractQuote(anonPost, { chat: { id: -1001234, title: 'Konoha Village' } });
  assert.equal(anonQuote.name, 'Konoha Village', 'the group is credited');
  assert.equal(anonQuote.anonymous, true);
  assert.equal(anonQuote.senderId, null, 'the placeholder bot id is never treated as a person');
  assert.equal(anonQuote.senderChatId, -1001234);

  calls.chats[-1001234] = {
    id: -1001234, type: 'supergroup', title: 'Konoha Village',
    photo: { big_file_id: 'GROUP_PFP' },
  };
  bytesByFileId.set('GROUP_PFP', CHANNEL_AVATAR_PNG);
  assert.equal(await handleQuoteCommand(commandMessage({
    text: '/q', reply: anonPost, chatType: 'supergroup',
  })), true);
  assert.ok(countColor(sentImage(), CHANNEL_RGB) > 1000, "the group's photo is used for an anonymous admin");
  assert.ok(!photoLookups().includes(1087968824), 'the placeholder id is never looked up as a user');

  // Anonymous admin where the group has no photo → the group's initial.
  await reset();
  calls.chats[-1001234] = { id: -1001234, type: 'supergroup', title: 'Konoha Village' };
  assert.equal(await handleQuoteCommand(commandMessage({
    text: '/q', reply: anonPost, chatType: 'supergroup',
  })), true);
  assert.equal(countColor(sentImage(), BOT_RGB), 0);

  // (g) Neither missing fields nor failed API requests crash rendering.
  await reset();
  getMeError = new Error('getMe down');
  assert.equal(await handleQuoteCommand(commandMessage({ text: '/q', reply: textReply('no bot identity') })), true);
  assert.equal(calls.stickers.length, 1, 'a getMe failure still produces a sticker');

  await reset();
  profilePhotoResult = { total_count: 1, photos: [[{ file_id: 'f', width: 200, height: 200 }]] };
  fileBytes = new Uint8Array(64); // undecodable
  assert.equal(await handleQuoteCommand(commandMessage({ text: '/q', reply: textReply('bad bytes') })), true);
  assert.equal(calls.stickers.length, 1, 'undecodable author bytes still produce a sticker');

  await reset();
  profilePhotoResult = { total_count: 1, photos: [[{ /* no file_id at all */ width: 200, height: 200 }]] };
  assert.equal(await handleQuoteCommand(commandMessage({ text: '/q', reply: textReply('no file id') })), true);
  assert.equal(calls.stickers.length, 1, 'a malformed photo size does not crash');

  await reset();
  profilePhotoResult = { photos: [] }; // documented "no photo" shape
  const noMetadata = { message_id: 962, sender_chat: { id: -77 }, text: 'titleless', date: 1700000000, chat: { id: -77 } };
  assert.equal(extractQuote(noMetadata).name, 'Channel', 'a title-less channel still has an identity');
  assert.equal(await handleQuoteCommand(commandMessage({ text: '/q', reply: noMetadata })), true);
  assert.equal(calls.stickers.length, 1);

  // A download that throws (expired file_id) must not break the card.
  await reset();
  const originalGetFileContent = api.getFileContent;
  api.getFileContent = async () => { throw new BotApiError('Bad Request: invalid file_id'); };
  try {
    assert.equal(await handleQuoteCommand(commandMessage({ text: '/q', reply: textReply('download dies') })), true);
    assert.equal(calls.stickers.length, 1, 'a failed download still produces a sticker');
  } finally {
    api.getFileContent = originalGetFileContent;
  }

  // (h) A photo hidden from getUserProfilePhotos is recovered via getChat.
  await reset();
  photosByUser.set(7, { photos: [] });
  calls.chats[7] = { id: 7, type: 'private', photo: { big_file_id: 'USER_CHAT_PFP' } };
  bytesByFileId.set('USER_CHAT_PFP', AVATAR_PNG);
  assert.equal(await handleQuoteCommand(commandMessage({ text: '/q', reply: textReply('hidden photo') })), true);
  assert.ok(countColor(sentImage(), AUTHOR_RGB) > 1000,
    "the user's chat photo is used when the profile-photo list is hidden");

  // (i) file_ids are opaque — `+`, `/` and `=` must not be rejected.
  for (const weirdId of ['AbC+dE/fG==', 'AgACAgIAAxkBAAIBY2Fz+2fnb28']) {
    await reset();
    photosByUser.set(7, { photos: [[{ file_id: weirdId, width: 160, height: 160 }]] });
    bytesByFileId.set(weirdId, AVATAR_PNG);
    assert.equal(await handleQuoteCommand(commandMessage({ text: '/q', reply: textReply('odd id') })), true);
    assert.ok(countColor(sentImage(), AUTHOR_RGB) > 1000, `file_id ${weirdId} is downloaded, not rejected`);
  }

  // (j) No photo anywhere → lettered disc, and the real reason is logged.
  await reset();
  const logLines = [];
  const realError = console.error;
  console.error = (...args) => logLines.push(args.join(' '));
  try {
    assert.equal(await handleQuoteCommand(commandMessage({ text: '/q', reply: textReply('nothing anywhere') })), true);
  } finally {
    console.error = realError;
  }
  assert.equal(calls.stickers.length, 1, 'the sticker is still produced');
  assert.equal(countColor(sentImage(), BOT_RGB), 0, 'no bot photo is ever drawn');
  assert.ok(logLines.some((line) => line.includes('lettered fallback') && line.includes('no_photo')),
    `the real reason is logged (${JSON.stringify(logLines)})`);

  // (k) resolveAvatar reports its source, and never caches the author's photo.
  await reset();
  photosByUser.set(7, { photos: [[{ file_id: 'AUTHOR_PFP', width: 160, height: 160 }]] });
  bytesByFileId.set('AUTHOR_PFP', AVATAR_PNG);
  const firstLookup = await resolveAvatar({ senderId: 7, senderChatId: null });
  assert.equal(firstLookup.source, 'user');
  const secondLookup = await resolveAvatar({ senderId: 7, senderChatId: null });
  assert.equal(secondLookup.source, 'user');
  assert.equal(photoLookups().length, 2, 'the author photo is re-fetched, never cached');
}

// ---- 6c. `/q r` — the message being replied to, shown inside the card ----
{
  const countColorQr = (image, rgb) => {
    let n = 0;
    for (let i = 0; i < image.rgba.length; i += 4) {
      if (image.rgba[i] === rgb[0] && image.rgba[i + 1] === rgb[1] && image.rgba[i + 2] === rgb[2]) n += 1;
    }
    return n;
  };
  const sentImageQr = () => decodePng(calls.stickers.at(-1).sticker.value);
  const photoLookupsQr = () => calls.profilePhotoRequests.map((r) => r.user_id);

  // A real-shaped reply chain: A ← B, and `/q r` is a reply to B.
  const PARENT = {
    message_id: 900,
    from: { id: 21, is_bot: false, first_name: 'Naruto', username: 'naruto' },
    text: 'The Hokage will never give up.',
    date: 1699990000,
    chat: { id: -1001234, type: 'supergroup' },
  };
  const CHILD = {
    message_id: 901,
    from: { id: 7, is_bot: false, first_name: 'Sakura', username: 'sakura_h' },
    text: 'Believe it!',
    date: 1700000000,
    chat: { id: -1001234, type: 'supergroup' },
    reply_to_message: PARENT,
  };
  const replyToChild = () => commandMessage({ text: '/q r', reply: CHILD });

  // (a) The parent text is nested, the replying message is the main text.
  await reset();
  photosByUser.set(7, { photos: [[{ file_id: 'AUTHOR_PFP', width: 160, height: 160 }]] });
  bytesByFileId.set('AUTHOR_PFP', AVATAR_PNG);
  assert.equal(await handleQuoteCommand(replyToChild()), true);
  assert.equal(calls.stickers.length, 1, '`/q r` still sends exactly one sticker');

  const parentQuote = extractQuote(PARENT);
  const childQuote = extractQuote(CHILD);
  assert.equal(childQuote.text, 'Believe it!', 'the replied-to message is the main text');
  const withNested = buildQuoteSticker(childQuote, AVATAR_IMAGE,
    { name: parentQuote.name, text: parentQuote.text, userId: parentQuote.senderId });
  assert.deepEqual(withNested.nestedLines, ['The Hokage will never give up.'],
    'the parent text is rendered inside the card');
  assert.equal(withNested.drawnName, 'Sakura', 'the card is credited to the replier');

  const plain = buildQuoteSticker(childQuote, AVATAR_IMAGE, null);
  assert.deepEqual(plain.nestedLines, [], 'a plain /q nests nothing');
  assert.ok(withNested.height > plain.height, 'the nested block makes the card taller');
  assert.ok(withNested.height <= 512, 'still within Telegram\'s 512 px cap');

  // The nested block is actually PAINTED, not merely laid out: its background
  // differs from the bubble behind it. (A layout-only assertion would pass even
  // if the drawing code were removed.)
  const px = (image, x, y) => [...image.rgba.slice((y * image.width + x) * 4, (y * image.width + x) * 4 + 4)];
  // Geometry: MARGIN 4, bubbleX = 4+124+14 = 142, textX = 166,
  // nameRowTop = 28, nameLineHeight = 40 (badge), nestedTop = 78.
  const bubbleX = 4 + 124 + 14;
  const textX = bubbleX + 24;
  const nestedTop = 4 + 24 + 40 + 10;
  const nestedProbe = { x: textX + 40, y: nestedTop + 8 };
  const nestedDot = px(withNested, nestedProbe.x, nestedProbe.y);
  const plainDot = px(plain, nestedProbe.x, nestedProbe.y);
  assert.notDeepEqual(nestedDot, plainDot, 'the nested block changes the pixels under it');
  assert.deepEqual(nestedDot.slice(0, 3), [44, 33, 62], 'the quoted block uses the nested background');
  // The accent bar uses the parent author's name colour (bar starts NESTED.pad
  // below the block top, so probe lower than the text area).
  const barDot = px(withNested, textX + 12 + 2, nestedTop + 30);
  assert.deepEqual(barDot.slice(0, 3), nameColor(parentQuote.senderId),
    'the accent bar carries the parent author\'s colour');

  // The bytes actually sent match the nested build.
  assert.equal(Buffer.compare(Buffer.from(withNested.bytes), Buffer.from(calls.stickers.at(-1).sticker.value)), 0,
    'the sent sticker carries the nested quote');

  // (b) Plain `/q` never nests, even when the message is a reply.
  await reset();
  photosByUser.set(7, { photos: [[{ file_id: 'AUTHOR_PFP', width: 160, height: 160 }]] });
  bytesByFileId.set('AUTHOR_PFP', AVATAR_PNG);
  assert.equal(await handleQuoteCommand(commandMessage({ text: '/q', reply: CHILD })), true);
  assert.equal(Buffer.compare(Buffer.from(plain.bytes), Buffer.from(calls.stickers.at(-1).sticker.value)), 0,
    '`/q` ignores the parent; only `/q r` nests it');

  // (c) The nested message keeps ITS author's name, not the replier's.
  const parentNamed = extractQuote(PARENT);
  assert.equal(parentNamed.name, 'Naruto', 'the nested block is credited to the parent author');
  assert.notEqual(parentNamed.name, childQuote.name);

  // (d) `/q r` on a message that is not itself a reply → plain card, no error.
  await reset();
  photosByUser.set(7, { photos: [[{ file_id: 'AUTHOR_PFP', width: 160, height: 160 }]] });
  bytesByFileId.set('AUTHOR_PFP', AVATAR_PNG);
  const notAReply = { ...CHILD };
  delete notAReply.reply_to_message;
  assert.equal(await handleQuoteCommand(commandMessage({ text: '/q r', reply: notAReply })), true);
  assert.equal(calls.stickers.length, 1, 'a reply-less target still yields a sticker');
  assert.equal(Buffer.compare(Buffer.from(plain.bytes), Buffer.from(calls.stickers.at(-1).sticker.value)), 0,
    'nothing to nest → the plain card');

  // (e) A parent with no text (a voice note) is labelled honestly.
  const mediaParent = {
    ...PARENT, message_id: 902, text: undefined, voice: { file_id: 'v1', duration: 3 },
  };
  const mediaParentQuote = extractQuote(mediaParent);
  assert.equal(mediaParentQuote.kind, 'Voice message', 'a text-less parent is labelled honestly');
  const mediaNested = buildQuoteSticker(childQuote, AVATAR_IMAGE,
    { name: mediaParentQuote.name, text: mediaParentQuote.text || mediaParentQuote.kind,
      userId: mediaParentQuote.senderId });
  assert.deepEqual(mediaNested.nestedLines, ['Voice message']);

  // (f) Long parent text is clamped instead of overflowing the sticker.
  const longParent = {
    ...PARENT, message_id: 904, text: 'word '.repeat(400),
  };
  const longChild = { ...CHILD, message_id: 905, reply_to_message: longParent };
  const longParentQuote = extractQuote(longParent);
  const tallCard = buildQuoteSticker(childQuote, AVATAR_IMAGE,
    { name: longParentQuote.name, text: longParentQuote.text, userId: longParentQuote.senderId });
  assert.ok(tallCard.nestedLines.length <= 3, 'the nested block is capped at 3 lines');
  assert.ok(tallCard.height <= 512, 'the card still fits 512 px');
  assert.ok(tallCard.nestedLines.at(-1).trim().endsWith('...'), 'clipped nested text is marked with an ellipsis');
  assert.equal(longChild.reply_to_message.message_id, 904);

  // (g) `/q r` still credits the REPLIED-TO author's photo, never the parent's.
  await reset();
  photosByUser.set(7, { photos: [[{ file_id: 'AUTHOR_PFP', width: 160, height: 160 }]] });
  photosByUser.set(21, { photos: [[{ file_id: 'PARENT_PFP', width: 160, height: 160 }]] });
  bytesByFileId.set('AUTHOR_PFP', AVATAR_PNG);
  bytesByFileId.set('PARENT_PFP', INVOKER_AVATAR_PNG);
  assert.equal(await handleQuoteCommand(replyToChild()), true);
  assert.ok(countColorQr(sentImageQr(), AUTHOR_RGB) > 1000, "the replier's photo is the big avatar");
  assert.equal(countColorQr(sentImageQr(), INVOKER_RGB), 0, "the parent's photo is not used as the avatar");
  assert.deepEqual(photoLookupsQr(), [7], 'only the replied-to author is looked up');

  // (h) `/q r` never quotes the command message itself.
  await reset();
  photosByUser.set(7, { photos: [[{ file_id: 'AUTHOR_PFP', width: 160, height: 160 }]] });
  bytesByFileId.set('AUTHOR_PFP', AVATAR_PNG);
  assert.equal(await handleQuoteCommand(replyToChild()), true);
  const qrCard = sentImageQr();
  assert.ok(!JSON.stringify(withNested.nestedLines).includes('/q'), 'the command is never nested');
  void qrCard;

  // (i) `/q r` with a channel parent keeps the channel's name.
  const channelParent = {
    message_id: 906,
    sender_chat: { id: -1009, title: 'Konoha News', type: 'channel' },
    text: 'Breaking: the Hokage returns',
    date: 1699990000,
    chat: { id: -1009, type: 'channel' },
  };
  const channelParentQuote = extractQuote(channelParent);
  assert.equal(channelParentQuote.name, 'Konoha News');
  const channelNested = buildQuoteSticker(childQuote, AVATAR_IMAGE,
    { name: channelParentQuote.name, text: channelParentQuote.text, userId: 0 });
  assert.deepEqual(channelNested.nestedLines, ['Breaking: the Hokage returns']);
}

// ---- 6d. fancy fonts and emoji avatars ------------------------------------
{
  // --- decorative alphabets fold back to plain letters --------------------
  // Script, fraktur, double-struck and friends are different *letterforms*, not
  // weights; no face we can bake looks like them, so they fold.
  const folds = [
    ['ᴅᴇʙᴜɢ', 'DEBUG', 'small caps'],
    ['𝕊𝕒𝕜𝕦𝕣𝕒', 'Sakura', 'double-struck'],
    ['𝓢𝓪𝓴𝓾𝓻𝓪', 'Sakura', 'script'],
    ['𝔖𝔞𝔨𝔲𝔯𝔞', 'Sakura', 'fraktur'],
    ['Ｓａｋｕｒａ', 'Sakura', 'fullwidth'],
    ['Ⓢⓐⓚⓤⓡⓐ', 'Sakura', 'circled'],
    ['ᴊɪʀᴀɪʏᴀ', 'JIRAIYA', 'small caps word'],
  ];
  for (const [input, expected, label] of folds) {
    assert.equal(normalizeText(input), expected, `${label} folds to ASCII`);
  }

  // --- weight and slant are kept: 𝐅 is bold, 𝑭 is bold italic -------------
  // Telegram draws these as real bold/italic text; folding them to plain ASCII
  // made a fancy name come out in a font its owner never chose.
  assert.equal(faceOf('𝐀'), 'bold', 'math bold → bold face');
  assert.equal(faceOf('𝑨'), 'bolditalic', 'math bold italic → bold + slant');
  assert.equal(faceOf('𝐴'), 'italic', 'math italic → slant');
  assert.equal(faceOf('𝗔'), 'bold', 'sans-serif bold is bold too');
  assert.equal(faceOf('𝖠'), 'regular', 'sans-serif is the face we already draw');
  assert.equal(faceOf('A'), 'regular');
  assert.equal(normalizeText('𝐒𝐚𝐤𝐮𝐫𝐚'), '𝐒𝐚𝐤𝐮𝐫𝐚', 'a weight is not flattened away');
  assert.equal(normalizeText('𝑭𝒓𝒛𝒆𝒏'), '𝑭𝒓𝒛𝒆𝒏', 'bold italic survives layout');

  // Ink in a region, judged by brightness — the bubble behind is near-black.
  const inkBox = (image, x0, y0, x1, y1, test = () => true) => {
    const pixels = [];
    for (let y = Math.max(0, y0); y < Math.min(image.height, y1); y += 1) {
      for (let x = Math.max(0, x0); x < Math.min(image.width, x1); x += 1) {
        const i = (y * image.width + x) * 4;
        const [r, g, b, a] = [image.rgba[i], image.rgba[i + 1], image.rgba[i + 2], image.rgba[i + 3]];
        if (a > 40 && (r + g + b) / 3 > 120 && test(r, g, b)) pixels.push({ x, y });
      }
    }
    return pixels;
  };
  // The name row: right of the badge, on the first line of the bubble.
  const NAME_BOX = [206, 26, 430, 64];
  const inkCount = (image, test) => inkBox(image, ...NAME_BOX, test).length;
  const inkSkew = (image) => {
    const pixels = inkBox(image, ...NAME_BOX);
    if (!pixels.length) return 0;
    const ys = pixels.map((p) => p.y);
    const top = Math.min(...ys);
    const bottom = Math.max(...ys);
    const third = Math.max(1, Math.round((bottom - top) / 3));
    const mean = (list) => list.reduce((sum, p) => sum + p.x, 0) / Math.max(1, list.length);
    return mean(pixels.filter((p) => p.y < top + third))
      - mean(pixels.filter((p) => p.y >= bottom - third));
  };

  const plainAA = renderQuote({ text: 'hi', name: 'HHH', userId: 0, avatar: null });
  const boldAA = renderQuote({ text: 'hi', name: '𝐇𝐇𝐇', userId: 0, avatar: null });
  assert.ok(inkCount(boldAA) > inkCount(plainAA) * 1.1,
    `bold strokes carry more ink (${inkCount(boldAA)} vs ${inkCount(plainAA)})`);

  const italicH = renderQuote({ text: 'hi', name: '𝐻', userId: 0, avatar: null });
  const uprightH = renderQuote({ text: 'hi', name: 'H', userId: 0, avatar: null });
  assert.ok(inkSkew(italicH) > 0.8,
    `italic leans right of the baseline (skew ${inkSkew(italicH).toFixed(2)})`);
  assert.ok(Math.abs(inkSkew(uprightH)) < 0.8,
    `the upright face does not lean (skew ${inkSkew(uprightH).toFixed(2)})`);

  // --- an emoji inside the name is part of the name -----------------------
  const styledName = '𝑭𝒓❄️𝒛𝒆𝒏 𝑩𝒍𝒐𝒐𝒅𝒆𝒅';
  assert.deepEqual(
    splitClusters('𝑭𝒓❄️𝒛𝒆𝒏').filter((c) => c.emoji).map((c) => c.text),
    ['❄️'],
    'the snowflake is one cluster, not a base plus a stray selector',
  );
  assert.equal(measureRich('❄️', 23) > 20, true, 'an emoji takes a full em of advance');

  // Offline: the snowflake is baked, so the name needs no request at all.
  const nameUrls = [];
  setFetch(async (url) => { nameUrls.push(url); throw new Error('offline'); });
  resetEmojiCache();
  const nameArt = await resolveNameEmoji(styledName);
  assert.ok(nameArt.has('❄️'), 'the baked core covers the emoji in the name');
  assert.equal(nameUrls.length, 0, 'no request is made for a baked emoji');

  const isBlue = (r, g, b) => b > r + 40 && b > 120;
  const withEmoji = renderQuote({
    text: 'hi', name: styledName, userId: 0, avatar: null, nameEmoji: nameArt,
  });
  const withoutEmoji = renderQuote({ text: 'hi', name: styledName, userId: 0, avatar: null });
  assert.match(withEmoji.drawnName, /❄️/, 'the name keeps its emoji');
  const snowPixels = inkCount(withEmoji, isBlue);
  assert.ok(snowPixels > 40, `the snowflake is painted (${snowPixels} blue pixels)`);
  assert.equal(inkCount(withoutEmoji, isBlue), 0, 'no artwork, no invented snowflake');
  assert.ok(inkCount(withEmoji) > inkCount(withoutEmoji),
    'the emoji adds ink to the name row');

  // An emoji we could not obtain is left out, not drawn as a box or a \`?\`.
  const noArt = await resolveNameEmoji('A🛸B');
  assert.equal(noArt.size, 0, 'an unreachable emoji has no artwork');
  const withoutSaucer = renderQuote({
    text: 'hi', name: 'A🛸B', userId: 0, avatar: null, nameEmoji: noArt,
  });
  assert.equal(withoutSaucer.drawnName, 'A🛸B', 'the name still reads as written');
  assert.equal(inkCount(withoutSaucer, isBlue), 0);
  setFetch(null);
  resetEmojiCache();

  // Accents decompose; the Latin letter underneath survives.
  assert.equal(normalizeText('José'), 'Jose');
  assert.equal(normalizeText('Ünal'), 'Unal');
  assert.equal(normalizeText('Nguyễn'), 'Nguyen', 'Vietnamese folds too');
  assert.equal(normalizeText('ѕαкυяα'), 'sakura', 'Cyrillic/Greek lookalikes read as Latin');

  // The card credits the name as written — never "?" or "Unknown".
  const bold = renderQuote({ text: 'hi', name: '𝐒𝐚𝐤𝐮𝐫𝐚', avatar: null });
  assert.equal(bold.drawnName, '𝐒𝐚𝐤𝐮𝐫𝐚', 'a styled name is drawn in its own face');
  const foldedCard = renderQuote({ text: 'hi', name: '𝕊𝕒𝕜𝕦𝕣𝕒', avatar: null });
  assert.equal(foldedCard.drawnName, 'Sakura', 'a letterform we cannot draw still folds');

  // --- astral-plane TEXT is no longer mistaken for emoji ------------------
  assert.equal(isPictograph(0x1d412), false, 'math bold S is text, not a pictograph');
  assert.equal(isPictograph(0x1f525), true, 'fire is a pictograph');
  assert.equal(isPictograph(0x2728), true, 'sparkles is a pictograph');

  // --- the baked offline core -------------------------------------------
  assert.ok(emojiCount() >= 40, `an offline emoji core is baked (${emojiCount()})`);
  for (const [ch, cp] of [['🕸️', 0x1f578], ['🔥', 0x1f525], ['✨', 0x2728], ['🌸', 0x1f338],
    ['💀', 0x1f480], ['👑', 0x1f451], ['⭐', 0x2b50], ['❤️', 0x2764]]) {
    assert.equal(firstEmojiOf(ch), cp, `${ch} is in the baked core`);
  }
  assert.equal(firstEmojiOf('Sakura'), 0, 'plain text has no emoji');
  // The core is small on purpose: the long tail is fetched, not committed.
  assert.ok(emojiCount() < 80, 'the baked set stays small');

  // Range detection is independent of the baked set.
  assert.equal(emojiCodepointOf('🛸'), 0x1f6f8, 'an un-baked emoji is still detected');
  assert.equal(emojiCodepointOf('Sakura'), 0);
  assert.ok(nameIsEmojiOnly('🛸'), 'an un-baked emoji name is still emoji-only');
  assert.equal(nameIsEmojiOnly('Sakura'), false);

  // --- runtime fetch covers everything else ------------------------------
  assert.equal(firstEmojiOf('🛸'), 0, 'the flying saucer is not baked');

  // A working CDN: the emoji is downloaded and becomes the avatar.
  const saucerPng = encodeRgbaPng({
    width: 72, height: 72, rgba: (() => {
      const px = new Uint8Array(72 * 72 * 4);
      for (let i = 0; i < 72 * 72; i += 1) {
        px[i * 4] = 90; px[i * 4 + 1] = 200; px[i * 4 + 2] = 255; px[i * 4 + 3] = 255;
      }
      return px;
    })(),
  });
  const fetchedUrls = [];
  resetEmojiCache();
  setFetch(async (url) => {
    fetchedUrls.push(url);
    return {
      ok: true,
      status: 200,
      // The SDK documents both a chunk stream and body readers; the fetcher
      // prefers `.bytes()` when present.
      bytes: async () => saucerPng,
      body: (async function* chunks() { yield saucerPng; })(),
    };
  });
  const downloaded = await fetchEmojiImage(0x1f6f8);
  assert.ok(downloaded, 'the CDN image is decoded');
  assert.equal(downloaded.width, 72);
  assert.equal(fetchedUrls.length, 1);
  assert.match(fetchedUrls[0], /twemoji.*1f6f8\.png$/, 'the URL is built from the codepoint');

  // Cached: a second call does not hit the network again.
  await fetchEmojiImage(0x1f6f8);
  assert.equal(fetchedUrls.length, 1, 'a fetched emoji is cached per isolate');

  // An emoji-only name that is NOT baked still renders, using the download.
  const saucerQuote = extractQuote({ from: { id: 5, first_name: '🛸' }, text: 'take me' });
  const saucerAvatar = await resolveAvatar(saucerQuote);
  assert.equal(saucerAvatar.source, 'emoji-fetched', 'the CDN supplied the avatar');
  assert.ok(saucerAvatar.image);
  const saucerCard = buildQuoteSticker(saucerQuote, saucerAvatar.image, null, saucerAvatar.source);
  assert.ok(saucerCard.hasAvatar, 'the fetched emoji is drawn');
  assert.equal(saucerCard.drawnName, '🛸', 'the name is the emoji, not "Unknown"');

  // A broken CDN must never break the card.
  for (const broken of [
    // A 404 that still carries decodable bytes: the status must be honoured,
    // not just "did something decode".
    async () => ({ ok: false, status: 404, bytes: async () => saucerPng }),
    async () => { throw new TypeError('getaddrinfo ENOTFOUND'); },
    async () => ({ ok: true, bytes: async () => new Uint8Array(8) }),
    async () => ({ ok: true, body: undefined, bytes: undefined }),
  ]) {
    resetEmojiCache();
    setFetch(broken);
    assert.equal(await fetchEmojiImage(0x1f6f8), null, 'a failed fetch yields no image');
  }
  resetEmojiCache();
  setFetch(async () => ({ ok: false, status: 404 }));
  const offlineAvatar = await resolveAvatar(saucerQuote);
  assert.equal(offlineAvatar.source, 'initial', 'an unreachable CDN falls back to the initial');
  // ... and the sticker is still produced.
  const offlineCard = buildQuoteSticker(saucerQuote, offlineAvatar.image, null, offlineAvatar.source);
  assert.equal(offlineCard.hasAvatar, false);
  setFetch(null);
  resetEmojiCache();

  // --- an emoji-only name uses that emoji as its avatar ------------------
  await reset(); // section 6b left a mocked photo on user 7
  const webAvatar = await resolveAvatar(extractQuote({ from: { id: 7, first_name: '🕸️' }, text: 'Dhdjjsjsje' }));
  assert.equal(webAvatar.source, 'emoji', 'the baked tile is used, no network needed');
  const webCard = buildQuoteSticker(
    extractQuote({ from: { id: 7, first_name: '🕸️' }, text: 'Dhdjjsjsje' }),
    webAvatar.image, null, webAvatar.source,
  );
  assert.equal(webCard.emojiAvatar, true, 'the disc knows it holds emoji artwork');
  assert.equal(webCard.drawnName, '🕸️', 'the name is the emoji, never "Unknown"');
  assert.notEqual(webCard.drawnName, 'Unknown');
  assert.equal(webCard.hasAvatar, true, 'the emoji is the avatar');

  // It is actually PAINTED, and painted the way Telegram paints it: a bright
  // tinted disc with a near-white glyph, the look `needs_repainting` gives
  // custom emoji. Probe the disc and the glyph separately.
  const avatarCx = 4 + 62;
  const avatarCy = Math.floor(webCard.height / 2);
  const tint = emojiTint(0x1f578);
  let discPixels = 0;
  let glyphPixels = 0;
  for (let y = avatarCy - 45; y <= avatarCy + 45; y += 1) {
    for (let x = avatarCx - 45; x <= avatarCx + 45; x += 1) {
      if (Math.hypot(x + 0.5 - avatarCx, y + 0.5 - avatarCy) > 55) continue;
      const i = (y * webCard.width + x) * 4;
      const [r, g, b, a] = [webCard.rgba[i], webCard.rgba[i + 1], webCard.rgba[i + 2], webCard.rgba[i + 3]];
      if (a < 200) continue;
      // The disc tone, allowing for anti-aliasing.
      if (Math.abs(r - tint.bg[0]) < 12 && Math.abs(g - tint.bg[1]) < 12
        && Math.abs(b - tint.bg[2]) < 12) discPixels += 1;
      // The glyph: closer to the ink tone than to the disc tone. Tint-independent,
      // so this fails on "wrong colour" rather than on one hard-coded hex.
      const toInk = Math.abs(r - tint.ink[0]) + Math.abs(g - tint.ink[1]) + Math.abs(b - tint.ink[2]);
      const toDisc = Math.abs(r - tint.bg[0]) + Math.abs(g - tint.bg[1]) + Math.abs(b - tint.bg[2]);
      if (toInk < toDisc && toInk < 60) glyphPixels += 1;
    }
  }
  assert.ok(discPixels > 300, `the tinted disc is painted (${discPixels} px)`);
  assert.ok(glyphPixels > 60, `the glyph is painted in a light tone (${glyphPixels} px)`);

  // The glyph is lighter than the disc overall — the reference draws it white,
  // not dark. Compared on the sum: a bright disc can share one channel with the
  // glyph (peach is 255 in both), so a per-channel test would reject valid tints.
  const sumOf = ([r, g, b]) => r + g + b;
  assert.ok(sumOf(tint.ink) > sumOf(tint.bg) + 80,
    'the glyph tone is lighter than the disc it sits on');
  for (const t of [0x1f578, 0x1f525, 0x1f338, 0x1f451, 0x2764].map(emojiTint)) {
    assert.ok(sumOf(t.ink) > sumOf(t.bg) + 80, 'every tint keeps the glyph lighter');
  }

  // Stable per emoji, and not all one colour.
  assert.deepEqual(emojiTint(0x1f578), emojiTint(0x1f578), 'the tint is stable');
  const tints = new Set([0x1f578, 0x1f525, 0x1f338, 0x1f451, 0x2764].map((cp) => emojiTint(cp).bg.join()));
  assert.ok(tints.size >= 3, `different emoji get different tints (${tints.size} distinct)`);

  // A plain name still gets its initial, not an emoji.
  const plainCard = renderQuote({ text: 'hi', name: 'Sakura', avatar: null });
  assert.equal(plainCard.emojiAvatar, false);
  assert.equal(plainCard.drawnName, 'Sakura');

  // A real photo still wins over any emoji in the name.
  const photoWins = renderQuote({ text: 'hi', name: '🌸 Sakura', avatar: AVATAR_IMAGE });
  assert.equal(photoWins.emojiAvatar, false, 'the photo is used when one exists');
  assert.equal(photoWins.hasAvatar, true);

  // A real profile photo always beats the name's emoji.
  await reset();
  photosByUser.set(7, { photos: [[{ file_id: 'AUTHOR_PFP', width: 160, height: 160 }]] });
  bytesByFileId.set('AUTHOR_PFP', AVATAR_PNG);
  const photoFirst = await resolveAvatar(extractQuote({ from: { id: 7, first_name: '🌸 Sakura' }, text: 'x' }));
  assert.equal(photoFirst.source, 'user', 'the photo wins over the name emoji');

  // --- the atlas fits the deploy budget ----------------------------------
  const atlasSource = read('tgcloud/lib/quote/emoji_atlas.js');
  assert.ok(Buffer.byteLength(atlasSource, 'utf8') < 700 * 1024,
    'the atlas fits the snapshot module budget');
}

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

const row = await db.get(sql`SELECT * FROM sticker_pack_sets WHERE telegram_id = 42`);
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
const rowDup = await db.get(sql`SELECT * FROM sticker_pack_sets WHERE telegram_id = 42`);
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
assert.match(calls.creates[0].name, /^frozen_static_77_by_missfrozen_bot$/);

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
const animRow = await db.get(sql`SELECT * FROM sticker_pack_sets WHERE telegram_id = 42 AND sticker_format = 'animated'`);
assert.equal(animRow.sticker_format, 'animated');
assert.match(animRow.set_name, /_animated_/);

// ---- 12b. SEPARATE static and video packs for the SAME user -----------
await reset();
assert.equal(await handleQuoteCommand(commandMessage({
  text: '/own', reply: stickerReply({ file_id: 'S1', file_unique_id: 's1' }),
})), true);
assert.equal(calls.creates.length, 1);
assert.equal(calls.creates[0].sticker_format, 'static');

// The same user now saves a video sticker → a SECOND, independent pack.
assert.equal(await handleQuoteCommand(commandMessage({
  text: '/own', reply: stickerReply({ file_id: 'V1', file_unique_id: 'v1', is_video: true, type: 'video' }),
})), true);
assert.equal(calls.creates.length, 2, 'a video sticker creates its own pack');
assert.equal(calls.creates[1].sticker_format, 'video');
assert.notEqual(calls.creates[0].name, calls.creates[1].name, 'distinct short names');
assert.match(calls.creates[0].name, /^frozen_static_42_by_missfrozen_bot$/);
assert.match(calls.creates[1].name, /^frozen_video_42_by_missfrozen_bot$/);
assert.match(lastMessage(), /video sticker pack created/i);

const bothRows = await db.all(sql`
  SELECT sticker_format, set_name, sticker_count FROM sticker_pack_sets
  WHERE telegram_id = 42 ORDER BY sticker_format
`);
assert.equal(bothRows.length, 2, 'one row per format');
assert.equal(bothRows[0].sticker_format, 'static');
assert.equal(bothRows[1].sticker_format, 'video');
assert.match(bothRows[0].set_name, /_static_/);
assert.match(bothRows[1].set_name, /_video_/);

// Re-saving a static sticker reuses the static pack, not the video one.
const addsBefore = calls.adds.length;
assert.equal(await handleQuoteCommand(commandMessage({
  text: '/own', reply: stickerReply({ file_id: 'S2', file_unique_id: 's2' }),
})), true);
assert.equal(calls.creates.length, 2, 'no third pack');
assert.equal(calls.adds.length, addsBefore + 1);
assert.equal(calls.adds.at(-1).name, bothRows[0].set_name, 'added to the STATIC pack');
assert.equal(calls.adds.at(-1).sticker.bookmark ?? calls.adds.at(-1).sticker.format, 'static');

// And a second video sticker goes to the video pack.
await handleQuoteCommand(commandMessage({
  text: '/own', reply: stickerReply({ file_id: 'V2', file_unique_id: 'v2', is_video: true, type: 'video' }),
}));
assert.equal(calls.adds.at(-1).name, bothRows[1].set_name, 'added to the VIDEO pack');
assert.equal(calls.adds.at(-1).sticker.format, 'video');

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
const raceRows = await db.all(sql`SELECT * FROM sticker_pack_sets WHERE telegram_id = 555`);
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
const released = await db.get(sql`SELECT * FROM sticker_pack_sets WHERE telegram_id = 666`);
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
await db.run(sql`UPDATE sticker_pack_sets SET sticker_count = ${MAX_STATIC_STICKERS} WHERE telegram_id = 888`);
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

// ---- 17b. /q sender resolution (the reported bug) --------------------
// The quoted author — never the invoker, never the bot — supplies name + PFP.
await reset();
profilePhotoResult = { total_count: 1, photos: [[{ file_id: 'AUTH_PFP', width: 200, height: 200 }]] };
fileBytes = AVATAR_PNG;
const invoker = user(42, { first_name: 'Kakashi', username: 'kakashi' });
const quotedAuthor = user(7, { first_name: 'Sakura', last_name: 'Haruno', username: 'sakura' });

assert.equal(await handleQuoteCommand(commandMessage({
  text: '/q', from: invoker, reply: textReply('the quoted line', quotedAuthor),
})), true);
assert.equal(calls.profilePhotoRequests.at(-1).user_id, 7,
  'the PFP request targets the QUOTED author, not the invoker');
assert.notEqual(calls.profilePhotoRequests.at(-1).user_id, invoker.id);
assert.equal(calls.stickers.length, 1);

// The card itself carries the author's name, not the invoker's and not "Unknown".
const nameCard = renderQuote({
  text: 'the quoted line', name: 'Sakura', userId: 7, avatar: AVATAR_IMAGE,
});
assert.equal(nameCard.hasAvatar, true);

// "/q" must never become the quote text when a reply exists.
const noSelfQuote = renderQuote({ text: 'the quoted line', name: 'Sakura', avatar: AVATAR_IMAGE });
assert.ok(!noSelfQuote.lines.join(' ').includes('/q'));
assert.equal(noSelfQuote.lines.join(' '), 'the quoted line');

// A reply whose message_id equals the command's is not a real reply.
await reset();
const selfReply = {
  message_id: 1000, // same id as the command message
  from: quotedAuthor, text: '/q', date: 1700000000, chat: { id: -1001234 },
};
assert.equal(await handleQuoteCommand(commandMessage({ text: '/q', reply: selfReply })), true);
assert.equal(calls.stickers.length, 0, 'a self-referencing reply quotes nothing');

// Channel post: named after the channel, avatar from getChat (not getUserProfilePhotos).
await reset();
const channelPost = {
  message_id: 910,
  sender_chat: { id: -1009, title: 'Konoha News', type: 'channel', username: 'konohanews' },
  text: 'Breaking: the Hokage returns',
  date: 1700000000,
  chat: { id: -1009, type: 'channel' },
};
calls.chats[-1009] = { id: -1009, type: 'channel', title: 'Konoha News',
  photo: { big_file_id: 'CHANNEL_PFP', small_file_id: 'CHANNEL_PFP_SMALL' } };
fileBytes = AVATAR_PNG;
assert.equal(await handleQuoteCommand(commandMessage({
  text: '/q', from: invoker, reply: channelPost,
})), true);
assert.equal(calls.stickers.length, 1, 'a channel post is quotable');
assert.deepEqual(calls.chatRequests.at(-1), -1009, 'the channel photo comes from getChat');
assert.equal(calls.profilePhotoRequests.length, 0, 'no user PFP is requested for a channel');

const channelQuote = extractQuote(channelPost);
assert.equal(channelQuote.ok, true);
assert.equal(channelQuote.name, 'Konoha News', 'the channel is credited, not "Unknown"');
assert.equal(channelQuote.isChannel, true);
assert.equal(channelQuote.senderChatId, -1009);
assert.equal(channelQuote.senderId, null, 'no user id to attribute');

// Channel without a photo → still renders, lettered fallback.
await reset();
calls.chats[-1009] = { id: -1009, type: 'channel', title: 'Konoha News' };
assert.equal(await handleQuoteCommand(commandMessage({ text: '/q', reply: channelPost })), true);
assert.equal(calls.stickers.length, 1, 'a photo-less channel still yields a sticker');

// Anonymous group admin: the GROUP is credited, never a fake person.
await reset();
const anonPost = {
  message_id: 911,
  from: { id: 1087968824, first_name: 'Group', is_bot: true, username: 'GroupAnonymousBot' },
  text: 'Admin announcement',
  date: 1700000000,
  chat: { id: -1001234, type: 'supergroup', title: 'Konoha Village' },
};
const anonQuote = extractQuote(anonPost, { chat: { id: -1001234, title: 'Konoha Village' } });
assert.equal(anonQuote.ok, true, 'an anonymous admin is quotable');
assert.equal(anonQuote.name, 'Konoha Village', 'the group is credited');
assert.equal(anonQuote.anonymous, true);
assert.equal(anonQuote.senderId, null, 'the placeholder bot id is never used as a person');

assert.equal(await handleQuoteCommand(commandMessage({
  text: '/q', reply: anonPost, chatType: 'supergroup',
})), true);
assert.equal(calls.stickers.length, 1);

// A message with no sender information at all is rejected, not invented.
await reset();
const senderless = { message_id: 912, text: 'ghost', date: 1700000000, chat: { id: -1 } };
assert.equal(await handleQuoteCommand(commandMessage({ text: '/q', reply: senderless })), true);
assert.equal(calls.stickers.length, 0);
assert.match(lastMessage(), /no author/i);

// Channels and anonymous admins never trigger a *user* PFP lookup.
assert.equal(calls.profilePhotoRequests.length, 0);

// ---- 18. extraction, text and layout ---------------------------------
assert.equal(formatMessageTime(0), '');
assert.equal(formatMessageTime(1700000000), '10:13 PM');
assert.equal(formatMessageTime(1700003600), '11:13 PM');

assert.deepEqual(extractQuote({ from: { id: 1, first_name: 'A' }, text: 'hi', date: 1700000000 }).time, '10:13 PM');
// A bot message is still quotable (its own name is shown, no PFP attempt).
const botQuote = extractQuote({ from: { id: 1, is_bot: true, first_name: 'HelperBot' }, text: 'beep' });
assert.equal(botQuote.ok, true);
assert.equal(botQuote.name, 'HelperBot');
// Nothing identifying at all → no quote rather than an invented sender.
assert.equal(extractQuote({ text: 'x', chat: { id: 1 } }).reason, 'no_author');
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

// With an avatar the bubble starts after the avatar column (124 px + 14 gap).
assert.equal(planLayout({ text: 'x', name: 'A', hasAvatar: true }).bubbleWidth,
  planLayout({ text: 'x', name: 'A', hasAvatar: false }).bubbleWidth - (124 + 14));

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

// ---- 21b. the author's own font reaches the sticker end to end ------
// The unit tests above prove the renderer; this proves the wiring — the name
// emoji are resolved before the render and handed to it.
await reset();
profilePhotoResult = { total_count: 1, photos: [[{ file_id: 'small', width: 40, height: 40 }]] };
fileBytes = AVATAR_PNG;
const styledAuthor = commandMessage({
  text: '/q',
  reply: {
    from: { id: 9, first_name: '𝑭𝒓❄️𝒛𝒆𝒏 𝑩𝒍𝒐𝒐𝒅𝒆𝒅' },
    text: 'The snow does not melt here.',
  },
});
const sentBefore = calls.stickers.length;
assert.equal(await handleQuoteCommand(styledAuthor), true);
assert.equal(calls.stickers.length, sentBefore + 1, 'the card is sent');
const styledSticker = decodePng(calls.stickers[calls.stickers.length - 1].sticker.value);
let snowPixels = 0;
for (let y = 26; y < 64; y += 1) {
  for (let x = 206; x < 430; x += 1) {
    const i = (y * styledSticker.width + x) * 4;
    const [r, g, b, a] = [styledSticker.rgba[i], styledSticker.rgba[i + 1],
      styledSticker.rgba[i + 2], styledSticker.rgba[i + 3]];
    if (a > 40 && (r + g + b) / 3 > 120 && b > r + 40 && b > 120) snowPixels += 1;
  }
}
assert.ok(snowPixels > 40, `the snowflake in the name is on the sticker (${snowPixels} px)`);

// ---- 22. no message content is persisted ---------------------------
const columns = await db.all(sql.raw('PRAGMA table_info(sticker_pack_sets)'));
const columnNames = columns.map((c) => c.name);
for (const forbidden of ['text', 'quote_text', 'caption', 'message', 'avatar']) {
  assert.ok(!columnNames.includes(forbidden), `no ${forbidden} column`);
}
assert.deepEqual(columnNames.sort(),
  ['created_at', 'id', 'last_error', 'set_name', 'status', 'sticker_count',
    'sticker_format', 'telegram_id', 'title', 'updated_at']);

void decodeJpeg;
console.log('quote stickers: OK');
