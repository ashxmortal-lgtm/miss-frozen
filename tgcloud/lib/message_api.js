import { api as telegramApi } from 'sdk';
import { styleOutgoingPayload } from './message_style.js';
import { isFrozenBloodedLabel } from './universal_buttons.js';

const esc = (value) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (value) => esc(value).replace(/"/g, '&quot;');

function readInlineKeyboard(replyMarkup) {
  if (typeof replyMarkup === 'string') {
    try { replyMarkup = JSON.parse(replyMarkup); } catch (_) { return null; }
  }
  return Array.isArray(replyMarkup?.inline_keyboard) ? replyMarkup.inline_keyboard : null;
}

function richButton(button) {
  if (!button || typeof button !== 'object' || typeof button.text !== 'string') return null;
  const actionKeys = [
    'callback_data', 'url', 'web_app', 'login_url',
    'switch_inline_query', 'switch_inline_query_current_chat',
    'switch_inline_query_chosen_chat', 'copy_text',
  ].filter((key) => Object.prototype.hasOwnProperty.call(button, key));
  if (actionKeys.length !== 1) return null;

  const action = actionKeys[0];
  let type;
  let attrs = '';
  const attr = (name, value) => ` ${name}="${escAttr(value)}"`;
  if (action === 'callback_data') {
    type = 'callback_data';
    attrs = attr('data', button.callback_data);
  } else if (action === 'url') {
    type = 'url';
    attrs = attr('url', button.url);
  } else if (action === 'web_app') {
    type = 'web_app';
    if (!button.web_app?.url) return null;
    attrs = attr('url', button.web_app.url);
  } else if (action === 'login_url') {
    type = 'login_url';
    if (!button.login_url?.url) return null;
    attrs = attr('url', button.login_url.url);
    if (button.login_url.forward_text) attrs += attr('forward-text', button.login_url.forward_text);
    if (button.login_url.request_write_access) attrs += ' request-write-access';
  } else if (action === 'switch_inline_query' || action === 'switch_inline_query_current_chat') {
    type = action;
    attrs = attr('query', button[action] ?? '');
  } else if (action === 'switch_inline_query_chosen_chat') {
    type = action;
    const chosen = button.switch_inline_query_chosen_chat || {};
    attrs = attr('query', chosen.query ?? '');
    for (const [field, htmlField] of [
      ['allow_user_chats', 'allow-user-chats'],
      ['allow_bot_chats', 'allow-bot-chats'],
      ['allow_group_chats', 'allow-group-chats'],
      ['allow_channel_chats', 'allow-channel-chats'],
    ]) {
      if (chosen[field]) attrs += ` ${htmlField}`;
    }
  } else if (action === 'copy_text') {
    type = 'copy_text';
    if (typeof button.copy_text?.text !== 'string') return null;
    attrs = attr('text', button.copy_text.text);
  }

  const style = ['primary', 'success', 'danger', 'link'].includes(button.style)
    ? attr('style', button.style)
    : '';
  return `<tg-button type="${type}"${style}${attrs}>${esc(button.text)}</tg-button>`;
}

function richRows(keyboard) {
  const result = [];
  for (const originalRow of keyboard) {
    if (!Array.isArray(originalRow)) return null;
    let row = [];
    const flush = () => {
      if (row.length) result.push(`<tg-button-row align="center">${row.join('')}</tg-button-row>`);
      row = [];
    };
    for (const button of originalRow) {
      const rendered = richButton(button);
      if (!rendered) return null;
      if (isFrozenBloodedLabel(button.text)) {
        flush();
        result.push(`<tg-button-row align="center">${rendered}</tg-button-row>`);
      } else {
        row.push(rendered);
      }
    }
    flush();
  }
  return result.join('');
}

function htmlFromText(text, parseMode) {
  const value = String(text ?? '');
  if (!value) return null;
  if (parseMode && String(parseMode).toLowerCase() !== 'html') return null;
  if (parseMode && String(parseMode).toLowerCase() === 'html') {
    const paragraphs = (segment) => segment.split('\n').map((line) => line.trim()).filter(Boolean)
      .map((line) => `<p>${line}</p>`).join('');
    return value.split(/(<blockquote>[\s\S]*?<\/blockquote>)/).map((segment) => {
      const match = segment.match(/^<blockquote>([\s\S]*?)<\/blockquote>$/);
      return match ? `<blockquote>${paragraphs(match[1])}</blockquote>` : paragraphs(segment);
    }).join('');
  }
  return value.split('\n').map((line) => `<p>${esc(line) || '<br/>'}</p>`).join('');
}

function richCall(methodName, payload) {
  if (methodName !== 'sendMessage' && methodName !== 'editMessageText') return null;
  if (payload.entities || payload.caption_entities) return null;
  const keyboard = readInlineKeyboard(payload.reply_markup);
  if (!keyboard?.length) return null;
  const textHtml = htmlFromText(payload.text, payload.parse_mode);
  const buttonsHtml = richRows(keyboard);
  if (!textHtml || !buttonsHtml) return null;

  const { text: _text, parse_mode: _parseMode, entities: _entities, reply_markup: _markup, ...options } = payload;
  return {
    method: methodName === 'sendMessage' ? 'sendRichMessage' : 'editMessageText',
    payload: { ...options, rich_message: { html: `${textHtml}${buttonsHtml}` } },
  };
}

// Convert the common Bot API inline-keyboard methods at the API boundary. Rich
// keyboard rows retain callback/URL/Web App/copy actions. Unsupported methods
// or button actions remain on the original Bot API path without losing behavior.
export const api = new Proxy(telegramApi, {
  get(target, property) {
    const method = Reflect.get(target, property, target);
    if (typeof method !== 'function') return method;
    return async (...args) => {
      if (args.length > 0) args[0] = styleOutgoingPayload(args[0]);
      const payload = args[0];
      const converted = payload && typeof payload === 'object' ? richCall(String(property), payload) : null;
      if (converted && typeof target[converted.method] === 'function') {
        try {
          return await Reflect.apply(target[converted.method], target, [converted.payload, ...args.slice(1)]);
        } catch (error) {
          // A Rich Message validation error should not make a previously working
          // keyboard fail. Retry once via the classic method for Bot API 400s.
          if (Number(error?.code) !== 400) throw error;
        }
      }
      return Reflect.apply(method, target, args);
    };
  },
});
