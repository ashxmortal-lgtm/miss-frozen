import { db } from 'sdk';
import { api } from './message_api.js';
import { eq, and } from 'sdk/db';
import { replyBridge as RB, announcedMessages as AM } from '../schema.js';
import { isGroupChat } from './groupadmin.js';

const para = (...t) => ({ type: 'paragraph', text: t.length === 1 ? t[0] : t });
const head = (t) => ({ type: 'heading', text: t, size: 2 });
const bold = (t) => ({ type: 'bold', text: t });
const code = (t) => ({ type: 'code', text: String(t) });
const row = (...buttons) => ({ type: 'buttons', buttons, align: 'center' });
const cb = (text, data, style) => (style ? { text, callback_data: data, style } : { text, callback_data: data });
const rich = (blocks) => ({ blocks, skip_entity_detection: true });
const nowSec = () => Math.floor(Date.now() / 1000);
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const REACTIONS = ['😁', '😭', '🥳', '🤓', '🌚', '🙈', '🙉', '🙊', '🔥', '🎉', '💯', '❤️', '👀', '👍🏻', '👎🏻', '🤝', '☃️', '⚡', '🕊️'];

function reactionRows(bridgeId) {
  const rows = [];
  for (let i = 0; i < REACTIONS.length; i += 5) {
    const slice = REACTIONS.slice(i, i + 5);
    rows.push(row(...slice.map((em, j) => cb(em, `rxn:${bridgeId}:${i + j}`))));
  }
  return rows;
}

function mediaLabel(m) {
  if (!m) return '[unknown]';
  if (m.text) return m.text;
  if (m.caption) return m.caption;
  if (m.sticker) return '[sticker]';
  if (m.photo) return '[photo]';
  if (m.document) return '[file]';
  if (m.video) return '[video]';
  if (m.voice) return '[voice]';
  if (m.animation) return '[gif]';
  if (m.audio) return '[audio]';
  if (m.video_note) return '[video note]';
  return '[media]';
}

/**
 * User replied to a bot message that was posted via /announce.
 * Notify ONLY the announcer (not all admins, not owner unless they announced).
 */
export async function handleGroupReplyToBot(message) {
  try {
    if (!isGroupChat(message.chat)) return false;
    const rt = message.reply_to_message;
    if (!rt) return false;
    const botId = (await api.getMe()).id;
    if (!rt.from || rt.from.id !== botId) return false;
    if (!message.from || message.from.is_bot) return false;

    // Only care about announced messages
    const ann = await db.select().from(AM)
      .where(and(eq(AM.chatId, message.chat.id), eq(AM.messageId, rt.message_id))).get();
    if (!ann) return false; // not an announce post → ignore for bridge

    const announcerId = ann.announcerId;
    const from = message.from;
    const name = from.first_name || 'User';
    const uname = from.username ? `@${from.username}` : '';
    const title = message.chat.title || String(message.chat.id);
    const userReply = mediaLabel(message);
    const originalPreview = mediaLabel(rt);

    // Header with context: who replied, to which announce message, what they said
    let header;
    try {
      header = await api.sendMessage({
        chat_id: announcerId,
        text:
          `💬 <b>Reply on your announcement</b>\n` +
          `👥 Group: ${esc(title)}\n` +
          `👤 <a href="tg://user?id=${from.id}">${esc(name)}</a> ${esc(uname)}\n` +
          `🆔 <code>${from.id}</code>\n\n` +
          `<b>Their reply:</b>\n${esc(String(userReply).slice(0, 800))}\n\n` +
          `<b>Replying to your msg:</b>\n${esc(String(originalPreview).slice(0, 400))}\n\n` +
          `↳ Reply to <b>this</b> message to answer them in the group.`,
        parse_mode: 'HTML',
      });
    } catch (e) {
      console.error('notify announcer failed', e);
      return true;
    }

    // Copy their full message (media etc.)
    try {
      await api.copyMessage({
        chat_id: announcerId,
        from_chat_id: message.chat.id,
        message_id: message.message_id,
      });
    } catch (_) {}

    const headerId = header?.message_id ?? header;
    let bridgeId = null;
    try {
      const ins = await db.insert(RB).values({
        adminId: announcerId,
        adminMsgId: headerId,
        groupChatId: message.chat.id,
        userMsgId: message.message_id,
        userId: from.id,
        botMsgId: rt.message_id,
        createdAt: nowSec(),
      }).run();
      bridgeId = ins?.lastInsertRowid ?? ins?.insertId ?? null;
      if (!bridgeId) {
        const row = await db.select().from(RB)
          .where(and(eq(RB.adminId, announcerId), eq(RB.adminMsgId, headerId))).get();
        bridgeId = row?.id;
      }
    } catch (e) {
      console.error('reply bridge insert failed', e);
    }

    if (bridgeId) {
      try {
        await api.sendRichMessage({
          chat_id: announcerId,
          rich_message: rich([
            para('Quick react to their message:'),
            ...reactionRows(bridgeId),
          ]),
          reply_to_message_id: headerId,
        });
      } catch (_) {}
    }
    return true;
  } catch (e) {
    console.error('handleGroupReplyToBot failed', e);
    return false;
  }
}

