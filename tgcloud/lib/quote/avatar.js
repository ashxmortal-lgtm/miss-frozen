/**
 * Profile-photo retrieval for quote stickers.
 *
 * Chain: `getUserProfilePhotos` → `getFileContent` → decode → RGB pixels.
 *
 * The runtime has no image codec and no npm packages, so decoding is done by
 * the project's own decoders (quote/png.js, quote/jpeg.js). Every step is
 * fallible in the real world — hidden photo, privacy setting, no photo at all,
 * unsupported encoding, size limits — so each failure returns a reason instead
 * of throwing, and the renderer falls back to a lettered avatar.
 *
 * Nothing is cached: profile photos change, and the sticker is built from the
 * message being quoted right now.
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
