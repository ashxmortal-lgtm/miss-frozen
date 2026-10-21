/**
 * Rich Message helpers for Game Hub (Bot API 10.3+).
 * Buttons via <tg-button-row> / <tg-button type="callback_data">.
 */
import { BotApiError } from 'sdk';
import { api } from '../message_api.js';
import { escapeHtml, style, mention } from '../texts.js';

function btnLabel(text) {
  return String(text).replace(/</g, '').replace(/>/g, '');
}

export function richBtn(text, data, btnStyle = null) {
  const s = btnStyle ? ` style="${btnStyle}"` : '';
  return `<tg-button type="callback_data"${s} data="${escapeHtml(data)}">${btnLabel(text)}</tg-button>`;
}

export function richRow(buttons, align = 'left') {
  return `<tg-button-row align="${align}">${buttons.join('')}</tg-button-row>`;
}

export function keyboardToRich(keyboard, align = 'left') {
  const rows = keyboard?.inline_keyboard || [];
  return rows
    .map((row) => richRow(row.map((b) => richBtn(b.text, b.callback_data, b.style || null)), align))
    .join('');
}

export function richHtml(bodyHtml, keyboard, align = 'left') {
  return `${bodyHtml || ''}${keyboard ? keyboardToRich(keyboard, align) : ''}`;
}

export function gameBody(user, inner) {
  if (user) return style(`<p>${mention(user)}</p>${inner}`);
  return style(inner);
}

export async function sendGameRich(chatId, bodyHtml, keyboard, extra = {}, align = 'left') {
  const html = richHtml(bodyHtml, keyboard, align);
  try {
    return await api.sendRichMessage({
      chat_id: chatId,
      rich_message: { html },
      ...extra,
    });
  } catch (e) {
    if (!(e instanceof BotApiError)) throw e;
    console.error('[games rich send fallback]', e);
    const plain = bodyHtml
      .replace(/<tg-button-row[\s\S]*?<\/tg-button-row>/gi, '')
      .replace(/<tg-button[\s\S]*?<\/tg-button>/gi, '');
    return await api.sendMessage({
      chat_id: chatId,
      text: plain || 'Game',
      parse_mode: 'HTML',
      reply_markup: keyboard || undefined,
      ...extra,
    });
  }
}

export async function editGameRich(chatId, messageId, bodyHtml, keyboard, align = 'left') {
  const html = richHtml(bodyHtml, keyboard, align);
  try {
    await api.editMessageText({
      chat_id: chatId,
      message_id: messageId,
      rich_message: { html },
    });
    return true;
  } catch (e) {
    if (!(e instanceof BotApiError)) console.error('[games rich edit]', e);
  }
  const plain = bodyHtml
    .replace(/<tg-button-row[\s\S]*?<\/tg-button-row>/gi, '')
    .replace(/<tg-button[\s\S]*?<\/tg-button>/gi, '');
  try {
    await api.editMessageText({
      chat_id: chatId,
      message_id: messageId,
      text: plain,
      parse_mode: 'HTML',
      reply_markup: keyboard ? JSON.stringify(keyboard) : undefined,
    });
    return true;
  } catch (e2) {
    if (!(e2 instanceof BotApiError && e2.code === 400)) console.error(e2);
    return false;
  }
}

export function p(html) {
  return `<p>${html}</p>`;
}

export function h(title) {
  return p(`<b>${title}</b>`);
}
