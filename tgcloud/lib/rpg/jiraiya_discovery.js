/**
 * Jiraiya discovery announcement.
 *
 * Naruto's patrols can turn up Master Jiraiya. The reward card already says he
 * joined the roster; this is the same style of moment as finding Tsunade — a
 * photo from the private storage channel (t.me/c/3889508991/581, message 581)
 * with the discovery caption and the `Check ❄️ ability` button that opens his
 * guide post (https://t.me/frozenblooded/14).
 *
 * Private t.me/c/… links are not HTTP photo URLs, so the image is resolved
 * through the shared storage-channel file_id cache (map/media.js).
 */

import { api } from '../message_api.js';
import { style, mention } from '../texts.js';
import { getMapPhotoFileId } from '../map/media.js';
import { abilityCheckKeyboard } from '../ability.js';

/** Storage-channel message holding the Jiraiya hot-springs photo. */
export const JIRAIYA_MEDIA_MESSAGE_ID = 581;

/**
 * Caption exactly as specified. `research` is hidden behind a Telegram spoiler;
 * every plain letter is converted to the bot's small-caps style on send.
 */
export function jiraiyaDiscoveryCaption(mentionHtml) {
  return `🐸 ${mentionHtml}\n\n\n`
    + '🥀 you spotted master jiraiya near the hot springs!\n\n\n'
    + ' he was busy with his “<span class="tg-spoiler">research</span>”...🤫';
}

/**
 * DM the discovery card (photo + caption + ability button).
 * Falls back to the group where the patrol ran when the DM is unreachable, and
 * to a text message when the photo cannot be resolved. Returns true when
 * something was delivered.
 */
export async function sendJiraiyaDiscovery(user, fallbackChatId = null) {
  const caption = style(jiraiyaDiscoveryCaption(mention(user)));
  const keyboard = abilityCheckKeyboard('Jiraiya');
  const button = keyboard ? { reply_markup: keyboard } : {};
  const targets = [user?.id, fallbackChatId]
    .map((id) => Number(id))
    .filter((id, i, all) => id && all.indexOf(id) === i);

  for (const chatId of targets) {
    const fileId = await getMapPhotoFileId(chatId, JIRAIYA_MEDIA_MESSAGE_ID);
    if (!fileId) continue;
    try {
      await api.sendPhoto({
        chat_id: chatId,
        photo: fileId,
        caption,
        parse_mode: 'HTML',
        ...button,
      });
      return true;
    } catch (e) {
      console.error('[jiraiya media]', e?.description || e?.message || e);
    }
  }

  for (const chatId of targets) {
    try {
      await api.sendMessage({
        chat_id: chatId,
        text: caption,
        parse_mode: 'HTML',
        ...button,
      });
      return true;
    } catch (e) {
      console.error('[jiraiya discovery]', e?.description || e?.message || e);
    }
  }
  return false;
}
