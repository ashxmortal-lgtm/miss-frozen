/**
 * Map photos from the private storage channel via cached Telegram file_id values.
 * Private t.me/c/… links are NOT public HTTP URLs — Bot API cannot sendPhoto(url) them.
 * Rich map messages embed the cached file_id directly into one media-bearing message.
 */

import { BotApiError } from 'sdk';
import { api } from '../message_api.js';
import { db } from 'sdk';
import { sql } from 'sdk/db';
import {
  MAP_IMAGE_CHAT_ID,
  MAP_IMAGE_MESSAGE_ID,
  LOCATION_IMAGES,
} from './constants.js';

const memCache = new Map();

async function getCachedFileId(storageMessageId) {
  if (memCache.has(storageMessageId)) return memCache.get(storageMessageId);
  try {
    const row = await db.get(
      sql`SELECT file_id FROM map_media_cache WHERE storage_message_id = ${storageMessageId}`,
    );
    if (row?.file_id) {
      memCache.set(storageMessageId, row.file_id);
      return row.file_id;
    }
  } catch (_) {
    /* table may not exist yet */
  }
  return null;
}

async function putCachedFileId(storageMessageId, fileId) {
  if (!fileId) return;
  memCache.set(storageMessageId, fileId);
  try {
    await db.run(sql`
      INSERT INTO map_media_cache (storage_message_id, file_id)
      VALUES (${storageMessageId}, ${fileId})
      ON CONFLICT(storage_message_id) DO UPDATE SET file_id = excluded.file_id
    `);
  } catch (_) {
    /* ignore cache write failures */
  }
}

function extractFileId(result) {
  try {
    const msg = result?.result || result;
    const photos = msg?.photo;
    if (Array.isArray(photos) && photos.length) {
      return photos[photos.length - 1].file_id;
    }
  } catch (_) {}
  return null;
}

/**
 * Resolve a storage photo's reusable Telegram file_id. copyMessage only returns
 * MessageId, so on a cache miss forward once, read the returned Message.photo,
 * then immediately delete that temporary copy before the Rich Message is sent.
 */
export async function getMapPhotoFileId(chatId, storageMessageId) {
  const sid = storageMessageId || MAP_IMAGE_MESSAGE_ID;
  const cached = await getCachedFileId(sid);
  if (cached) return cached;

  let temporaryMessageId = null;
  let fileId = null;
  try {
    const forwarded = await api.forwardMessage({
      chat_id: chatId,
      from_chat_id: MAP_IMAGE_CHAT_ID,
      message_id: sid,
      disable_notification: true,
    });
    temporaryMessageId = forwarded?.message_id ?? forwarded?.result?.message_id ?? null;
    fileId = extractFileId(forwarded);
    if (fileId) await putCachedFileId(sid, fileId);
    else console.error('[map photo file_id] forward did not return a photo', sid);
  } catch (e) {
    console.error('[map photo file_id]', e?.description || e?.message || e);
  } finally {
    if (temporaryMessageId) {
      try {
        await api.deleteMessage({ chat_id: chatId, message_id: temporaryMessageId });
      } catch (e) {
        console.error('[map photo temporary delete]', e?.description || e?.message || e);
      }
    }
  }
  return fileId;
}

function markupOf(replyMarkup) {
  if (replyMarkup == null) return undefined;
  return typeof replyMarkup === 'string' ? replyMarkup : JSON.stringify(replyMarkup);
}

/**
 * Copy photo from storage channel into chat with caption + keyboard.
 * Does not delete the previous message first (safer if copy fails).
 */
async function copyFromStorage(chatId, storageMessageId, caption, markup) {
  const result = await api.copyMessage({
    chat_id: chatId,
    from_chat_id: MAP_IMAGE_CHAT_ID,
    message_id: storageMessageId,
    caption: caption || '',
    parse_mode: 'HTML',
    ...(markup ? { reply_markup: markup } : {}),
  });
  const fid = extractFileId(result);
  if (fid) await putCachedFileId(storageMessageId, fid);
  const newId = result?.message_id ?? result?.result?.message_id ?? null;
  return { ok: true, messageId: newId, fileId: fid };
}

