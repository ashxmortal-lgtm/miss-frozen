/**
 * The bot's own profile picture as a data: URI for the Mini App header.
 * Downloaded by file_id (the bot token never reaches the browser) and cached
 * in memory for an hour. Returns '' when the bot has no photo or Telegram
 * refuses, so the UI falls back to the snowflake.
 */
import { api } from './message_api.js';
import { asUint8Array, bytesToBase64 } from './base64.js';

const TTL_MS = 60 * 60 * 1000;
let cache = { at: 0, value: '' };

async function findFileId(botId) {
  try {
    const res = await api.getUserProfilePhotos({ user_id: botId, limit: 1 });
    const sizes = res && res.photos && res.photos[0];
    if (sizes && sizes.length) {
      // Smallest size ≥ 160px keeps the payload small but sharp.
      const pick = sizes.find((s) => s.width >= 160) || sizes[sizes.length - 1];
      return pick.file_id;
    }
  } catch (_) { /* fall through */ }
  try {
    const chat = await api.getChat({ chat_id: botId });
    return (chat && chat.photo && (chat.photo.big_file_id || chat.photo.small_file_id)) || '';
  } catch (_) {
    return '';
  }
}

export async function botAvatarDataUri() {
  if (Date.now() - cache.at < TTL_MS) return cache.value;
  let value = '';
  try {
    const me = await api.getMe();
    const fileId = await findFileId(me.id);
    if (fileId) {
      const bytes = asUint8Array(await api.getFileContent(fileId));
      if (bytes && bytes.byteLength > 0 && bytes.byteLength < 400 * 1024) {
        value = `data:image/jpeg;base64,${bytesToBase64(bytes)}`;
      }
    }
  } catch (e) {
    console.error('[bot avatar]', e?.description || e?.message || e);
  }
  cache = { at: Date.now(), value };
  return value;
}
