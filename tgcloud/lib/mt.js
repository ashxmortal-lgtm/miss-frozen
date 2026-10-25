import { db } from 'sdk';
import { api } from './message_api.js';
import { sql } from 'sdk/db';
import { COMMANDS } from './command_registry.js';

const MAX_LEN = 1000;

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const mentionHtml = (u) => {
  if (!u?.id) return 'User';
  return `<a href="tg://user?id=${u.id}">${esc(u.first_name || 'User')}</a>`;
};

let MT_CMD_REGISTERED = false;

/**
 * Register /mt as an ephemeral group command so Telegram hides the command and
 * its text from the rest of the group. The full group menu is sent with it —
 * `setMyCommands` replaces the scope, so registering only /mt would wipe every
 * other command from the group menu (Bot API 10.2+ `is_ephemeral`).
 */
export async function ensureMtEphemeralCommand() {
  if (MT_CMD_REGISTERED) return;
  const commands = COMMANDS
    .filter((c) => c.access === 'user' && !c.hidden)
    .map((c) => ({
      command: c.cmd.replace(/^\//, ''),
      description: String(c.desc).slice(0, 256),
      ...(c.cmd === '/mt' ? { is_ephemeral: true } : {}),
    }));
  try {
    await api.setMyCommands({ scope: { type: 'all_group_chats' }, commands });
    MT_CMD_REGISTERED = true;
  } catch (e) {
    console.error('setMyCommands mt ephemeral failed:', e?.description || e);
    // Older API builds reject `is_ephemeral`; keep the group menu intact.
    try {
      await api.setMyCommands({ scope: { type: 'all_group_chats' }, commands: commands.map(({ is_ephemeral, ...rest }) => rest) });
      MT_CMD_REGISTERED = true;
    } catch (e2) {
      console.error('setMyCommands group menu failed:', e2?.description || e2);
    }
  }
}

/**
 * The jutsu check reads the same inventory rows /inventory shows (raw SQL, no
 * query-builder dependency). A purchased jutsu is item_type 'jutsu' with the
 * name "Mind Transmission Jutsu".
 */
async function hasMtJutsu(userId) {
  try {
    const row = await db.get(sql`
      SELECT qty FROM inventory
      WHERE telegram_id = ${userId} AND item_name LIKE '%Mind Transmission%'
      LIMIT 1
    `);
    if (row && Number(row.qty) > 0) return true;
  } catch (e) {
    console.error('[mt jutsu check]', e?.message || e);
  }
  try {
    const rows = await db.all(sql`
      SELECT item_name FROM inventory WHERE telegram_id = ${userId} AND item_type = 'jutsu'
    `);
    return (rows || []).some((r) => String(r.item_name || '').toLowerCase().includes('mind transmission'));
  } catch (_) {
    return false;
  }
}

/**
 * Ephemeral messages must be tied to the action that triggered them: a reply to
 * the incoming command (Bot API 10.3 — `ephemeral_message_id` when the command
 * itself arrived as ephemeral, otherwise the message id). Without it Telegram
 * rejects the send, which is why /mt used to stay silent.
 */
function ephemeralTrigger(message) {
  if (message?.ephemeral_message_id) {
    return { ephemeral_message_id: message.ephemeral_message_id };
  }
  if (message?.message_id) {
    return { message_id: message.message_id, allow_sending_without_reply: true };
  }
  return null;
}

async function sendEphemeral(chatId, receiverUserId, text, trigger) {
  const base = {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    ephemeral_message_parameters: { receiver_user_id: receiverUserId },
  };
  if (!trigger) return api.sendMessage(base);
  try {
    return await api.sendMessage({ ...base, reply_parameters: trigger });
  } catch (e) {
    // Some API builds reject a reply target on an ephemeral send; the receiver
    // still gets the message, just without the quoted trigger.
    console.error('[mt ephemeral retry]', e?.description || e);
    return api.sendMessage(base);
  }
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

  const trigger = ephemeralTrigger(message);

  // Answers go to the sender only. Ephemeral first; the bot's DM is the private
  // fallback so a refused ephemeral send never leaves the player without a reply.
  const tellSender = async (html) => {
    if (isGroup) {
      try {
        await sendEphemeral(chat.id, from.id, html, trigger);
        return;
      } catch (e) {
        console.error('ephemeral to sender failed:', e?.description || e);
      }
      try {
        await api.sendMessage({ chat_id: from.id, text: html, parse_mode: 'HTML' });
        return;
      } catch (e2) {
        console.error('mt sender DM failed:', e2?.description || e2);
      }
      // Last resort: a short status in the group beats a silent command. Only
      // the status text is public — the transmitted body never is.
      try {
        const fallback = { chat_id: chat.id, text: html, parse_mode: 'HTML' };
        if (trigger?.message_id) {
          fallback.reply_parameters = { message_id: trigger.message_id, allow_sending_without_reply: true };
        }
        await api.sendMessage(fallback);
      } catch (_) { /* nothing else to try */ }
      return;
    }
    try {
      await api.sendMessage({ chat_id: from.id, text: html, parse_mode: 'HTML' });
    } catch (_) {}
  };

  if (!isGroup) {
    await tellSender(
      `${mentionHtml(from)}\n\n⚠️ <b>GROUP ONLY</b>\n\n/mt works inside a group — reply to the receiver’s message.`,
    );
    return true;
  }

  if (!(await hasMtJutsu(from.id))) {
    await tellSender(
      `${mentionHtml(from)}\n\n🔒 <b>JUTSU NOT UNLOCKED</b>\n\nYou need Mind Transmission Jutsu 🧠 to use /mt.\n\nUnlock it with /buy Mind Transmission Jutsu (or /shinobi_store → Jutsu).`,
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

  let viaDm = false;
  let failure = null;
  try {
    await sendEphemeral(chat.id, recipient.id, body, trigger);
  } catch (e) {
    failure = e?.description || e?.message || 'unknown error';
    console.error('[mt ephemeral]', failure);
    // Ephemeral delivery is never guaranteed (the receiver may be offline, or
    // the API build may refuse the send). The bot's DM is private as well, so
    // the jutsu still works instead of failing silently.
    try {
      await api.sendMessage({ chat_id: recipient.id, text: body, parse_mode: 'HTML' });
      viaDm = true;
      failure = null;
    } catch (e2) {
      failure = e2?.description || e2?.message || failure;
      console.error('[mt dm]', e2?.description || e2);
    }
  }

  if (failure) {
    await tellSender(
      `${mentionHtml(from)}\n\n❌ <b>TRANSMISSION FAILED</b>\n\nThe message could not be delivered privately.\n\n<code>${esc(String(failure).slice(0, 200))}</code>`,
    );
    return true;
  }

  await tellSender(
    `${mentionHtml(from)}\n\n✅ <b>MIND TRANSMISSION SENT</b>\n\nTarget: ${mentionHtml(recipient)}\n\n` +
    (viaDm
      ? 'Your message was delivered to their bot DM instead (ephemeral delivery was unavailable).'
      : 'Your ephemeral message was delivered inside the group.'),
  );
  return true;
}