/**
 * Show map / location photo.
 * preferPhoto=true forces a real photo path (does not treat text-only edit as success).
 */
export async function showMapPhoto({
  chatId,
  messageId = null,
  storageMessageId = MAP_IMAGE_MESSAGE_ID,
  caption,
  replyMarkup,
  preferPhoto = true,
}) {
  const markup = markupOf(replyMarkup);
  const sid = storageMessageId || MAP_IMAGE_MESSAGE_ID;
  const fileId = await getCachedFileId(sid);

  // 1) In-place media swap when we already have file_id + message
  if (fileId && messageId) {
    try {
      const media = {
        type: 'photo',
        media: fileId,
        caption: caption || '',
        parse_mode: 'HTML',
      };
      const payload = {
        chat_id: chatId,
        message_id: messageId,
        media: JSON.stringify(media),
      };
      if (markup) payload.reply_markup = markup;
      await api.editMessageMedia(payload);
      return { ok: true, messageId };
    } catch (e) {
      if (!(e instanceof BotApiError)) console.error('[map editMessageMedia]', e);
      // fall through — try caption edit on existing photo, then copy
      try {
        await api.editMessageCaption({
          chat_id: chatId,
          message_id: messageId,
          caption: caption || '',
          parse_mode: 'HTML',
          ...(markup ? { reply_markup: markup } : {}),
        });
        return { ok: true, messageId };
      } catch (_) {}
    }
  }

  // 2) copyMessage from storage (always try when we need a photo)
  try {
    const copied = await copyFromStorage(chatId, sid, caption, markup);
    if (messageId && copied.messageId) {
      try {
        await api.deleteMessage({ chat_id: chatId, message_id: messageId });
      } catch (_) {}
    }
    return copied;
  } catch (e) {
    console.error('[map copyMessage]', e?.description || e?.message || e);
  }

  // 3) Fallback: edit existing message text/caption (no photo)
  if (messageId && !preferPhoto) {
    try {
      await api.editMessageCaption({
        chat_id: chatId,
        message_id: messageId,
        caption: caption || '',
        parse_mode: 'HTML',
        ...(markup ? { reply_markup: markup } : {}),
      });
      return { ok: true, messageId, noPhoto: true };
    } catch (_) {
      try {
        await api.editMessageText({
          chat_id: chatId,
          message_id: messageId,
          text: caption || '',
          parse_mode: 'HTML',
          ...(markup ? { reply_markup: markup } : {}),
        });
        return { ok: true, messageId, noPhoto: true };
      } catch (_) {}
    }
  }

  // 4) Last resort plain text
  try {
    if (messageId) {
      try {
        await api.deleteMessage({ chat_id: chatId, message_id: messageId });
      } catch (_) {}
    }
    const sent = await api.sendMessage({
      chat_id: chatId,
      text: caption || '🗺️ Map',
      parse_mode: 'HTML',
      ...(markup ? { reply_markup: markup } : {}),
    });
    return {
      ok: true,
      messageId: sent?.message_id ?? sent?.result?.message_id ?? null,
      noPhoto: true,
    };
  } catch (e2) {
    console.error('[map sendMessage fallback]', e2);
    return { ok: false, messageId: null, noPhoto: true };
  }
}

export function storageIdForLocation(locKey) {
  if (locKey == null || locKey === 'home') return MAP_IMAGE_MESSAGE_ID;
  const mid = LOCATION_IMAGES[locKey];
  if (mid == null) return MAP_IMAGE_MESSAGE_ID;
  return mid;
}

export { MAP_IMAGE_MESSAGE_ID, MAP_IMAGE_CHAT_ID };
