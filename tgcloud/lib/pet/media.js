/**
 * Pet photos from the private storage channel.
 *
 * The spec links (t.me/c/3889508991/540 and /541) are private Telegram message
 * links, NOT public HTTP photo URLs — Bot API cannot sendPhoto(url) them.
 * Resolve them through the same storage-channel copy path as the map artwork:
 * forward once to obtain a reusable file_id (cached in map_media_cache), then
 * let the caller embed that file_id.
 */

import { PETS, PET_IMAGE_CHAT_ID } from './defs.js';
import { getStoragePhotoFileId } from '../map/media.js';

export async function getPetPhotoFileId(chatId, petId) {
  const def = PETS[String(petId || '').toLowerCase()];
  if (!def || !def.imageMessageId) return null;
  return getStoragePhotoFileId(chatId, PET_IMAGE_CHAT_ID, def.imageMessageId);
}
