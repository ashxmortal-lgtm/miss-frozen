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
 *
 * Delivery uses the map layer's rich-message method: the photo is embedded in
 * the message itself (`<figure><img src="tg://photo?id=…"/>` + a `media` entry)
 * and the button is a real rich `<tg-button>`, not a classic inline keyboard —
 * so the caption keeps its exact line spacing and the button stays rich.
 */

import { api } from '../message_api.js';
import { style, mention } from '../texts.js';
import { getMapPhotoFileId } from '../map/media.js';
import { abilityCheckKeyboard } from '../ability.js';
import { richHtml } from '../map/rich.js';

/** Storage-channel message holding the Jiraiya hot-springs photo. */
export const JIRAIYA_MEDIA_MESSAGE_ID = 581;

/** Rich-message media id used for the embedded figure. */
const PHOTO_ID = 'jiraiya_photo';

/**
 * Caption exactly as specified. `research` stays behind a Telegram spoiler;
 * every plain letter is converted to the bot's small-caps style on send.
 * The blank lines are part of the design: three after the mention, one before
 * the last line.
 */
export function jiraiyaDiscoveryCaption(mentionHtml) {
  return `🐸 ${mentionHtml}\n\n\n\n`
    + '🥀 you spotted master jiraiya near the hot springs!\n\n'
    + ' he was busy with his “<span class="tg-spoiler">research</span>”...🤫';
}

/**
 * ONE paragraph, real newlines — exactly the caption as typed.
 *
 * Two earlier attempts made the message enormous:
 *   - a `<p>` per line: every blank line became an empty paragraph, and every
 *     paragraph carries its own margin;
 *   - `<br/>` separators: Telegram's rich HTML has no `<br>` in its supported
 *     tag list, so each one inflates the gap instead of being a plain break.
 * Rich HTML follows classic HTML rules, where a newline inside `<p>` IS the
 * line break, so the caption is kept verbatim inside a single paragraph.
 */
export function captionParagraphs(caption) {
  const text = String(caption).split('\n').map((line) => line.replace(/[ \t]+$/, '')).join('\n');
  return `<p>${text}</p>`;
}

/** Rich photo (as `<figure>`) + caption paragraphs + the rich ability button. */
export function jiraiyaDiscoveryRich(mentionHtml, fileId = null) {
  const body = captionParagraphs(style(jiraiyaDiscoveryCaption(mentionHtml)));
  const figure = fileId
    ? `<figure><img src="tg://photo?id=${PHOTO_ID}"/></figure>`
    : '';
  return {
    html: `${figure}${richHtml(body, abilityCheckKeyboard('Jiraiya'))}`,
    ...(fileId ? { media: [{ id: PHOTO_ID, media: { type: 'photo', media: fileId } }] } : {}),
  };
}

const log = (label, e) => console.error(`[${label}]`, e?.description || e?.message || e);

/**
 * Announce the discovery where the patrol happened: the patrol group first, the
 * player's DM only as a fallback (the group may have the bot restricted).
 *
 * Per target the order is: rich message with the embedded photo, rich message
 * without it (the rich button still works), classic photo + inline button, then
 * plain text + inline button. Returns true when something was delivered.
 */
export async function sendJiraiyaDiscovery(user, groupChatId = null) {
  const mentionHtml = mention(user);
  const keyboard = abilityCheckKeyboard('Jiraiya');
  const button = keyboard ? { reply_markup: keyboard } : {};
  const uniqueIds = (ids) => ids
    .map((id) => Number(id))
    .filter((id, i, all) => id && all.indexOf(id) === i);
  // Delivery order: the group where the Naruto patrol was dispatched, then DM.
  const targets = uniqueIds([groupChatId, user?.id]);
  // Resolve the storage-channel file_id in the DM when possible: the cold cache
  // forwards the photo and deletes it again, which should not flash in the group.
  const resolveTargets = uniqueIds([user?.id, groupChatId]);

  let fileId = null;
  for (const chatId of resolveTargets) {
    fileId = await getMapPhotoFileId(chatId, JIRAIYA_MEDIA_MESSAGE_ID);
    if (fileId) break;
  }
  const caption = style(jiraiyaDiscoveryCaption(mentionHtml));

  for (const chatId of targets) {
    if (fileId) {
      try {
        await api.sendRichMessage({
          chat_id: chatId,
          rich_message: jiraiyaDiscoveryRich(mentionHtml, fileId),
        });
        return true;
      } catch (e) {
        log('jiraiya rich media', e);
      }
    }
    try {
      await api.sendRichMessage({
        chat_id: chatId,
        rich_message: jiraiyaDiscoveryRich(mentionHtml),
      });
      return true;
    } catch (e) {
      log('jiraiya rich', e);
    }
    if (fileId) {
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
        log('jiraiya media', e);
      }
    }
    try {
      await api.sendMessage({
        chat_id: chatId,
        text: caption,
        parse_mode: 'HTML',
        ...button,
      });
      return true;
    } catch (e) {
      log('jiraiya discovery', e);
    }
  }
  return false;
}
