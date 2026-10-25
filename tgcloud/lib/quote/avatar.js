/**
 * Profile-photo retrieval for quote stickers.
 *
 * Chain: `getUserProfilePhotos` → `getFileContent` → decode → RGB pixels.
 *
 * The runtime has no image codec and no npm packages, so decoding is done by
 * the project's own decoders (quote/png.js, quote/jpeg.js). Every step is
 * fallible in the real world — hidden photo, privacy setting, no photo at all,
 * unsupported encoding, size limits — so each failure returns a reason instead
 * of throwing, and the caller falls back.
 *
 * Fallback order (`resolveAvatar`):
 *   1. the quoted author's own photo  (user → getUserProfilePhotos,
 *                                      channel/anonymous admin → getChat photo)
 *   2. MissFrozen's own profile photo (`getMe` → getUserProfilePhotos)
 *   3. a lettered disc, with the real reason logged
 *
 * Telegram does not expose every photo to a bot: a privacy setting, a hidden
 * channel photo or an API error all look like "no photo". So an unavailable
 * author photo is never treated as "this person has no photo" — it falls
 * through to the bot's photo instead.
 *
 * The author's photo is never cached (it can change at any moment, and the card
 * is built from the message being quoted right now). Only the *bot's* photo is
 * cached, which is safe: it belongs to this app and changes rarely.
 */

import { api, BotApiError } from 'sdk';
import { decodePng, isPng } from './png.js';
import { decodeJpeg, isJpeg } from './jpeg.js';

/** Telegram returns up to this many sizes; a mid size decodes fast and is crisp. */
const PHOTO_SIZE_INDEX = 1;
/** getFile is capped at 20 MB, but a 160 px avatar is a few KB. */
const MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024;

const asBytes = (result) => {
  if (result instanceof Uint8Array) return result;
  if (result instanceof ArrayBuffer) return new Uint8Array(result);
  if (ArrayBuffer.isView(result)) return new Uint8Array(result.buffer, result.byteOffset, result.byteLength);
  if (result?.bytes) return asBytes(result.bytes);
  if (Array.isArray(result)) return Uint8Array.from(result);
  return null;
};

/** Choose the smallest photo size that is still ≥ 100 px (no upscaling). */
export function pickPhotoSize(sizes = []) {
  if (!Array.isArray(sizes) || !sizes.length) return null;
  const ranked = sizes
    .map((size, index) => ({ size, index }))
    .sort((a, b) => (a.size.width * a.size.height) - (b.size.width * b.size.height));
  const adequate = ranked.find((entry) => Math.min(entry.size.width, entry.size.height) >= 100);
  return (adequate || ranked[ranked.length - 1]).size;
}

/**
 * Decode whatever Telegram returned (JPEG or PNG).
 * @returns {{ok:true, image:{width:number,height:number,rgba:Uint8Array}}|{ok:false, reason:string}}
 */
export function decodeProfilePhoto(bytes) {
  if (!bytes || bytes.length < 32) return { ok: false, reason: 'empty' };
  try {
    if (isPng(bytes)) {
      const image = decodePng(bytes);
      return { ok: true, image };
    }
    if (isJpeg(bytes)) {
      const image = decodeJpeg(bytes);
      return { ok: true, image };
    }
    return { ok: false, reason: 'unsupported_format' };
  } catch (error) {
    return { ok: false, reason: 'decode_failed', detail: String(error?.message || error) };
  }
}

/**
 * Fetch and decode a **channel** photo (channel posts and anonymous admins).
 * `getUserProfilePhotos` only accepts user ids, so the chat photo is read from
 * `getChat` instead. Any failure returns a reason and the caller falls back.
 */
export async function fetchChatPhoto(chatId) {
  if (!chatId) return { ok: false, reason: 'no_chat' };
  let chat;
  try {
    chat = await api.getChat({ chat_id: chatId });
  } catch (error) {
    return { ok: false, reason: 'api_error' };
  }
  const photo = chat?.photo;
  const fileId = photo?.big_file_id || photo?.small_file_id;
  if (!fileId) return { ok: false, reason: 'no_photo' };
  let bytes;
  try {
    bytes = asBytes(await api.getFileContent(fileId));
    if (bytes && bytes.length > MAX_DOWNLOAD_BYTES) return { ok: false, reason: 'too_large' };
  } catch (error) {
    return { ok: false, reason: 'download_failed' };
  }
  return decodeProfilePhoto(bytes);
}

/**
 * Fetch and decode a user's profile photo.
 *
 * @param {number} userId  author of the quoted message (never the caller)
 * @returns {Promise<{ok:true, image:object}|{ok:false, reason:string}>}
 */