/** Announcer replies in DM to the bridge header → deliver as reply in group */
export async function handleAdminDmReply(message) {
  try {
    if (message.chat?.type !== 'private' || !message.from) return false;
    const rt = message.reply_to_message;
    if (!rt) return false;

    const bridge = await db.select().from(RB)
      .where(and(eq(RB.adminId, message.from.id), eq(RB.adminMsgId, rt.message_id))).get();
    if (!bridge) return false;

    try {
      await api.copyMessage({
        chat_id: bridge.groupChatId,
        from_chat_id: message.chat.id,
        message_id: message.message_id,
        reply_to_message_id: bridge.userMsgId,
      });
      await api.sendMessage({
        chat_id: message.from.id,
        text: '✅ Delivered to the group as a reply.',
        reply_to_message_id: message.message_id,
      });
    } catch (e) {
      try {
        const text = message.text || message.caption || '';
        if (text) {
          await api.sendMessage({
            chat_id: bridge.groupChatId,
            text,
            reply_to_message_id: bridge.userMsgId,
          });
          await api.sendMessage({ chat_id: message.from.id, text: '✅ Delivered (text).' });
        } else {
          await api.sendMessage({
            chat_id: message.from.id,
            text: `⚠️ Could not deliver: ${e.description || e.message}`,
          });
        }
      } catch (e2) {
        await api.sendMessage({
          chat_id: message.from.id,
          text: `⚠️ Could not deliver: ${e2.description || e2.message}`,
        });
      }
    }
    return true;
  } catch (e) {
    console.error('handleAdminDmReply failed', e);
    return false;
  }
}

/** rxn:<bridgeId>:<emojiIndex> */
export async function handleReactionCallback(cq) {
  const data = cq.data || '';
  if (!data.startsWith('rxn:')) return false;
  const parts = data.split(':');
  const bridgeId = Number(parts[1]);
  const idx = Number(parts[2]);
  if (!Number.isInteger(bridgeId) || !Number.isInteger(idx) || idx < 0 || idx >= REACTIONS.length) {
    await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'Invalid.', show_alert: true });
    return true;
  }

  const bridge = await db.select().from(RB).where(eq(RB.id, bridgeId)).get();
  if (!bridge || bridge.adminId !== cq.from.id) {
    await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'Not found / not yours.', show_alert: true });
    return true;
  }

  const emoji = REACTIONS[idx];
  try {
    await api.setMessageReaction({
      chat_id: bridge.groupChatId,
      message_id: bridge.userMsgId,
      reaction: [{ type: 'emoji', emoji }],
    });
    await api.answerCallbackQuery({ callback_query_id: cq.id, text: `Reacted ${emoji}` });
  } catch (e) {
    await api.answerCallbackQuery({
      callback_query_id: cq.id,
      text: `Reaction failed: ${e.description || e.message || 'error'}`,
      show_alert: true,
    });
  }
  return true;
}
