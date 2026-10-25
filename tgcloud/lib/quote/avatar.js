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
 * Order (`resolveAvatar`):
 *   1. the quoted author's own photo — `getUserProfilePhotos`, then the
 *      `getChat` copy for users whose privacy setting hides the list;
 *      `getChat` for a channel or an anonymous admin
 *   2. the emoji from their name, when that name IS an emoji (🕸️): the baked
 *      tile if it is in the core set, otherwise the Twemoji CDN
 *   3. a lettered disc, with the real reason logged
 *
 * There is no bot-photo substitute: MissFrozen's face on someone else's message
 * misattributes the quote. Telegram does not expose every photo to a bot — a
 * privacy setting, a hidden channel photo and a genuine "no photo" all look the
 * same over the API — and it has no API at all for "the emoji Telegram draws as
 * this user's avatar", which is why step 2 re-creates it from the name.
 *
 * Nothing is cached: a profile photo can change at any moment, and the card is
 * built from the message being quoted right now.
 */

import { api, BotApiError } from 'sdk';
import { decodePng, isPng } from './png.js';
import { decodeJpeg, isJpeg } from './jpeg.js';
import { emojiCodepointOf, emojiTileImage, fetchEmojiImage, nameIsEmojiOnly } from './emoji.js';

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
 * Download a file by its `file_id` and decode it.
 *
 * `file_id` is opaque base64-ish data — it may contain `+`, `/`, `_`, `-` or
 * padding. Only emptiness and whitespace are rejected: guessing at the alphabet
 * previously discarded perfectly valid ids and silently produced the lettered
 * avatar for users who do have a photo.
 */
async function downloadAndDecode(fileId) {
  if (typeof fileId !== 'string' || !fileId || /\s/.test(fileId)) {
    return { ok: false, reason: 'no_file_id' };
  }
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
 * Two sources, because Telegram hides the same photo from one of them:
 *   1. `getUserProfilePhotos` — the authoritative list of profile photos
 *   2. `getChat` on the user id — the private-chat object still carries the
 *      photo when the user's privacy setting blocks the first call. This is the
 *      same fallback `bot_avatar.js` uses for the Mini App header.
 *
 * A blocked photo and a genuinely absent photo are indistinguishable over the
 * API, so both end here as `ok: false` and the caller draws the initial.
 *
 * @param {number} userId  author of the quoted message (never the caller)
 * @returns {Promise<{ok:true, image:object, source:'photos'|'chat'}|{ok:false, reason:string}>}
 */
export async function fetchProfilePhoto(userId) {
  if (!userId) return { ok: false, reason: 'no_user' };

  let reason = 'no_photo';
  try {
    const photos = await api.getUserProfilePhotos({ user_id: userId, offset: 0, limit: 1 });
    const list = photos?.photos || [];
    if (list.length) {
      const sizes = list[0] || [];
      const size = pickPhotoSize(sizes) || sizes[PHOTO_SIZE_INDEX] || sizes[0];
      const fileId = size?.file_id || size?.file_unique_id;
      const decoded = await downloadAndDecode(fileId);
      if (decoded.ok) return { ...decoded, source: 'photos' };
      reason = decoded.reason; // e.g. an unsupported encoding — try the chat copy
    }
  } catch (error) {
    reason = error instanceof BotApiError ? `api_${error.code || 'error'}` : 'api_error';
  }

  // The photo may be visible on the chat object even when the list is not.
  const viaChat = await fetchChatPhoto(userId);
  if (viaChat.ok) return { ...viaChat, source: 'chat' };

  return { ok: false, reason };
}

/**
 * Pick the avatar for a quote.
 *
 * Only the **replied-to author's own photo** is ever used. There is deliberately
 * no bot-photo substitute: putting MissFrozen's face on someone else's message
 * misattributes the quote. When the photo is unavailable — no photo set, hidden
 * by a privacy setting, or undecodable — the renderer draws the author's initial
 * in a coloured disc and the real reason is logged.
 *
 * The `/q` invoker's photo is never considered: `quote` only carries the
 * replied-to sender's ids.
 *
 * @param {object} quote  the result of `extractQuote`
 * @returns {Promise<{ok:boolean, image:object|null,
 *   source:'user'|'channel'|'group'|'emoji'|'emoji-fetched'|'initial',
 *   emojiOnly:boolean, reason:string}>}
 */
export async function resolveAvatar(quote = {}) {
  const attempts = [];
  const emojiCodepoint = emojiCodepointOf(quote.name);
  const emojiOnly = nameIsEmojiOnly(quote.name);

  if (quote.senderChatId) {
    // A channel post, or an anonymous admin posting as the group.
    const chat = await fetchChatPhoto(quote.senderChatId);
    if (chat.ok) {
      return { ok: true, image: chat.image, source: quote.isChannel ? 'channel' : 'group', emojiOnly, reason: '' };
    }
    attempts.push(`chat:${chat.reason}`);
  } else if (quote.senderId) {
    const user = await fetchProfilePhoto(quote.senderId);
    if (user.ok) return { ok: true, image: user.image, source: 'user', emojiOnly, reason: '' };
    attempts.push(`user:${user.reason}`);
  } else {
    attempts.push('user:no_user');
  }

  // No photo, but the name is (or contains) an emoji — that emoji is the
  // closest thing this person has to a profile picture. The baked tile first,
  // so the common case never touches the network.
  if (emojiCodepoint) {
    const tile = emojiTileImage(emojiCodepoint);
    if (tile) {
      return { ok: true, image: tile, source: 'emoji', emojiOnly, reason: attempts.join(', ') };
    }
    const downloaded = await fetchEmojiImage(emojiCodepoint);
    if (downloaded) {
      return { ok: true, image: downloaded, source: 'emoji-fetched', emojiOnly, reason: attempts.join(', ') };
    }
    attempts.push(`emoji:unavailable`);
  }

  // Last resort: the renderer draws the author's initial. Log why, so a missing
  // photo is diagnosable rather than a silent blank disc.
  const reason = attempts.join(', ');
  console.error('[quote avatar] lettered fallback —', reason);
  return { ok: false, image: null, source: 'initial', emojiOnly, reason };
}