export async function fetchProfilePhoto(userId) {
  if (!userId) return { ok: false, reason: 'no_user' };

  let photos;
  try {
    photos = await api.getUserProfilePhotos({ user_id: userId, offset: 0, limit: 1 });
  } catch (error) {
    const reason = error instanceof BotApiError ? `api_${error.code || 'error'}` : 'api_error';
    return { ok: false, reason };
  }

  const list = photos?.photos || [];
  if (!list.length) return { ok: false, reason: 'no_photo' };

  const sizes = list[0] || [];
  const size = pickPhotoSize(sizes) || sizes[PHOTO_SIZE_INDEX] || sizes[0];
  const fileId = size?.file_id || size?.file_unique_id;
  if (!fileId || typeof fileId !== 'string') return { ok: false, reason: 'no_file_id' };
  // Only real file ids are downloadable (file_unique_id is not accepted by getFile).
  if (!/^[\w-]+$/.test(fileId)) return { ok: false, reason: 'bad_file_id' };

  let bytes;
  try {
    const result = await api.getFileContent(fileId);
    bytes = asBytes(result);
    if (bytes && bytes.length > MAX_DOWNLOAD_BYTES) return { ok: false, reason: 'too_large' };
  } catch (error) {
    return { ok: false, reason: 'download_failed' };
  }

  return decodeProfilePhoto(bytes);
}

// ---- MissFrozen's own photo (the documented fallback) ---------------------

/** The bot changes its photo rarely; an hour matches `bot_avatar.js`. */
const BOT_PHOTO_TTL_MS = 60 * 60 * 1000;
/** Do not re-ask Telegram on every /q while the bot has no usable photo. */
const BOT_PHOTO_RETRY_MS = 5 * 60 * 1000;

let botIdCache = null;
let botPhotoCache = null; // { at, image }
let botPhotoFailAt = 0;
let botPhotoFailReason = '';

/** Test hook — forget the cached bot identity and photo. */
export function resetBotPhotoCache() {
  botIdCache = null;
  botPhotoCache = null;
  botPhotoFailAt = 0;
  botPhotoFailReason = '';
}

/** Resolve the bot's own user id once per isolate. */
async function botUserId() {
  if (botIdCache) return botIdCache;
  try {
    const me = await api.getMe();
    if (me && me.id) botIdCache = me.id;
  } catch (error) {
    console.error('[quote avatar] getMe failed',
      error?.description || error?.message || error);
  }
  return botIdCache;
}

/**
 * Fetch (and cache) MissFrozen's own profile photo.
 *
 * @returns {Promise<{ok:true,image:object,source:'bot',cached?:boolean}
 *   |{ok:false,reason:string,source:'bot',cached?:boolean}>}
 */
export async function fetchBotPhoto() {
  const now = Date.now();
  if (botPhotoCache && now - botPhotoCache.at < BOT_PHOTO_TTL_MS) {
    return { ok: true, image: botPhotoCache.image, source: 'bot', cached: true };
  }
  if (botPhotoFailAt && now - botPhotoFailAt < BOT_PHOTO_RETRY_MS) {
    return { ok: false, reason: botPhotoFailReason, source: 'bot', cached: true };
  }

  const id = await botUserId();
  if (!id) {
    botPhotoFailAt = now;
    botPhotoFailReason = 'no_bot_id';
    return { ok: false, reason: 'no_bot_id', source: 'bot' };
  }

  // Same empty-array / API-error / download / decode handling as a user photo.
  let result = await fetchProfilePhoto(id);
  // Some bots only expose a *chat* photo, never a user one — the same fallback
  // `bot_avatar.js` already relies on for the Mini App header.
  if (!result.ok) {
    const chat = await fetchChatPhoto(id);
    if (chat.ok) result = chat;
  }
  if (result.ok) {
    botPhotoCache = { at: now, image: result.image };
    botPhotoFailAt = 0;
    botPhotoFailReason = '';
    return { ok: true, image: result.image, source: 'bot' };
  }

  botPhotoFailAt = now;
  botPhotoFailReason = result.reason;
  return { ok: false, reason: result.reason, source: 'bot' };
}

/**
 * Pick the avatar for a quote, in documented order.
 *
 * Never substitutes the `/q` invoker's photo: `quote` only ever carries the
 * replied-to sender's ids.
 *
 * @param {object} quote  the result of `extractQuote`
 * @returns {Promise<{ok:boolean, image:object|null,
 *   source:'user'|'channel'|'bot'|'initial', reason:string}>}
 */
export async function resolveAvatar(quote = {}) {
  const attempts = [];

  if (quote.senderChatId) {
    const chat = await fetchChatPhoto(quote.senderChatId);
    if (chat.ok) return { ok: true, image: chat.image, source: 'channel', reason: '' };
    attempts.push(`channel:${chat.reason}`);
  } else if (quote.senderId) {
    const user = await fetchProfilePhoto(quote.senderId);
    if (user.ok) return { ok: true, image: user.image, source: 'user', reason: '' };
    attempts.push(`user:${user.reason}`);
  } else {
    attempts.push('user:no_user');
  }

  const bot = await fetchBotPhoto();
  if (bot.ok) {
    return { ok: true, image: bot.image, source: 'bot', reason: attempts.join(', ') };
  }
  attempts.push(`bot:${bot.reason}`);

  // Last resort: the renderer draws the author's initial instead. Log why, so
  // a missing photo is diagnosable rather than a silent blank disc.
  const reason = attempts.join(', ');
  console.error('[quote avatar] lettered fallback —', reason);
  return { ok: false, image: null, source: 'initial', reason };
}
