import { style } from './texts.js';
import {
  FROZEN_BLOODED_TEXT,
  FROZEN_BLOODED_URL,
  isFrozenBloodedLabel,
} from './universal_buttons.js';

const TEXT_FIELDS = new Set([
  'text', 'caption', 'question', 'explanation', 'description', 'title', 'label',
]);
const BUTTON_LIST_FIELDS = new Set(['inline_keyboard', 'keyboard', 'buttons']);
const BUTTON_ACTION_FIELDS = new Set([
  'callback_data', 'url', 'login_url', 'web_app', 'switch_inline_query',
  'switch_inline_query_current_chat', 'switch_inline_query_chosen_chat',
  'switch_inline_query_inline', 'switch_inline_query_business', 'request_contact',
  'request_location', 'request_poll', 'request_users', 'request_chat',
  'copy_text', 'callback_game', 'pay',
]);
const TEXT_TYPES_TO_PRESERVE = new Set([
  'code', 'pre', 'url', 'text_link', 'text_url', 'text_mention',
  'copy_text',
]);
const BUTTON_STYLES = new Set(['primary', 'success', 'danger']);

function styleRichHtml(html) {
  return style(html).replace(/<tg-button(?=\s|>)([^>]*)>([\s\S]*?)<\/tg-button>/gi, (_tag, attrs, content) => {
    const label = content.replace(/<[^>]*>/g, '').trim();
    if (isFrozenBloodedLabel(label)) {
      const safeAttrs = attrs.replace(/\s+(?:type|url|data|style)\s*=\s*("[^"]*"|'[^']*')/gi, '');
      return `<tg-button${safeAttrs} type="url" url="${FROZEN_BLOODED_URL}" style="danger">${FROZEN_BLOODED_TEXT}</tg-button>`;
    }
    const requestedStyle = attrs.match(/\sstyle\s*=\s*(["'])(.*?)\1/i)?.[2]?.toLowerCase();
    const callbackData = attrs.match(/\sdata\s*=\s*(["'])(.*?)\1/i)?.[2] || '';
    const withoutExistingStyle = attrs.replace(/\sstyle\s*=\s*("[^"]*"|'[^']*')/gi, '');
    if (requestedStyle === 'transparent' || callbackData.startsWith('map_')) {
      return `<tg-button${withoutExistingStyle}>${content}</tg-button>`;
    }
    const richStyles = new Set(['primary', 'success', 'danger', 'link']);
    const resolvedStyle = richStyles.has(requestedStyle) ? requestedStyle : 'primary';
    return `<tg-button${withoutExistingStyle} style="${resolvedStyle}">${content}</tg-button>`;
  });
}

function transform(value, key = '', parentType = '', inButtonList = false) {
  if (typeof value === 'string') {
    if (key === 'reply_markup') {
      try {
        return JSON.stringify(transform(JSON.parse(value), key, parentType, inButtonList));
      } catch (_) {
        return value;
      }
    }
    if (key === 'html') return styleRichHtml(value);
    if (TEXT_FIELDS.has(key) && !TEXT_TYPES_TO_PRESERVE.has(parentType)) {
      return style(value);
    }
    return value;
  }
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.map((item) => transform(item, key, parentType, inButtonList));
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;

  const type = typeof value.type === 'string' ? value.type : parentType;
  const buttonList = inButtonList || BUTTON_LIST_FIELDS.has(key);
  const mapButton = typeof value.callback_data === 'string' && value.callback_data.startsWith('map_');
  const button = type !== 'copy_text' && typeof value.text === 'string'
    && (buttonList || (!TEXT_TYPES_TO_PRESERVE.has(type)
      && [...BUTTON_ACTION_FIELDS].some((field) => field in value)));
  const result = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    const childType = childKey === 'copy_text' ? 'copy_text' : type;
    result[childKey] = transform(childValue, childKey, childType, buttonList);
  }
  if (button) {
    if (isFrozenBloodedLabel(value.text)) {
      result.text = FROZEN_BLOODED_TEXT;
      for (const field of BUTTON_ACTION_FIELDS) delete result[field];
      result.url = FROZEN_BLOODED_URL;
      result.style = 'danger';
    } else {
      result.text = style(value.text);
      if (value.style === 'transparent' || mapButton) delete result.style;
      else if (BUTTON_STYLES.has(value.style)) result.style = value.style;
      else result.style = 'primary';
    }
  }
  return result;
}

export function styleOutgoingPayload(payload) {
  return transform(payload);
}
