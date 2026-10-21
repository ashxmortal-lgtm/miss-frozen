/**
 * Rich Message helpers for the map layer (Bot API 10.3+).
 * Buttons live inside the rich HTML via <tg-button-row> / <tg-button>,
 * not only as classic reply_markup.
 *
 * Docs: https://core.telegram.org/bots/api#richmessage
 *       https://core.telegram.org/bots/api#richmessagebutton
 */

import { BotApiError } from 'sdk';
import { api } from '../message_api.js';
import { escapeHtml, style, mention } from '../texts.js';

/**
 * One callback button inside a rich message.
 * @param {string} text visible label
 * @param {string} data callback_data (≤64 bytes)
 * @param {'primary'|'success'|'danger'|'link'|null} style
 */
export function richBtn(text, data, btnStyle = null) {
  const styleAttr = btnStyle ? ` style="${btnStyle}"` : '';
  return `<tg-button type="callback_data"${styleAttr} data="${escapeHtml(data)}">${escapeHtml(text)}</tg-button>`;
}

function richButton(button) {
  if (button?.callback_data != null) return richBtn(button.text, button.callback_data, button.style || 'transparent');
  if (button?.url) {
    const styleAttr = ` style="${button.style || 'transparent'}"`;
    return `<tg-button type="url"${styleAttr} url="${escapeHtml(button.url)}">${escapeHtml(button.text)}</tg-button>`;
  }
  return '';
}

/** One row of rich buttons (1–8). align: left|center|right */
export function richRow(buttonsHtml, align = 'center') {
  return `<tg-button-row align="${align}">${buttonsHtml.join('')}</tg-button-row>`;
}

/**
 * Convert classic { inline_keyboard: [[{text, callback_data}]] }
 * into rich <tg-button-row> HTML.
 */
export function keyboardToRichRows(keyboard) {
  const rows = keyboard?.inline_keyboard || [];
  return rows
    .map((row) => {
      const btns = row.map(richButton).filter(Boolean);
      if (!btns.length) return '';
      return richRow(btns);
    })
    .join('');
}

/** Build full rich HTML: body paragraphs + button rows. */
export function richHtml(bodyHtml, keyboard) {
  const body = bodyHtml || '';
  const rows = keyboard ? keyboardToRichRows(keyboard) : '';
  return `${body}${rows}`;
}

function inputRichMessage(bodyHtml, keyboard, mediaFileId, mediaCaption) {
  const media = mediaFileId
    ? [{ id: 'map_photo', media: { type: 'photo', media: mediaFileId } }]
    : [];
  const figure = mediaFileId
    ? `<figure><img src="tg://photo?id=map_photo"/>${mediaCaption ? `<figcaption>${mediaCaption}</figcaption>` : ''}</figure>`
    : '';
  return {
    html: `${figure}${richHtml(bodyHtml, keyboard)}`,
    ...(media.length ? { media } : {}),
  };
}

/**
 * Send a rich map message. If Rich Messages are unavailable, send text only;
 * map actions must never silently downgrade to ordinary inline buttons.
 * Returns the sent message object (or null).
 */
export async function sendMapRich(chatId, bodyHtml, keyboard, options = {}) {
  const { mediaFileId, mediaCaption, ...apiOptions } = options;
  try {
    return await api.sendRichMessage({
      chat_id: chatId,
      rich_message: inputRichMessage(bodyHtml, keyboard, mediaFileId, mediaCaption),
      ...apiOptions,
    });
  } catch (e) {
    if (!(e instanceof BotApiError)) throw e;
    console.error('[map rich send fallback]', e);
    if (mediaFileId) {
      try {
        return await api.sendRichMessage({
          chat_id: chatId,
          rich_message: inputRichMessage(bodyHtml, keyboard),
          ...apiOptions,
        });
      } catch (e2) {
        if (!(e2 instanceof BotApiError)) throw e2;
        console.error('[map rich text-only send fallback]', e2);
      }
    }
    // Keep the text readable, but do not downgrade rich controls to a classic keyboard.
    const plain = bodyHtml
      .replace(/<tg-button-row[\s\S]*?<\/tg-button-row>/gi, '')
      .replace(/<tg-button[\s\S]*?<\/tg-button>/gi, '');
    return await api.sendMessage({
      chat_id: chatId,
      text: plain || '🗺️ Map',
      parse_mode: 'HTML',
      ...apiOptions,
    });
  }
}

/**
 * Edit an existing message to rich content (+ embedded buttons).
 * If editing rich content fails, keep the fallback text-only rather than
 * attaching a conventional keyboard.
 */
export async function editMapRich(chatId, messageId, bodyHtml, keyboard, options = {}) {
  const { mediaFileId, mediaCaption } = options;
  try {
    await api.editMessageText({
      chat_id: chatId,
      message_id: messageId,
      rich_message: inputRichMessage(bodyHtml, keyboard, mediaFileId, mediaCaption),
    });
    return true;
  } catch (e) {
    if (!(e instanceof BotApiError)) console.error('[map rich edit]', e);
  }
  if (mediaFileId) {
    try {
      await api.editMessageText({
        chat_id: chatId,
        message_id: messageId,
        rich_message: inputRichMessage(bodyHtml, keyboard),
      });
      return false;
    } catch (e) {
      if (!(e instanceof BotApiError)) console.error('[map rich text-only edit fallback]', e);
    }
  }
  // Text-only fallback for clients/platforms that reject rich edits.
  const plain = bodyHtml
    .replace(/<tg-button-row[\s\S]*?<\/tg-button-row>/gi, '')
    .replace(/<tg-button[\s\S]*?<\/tg-button>/gi, '');
  try {
    await api.editMessageText({
      chat_id: chatId,
      message_id: messageId,
      text: plain,
      parse_mode: 'HTML',
    });
    return false;
  } catch (_) {}
  try {
    await api.editMessageCaption({
      chat_id: chatId,
      message_id: messageId,
      caption: plain,
      parse_mode: 'HTML',
    });
    return false;
  } catch (e2) {
    if (!(e2 instanceof BotApiError && e2.code === 400)) console.error(e2);
    return false;
  }
}

/** Mention + blank line + body, in bot style font. */
export function mapBody(user, innerHtml) {
  return style(`<p>${mention(user)}</p>${innerHtml}`);
}
