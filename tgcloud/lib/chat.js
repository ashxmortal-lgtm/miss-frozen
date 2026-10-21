import { db, BotApiError } from 'sdk';
import { api } from './message_api.js';
import { sql } from 'sdk/db';

export const CLEAN_AFTER = 300; // 5 minutes
// Chat IDs whose bot messages are NOT deleted (exception list, add later).
const EXEMPT_CHATS = new Set();

const now = () => Math.floor(Date.now() / 1000);

export async function trackUser(user) {
  await db.run(sql`INSERT OR IGNORE INTO users (telegram_id, balance) VALUES (${user.id}, 0)`);
  await db.run(sql`UPDATE users SET username = ${user.username ? user.username.toLowerCase() : null}, first_name = ${user.first_name || null} WHERE telegram_id = ${user.id}`);
}

// Group chat IDs are negative; private chats are positive.
async function remember(chatId, sent) {
  if (chatId >= 0 || EXEMPT_CHATS.has(chatId) || !sent || !sent.message_id) return;
  try {
    await db.run(sql`INSERT INTO cleanup (chat_id, message_id, delete_at) VALUES (${chatId}, ${sent.message_id}, ${now() + CLEAN_AFTER})`);
  } catch (e) { console.error(e); }
}

function deliveryExtra(params) {
  const extra = {};
  if (params.reply_parameters) extra.reply_parameters = params.reply_parameters;
  if (params.message_thread_id) extra.message_thread_id = params.message_thread_id;
  if (params.ephemeral_message_parameters) extra.ephemeral_message_parameters = params.ephemeral_message_parameters;
  return extra;
}
function toRichHtml(text) {
  const para = (s) => s.split('\n').map((l) => l.trim()).filter(Boolean)
    .map((l) => `<p>${l}</p>`).join('');
  return text.split(/(<blockquote>[\s\S]*?<\/blockquote>)/).map((seg) => {
    const m = seg.match(/^<blockquote>([\s\S]*?)<\/blockquote>$/);
    return m ? `<blockquote>${para(m[1])}</blockquote>` : para(seg);
  }).join('');
}

// Every HTML text without an inline keyboard goes out as a rich message.
// If Telegram refuses it, the classic message is sent instead.
export async function send(chatId, params) {
  let sent;
  if (params.parse_mode === 'HTML' && params.text && !params.reply_markup) {
    try {
      const extra = deliveryExtra(params);
      sent = await api.sendRichMessage({
        chat_id: chatId, rich_message: { html: toRichHtml(params.text) }, ...extra,
      });
    } catch (e) {
      if (!(e instanceof BotApiError)) throw e;
      console.error(e);
    }
  }
  if (!sent) sent = await api.sendMessage({ chat_id: chatId, ...params });
  await remember(chatId, sent);
  return sent;
}

export async function sendRich(chatId, params) {
  const extra = deliveryExtra(params);
  const sent = await api.sendRichMessage({ chat_id: chatId, ...extra, ...params });
  await remember(chatId, sent);
  return sent;
}

// Runs on every incoming message. No scheduler exists, so this is how
// due messages get deleted.
export async function sweepMessages() {
  const due = await db.all(sql`SELECT id, chat_id, message_id FROM cleanup WHERE delete_at <= ${now()} ORDER BY delete_at LIMIT 20`);
  for (const r of due) {
    await db.run(sql`DELETE FROM cleanup WHERE id = ${r.id}`);
    try {
      await api.deleteMessage({ chat_id: r.chat_id, message_id: r.message_id });
    } catch (e) { /* already deleted */ }
  }
}
