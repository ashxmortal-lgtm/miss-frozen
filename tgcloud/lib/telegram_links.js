import { escapeHtml } from './texts.js';

export function groupChatLink(chat, messageId) {
  const title = escapeHtml(chat?.title || 'group');
  let url = '';
  if (chat?.username) {
    url = `https://t.me/${encodeURIComponent(String(chat.username))}`;
  } else if (chat?.type === 'supergroup' && /^-100\d+$/.test(String(chat.id)) && Number.isInteger(Number(messageId)) && Number(messageId) > 0) {
    const channelId = String(chat.id).slice(4);
    url = `https://t.me/c/${channelId}/${Number(messageId)}`;
  }
  return url ? `<a href="${url}">${title}</a>` : title;
}
