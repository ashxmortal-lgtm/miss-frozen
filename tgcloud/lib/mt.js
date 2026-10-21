import { db } from 'sdk';
import { api } from './message_api.js';
import { eq } from 'sdk/db';
import { inventory } from '../schema.js';

const MAX_LEN = 1000;
const JUTSU_NAMES = ['mind transmission', 'mind transmission jutsu', 'mind_transmission', 'mt jutsu'];

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const mentionHtml = (u) => {
  if (!u?.id) return 'User';
  return `<a href="tg://user?id=${u.id}">${esc(u.first_name || 'User')}</a>`;
};

let MT_CMD_REGISTERED = false;

export async function ensureMtEphemeralCommand() {
  if (MT_CMD_REGISTERED) return;
  try {
    await api.setMyCommands({
      scope: { type: 'all_group_chats' },
      commands: [
        { command: 'mt', description: 'Mind Transmission (reply + text)', is_ephemeral: true },
      ],
    });
    MT_CMD_REGISTERED = true;
  } catch (e) {
    console.error('setMyCommands mt ephemeral failed:', e?.description || e);
  }
}

async function hasMtJutsu(userId) {
  const rows = await db.select().from(inventory).where(eq(inventory.telegramId, userId)).all();
  return rows.some((r) => {
    const n = String(r.itemName || '').toLowerCase();
    return JUTSU_NAMES.some((j) => n === j || n.includes('mind transmission'));
  });
}

async function sendEphemeral(chatId, receiverUserId, text) {
  return api.sendMessage({
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    ephemeral_message_parameters: { receiver_user_id: receiverUserId },
  });
}

/** Best-effort: hide the /mt command from the group timeline */
async function hideCommandMessage(message) {
  // 1) If Telegram delivered it as ephemeral already, nothing to do
  if (message.ephemeral_message_id) return;
  // 2) Backup: delete the plain group message so others can't read it
  try {
    await api.deleteMessage({ chat_id: message.chat.id, message_id: message.message_id });
  } catch (_) {
    // no delete rights — cannot fully hide a non-ephemeral command
  }
}

export async function handleMtCommand(message) {
  const text = message.text || '';
  if (!text.startsWith('/')) return false;
  const head = text.split(/\s+/)[0];
  const [rawCmd, atTarget] = head.slice(1).split('@');
  if (rawCmd.toLowerCase() !== 'mt') return false;

  if (atTarget) {
    try {
      const me = await api.getMe();
      if (atTarget.toLowerCase() !== String(me.username || '').toLowerCase()) return true;
    } catch (_) {}
  }

  await ensureMtEphemeralCommand();

  const from = message.from;
  if (!from || from.is_bot) return true;

  const chat = message.chat;
  const isGroup = chat.type === 'group' || chat.type === 'supergroup';
  const payload = text.replace(/^\/mt(@\w+)?\s*/i, '').trim();

  // Always try to hide the invoking command from the group first
  if (isGroup) await hideCommandMessage(message);

  const tellSender = async (html) => {
    if (isGroup) {
      try {
        await sendEphemeral(chat.id, from.id, html);
        return;
      } catch (e) {
        console.error('ephemeral to sender failed:', e?.description || e);
      }
    }
    if (chat.type === 'private') {
      try {
        await api.sendMessage({ chat_id: from.id, text: html, parse_mode: 'HTML' });
      } catch (_) {}
    }
  };

  if (!isGroup) {
    await tellSender(
      `${mentionHtml(from)}\n\n⚠️ <b>GROUP ONLY</b>\n\n/mt works inside a group — reply to the receiver’s message.`,
    );
    return true;
  }

  if (!(await hasMtJutsu(from.id))) {
    await tellSender(
      `${mentionHtml(from)}\n\n🔒 <b>JUTSU NOT UNLOCKED</b>\n\nYou need Mind Transmission Jutsu 🧠 to use /mt.\n\nUnlock it from /shinobi_store to continue.`,
    );
    return true;
  }

  const rt = message.reply_to_message;
  if (!rt?.from) {
    await tellSender(
      `${mentionHtml(from)}\n\n⚠️ <b>REPLY REQUIRED</b>\n\nReply to the intended receiver’s message to use /mt.`,
    );
    return true;
  }
  if (rt.from.is_bot) {
    await tellSender(
      `${mentionHtml(from)}\n\n⚠️ <b>INVALID TARGET</b>\n\nYou cannot transmit a message to a bot.`,
    );
    return true;
  }
  if (rt.from.id === from.id) {
    await tellSender(
      `${mentionHtml(from)}\n\n⚠️ <b>INVALID TARGET</b>\n\nYou cannot transmit a message to yourself.`,
    );
    return true;
  }
  if (!payload) {
    await tellSender(
      `${mentionHtml(from)}\n\n⚠️ <b>MESSAGE REQUIRED</b>\n\nAdd the text you want to transmit after /mt.`,
    );
    return true;
  }
  if (payload.length > MAX_LEN) {
    await tellSender(
      `${mentionHtml(from)}\n\n⚠️ Message too long (max ${MAX_LEN} characters).`,
    );
    return true;
  }

  const recipient = rt.from;
  const body =
    `${mentionHtml(recipient)}\n\n` +
    `🧠 <b>MIND TRANSMISSION</b>\n\n` +
    `Message from: ${mentionHtml(from)}\n\n` +
    `───────────────\n\n` +
    `${esc(payload)}`;

  try {
    await sendEphemeral(chat.id, recipient.id, body);
  } catch (e) {
    const desc = e?.description || e?.message || 'unknown error';
    await tellSender(
      `${mentionHtml(from)}\n\n❌ <b>TRANSMISSION FAILED</b>\n\nThe ephemeral message could not be delivered.\n\n<code>${esc(String(desc).slice(0, 200))}</code>`,
    );
    return true;
  }

  await tellSender(
    `${mentionHtml(from)}\n\n✅ <b>MIND TRANSMISSION SENT</b>\n\nTarget: ${mentionHtml(recipient)}\n\nYour ephemeral message was delivered inside the group.`,
  );
  return true;
}
