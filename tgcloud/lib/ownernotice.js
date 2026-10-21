import { db } from 'sdk';
import { api } from './message_api.js';
import { eq } from 'sdk/db';
import { users, knownGroups as KG, supportConversations } from '../schema.js';
import { OWNER_ID } from './config.js';
import { SUPPORT_GROUP_ID, SUPPORT_USERS_TOPIC_ID } from './topic_config.js';

const para = (...t) => ({ type: 'paragraph', text: t.length === 1 ? t[0] : t });
const code = (text) => ({ type: 'code', text: String(text) });
const bold = (text) => ({ type: 'bold', text });
const mention = (u) => ({
  type: 'text_mention',
  text: u.first_name || 'User',
  user: { id: u.id, is_bot: !!u.is_bot, first_name: u.first_name || 'User', last_name: u.last_name, username: u.username },
});
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const profileLink = (u) => {
  const name = esc(u.first_name || 'User');
  return `<a href="tg://user?id=${u.id}">${name}</a>`;
};
const nowSec = () => Math.floor(Date.now() / 1000);

async function toOwner(plainHtml, blocks) {
  try {
    await api.sendMessage({ chat_id: OWNER_ID, text: plainHtml, parse_mode: 'HTML' });
  } catch (e) {
    console.error('owner notice (html) failed:', e);
    if (blocks) {
      try {
        await api.sendRichMessage({ chat_id: OWNER_ID, rich_message: { blocks } });
      } catch (e2) {
        console.error('owner notice (rich) failed:', e2);
      }
    }
  }
}

export async function notifyNewUser(message) {
  try {
    const from = message.from;
    if (!from || from.is_bot || message.chat?.type !== 'private') return;
    if (from.id === OWNER_ID) return;
    const cmd = String(message.text || '').trim().split(/[\s@]/)[0].toLowerCase();
    if (cmd !== '/start') return;

    const known = await db.select().from(users).where(eq(users.telegramId, from.id)).get();
    if (known) {
      // User re-started — clear blocked flag if set
      if (known.blocked) {
        try { await db.update(users).set({ blocked: 0 }).where(eq(users.telegramId, from.id)).run(); } catch (_) {}
      }
      return;
    }

    const uname = from.username ? `@${from.username}` : 'no username';
    await toSupportTopic(
      `#newuser\n👤 ${profileLink(from)}\n🆔 User ID: <code>${from.id}</code>\n🔗 ${esc(uname)}`,
      SUPPORT_USERS_TOPIC_ID,
    );
  } catch (e) {
    console.error('notifyNewUser failed:', e);
  }
}

export async function notifyGroupAdded(update) {
  try {
    const chat = update?.chat;
    if (!chat || (chat.type !== 'group' && chat.type !== 'supergroup')) return;
    const was = update.old_chat_member?.status;
    const now = update.new_chat_member?.status;
    const wasOut = was === 'left' || was === 'kicked';
    const isIn = now === 'member' || now === 'administrator';
    if (!(wasOut && isIn)) return;

    const by = update.from || { id: 0, first_name: 'Unknown' };
    // Track known group + original adder (only set on first insert)
    try {
      const existing = await db.select().from(KG).where(eq(KG.chatId, chat.id)).get();
      if (existing) {
        await db.update(KG).set({
          title: chat.title || existing.title,
          username: chat.username || existing.username || null,
          active: 1,
          updatedAt: nowSec(),
        }).where(eq(KG.chatId, chat.id)).run();
      } else {
        await db.insert(KG).values({
          chatId: chat.id,
          title: chat.title || String(chat.id),
          username: chat.username || null,
          active: 1,
          approved: 1,
          addedById: by.id || null,
          addedByName: by.first_name || null,
          updatedAt: nowSec(),
        }).run();
      }
    } catch (e) {
      console.error('knownGroups upsert failed', e);
    }

    const title = chat.title || String(chat.id);
    const uname = by.username ? `@${by.username}` : 'no username';
    await toOwner(
      `#newgrp\n➕ Added by: ${profileLink(by)}\n🆔 User ID: <code>${by.id}</code>\n🔗 ${esc(uname)}\n👥 Group: <b>${esc(title)}</b>\n🆔 Group ID: <code>${chat.id}</code>`,
      [para('#newgrp'), para('➕ Added by: ', mention(by)), para('🆔 User ID: ', code(by.id)), para('👥 Group: ', bold(title)), para('🆔 Group ID: ', code(chat.id))],
    );
  } catch (e) {
    console.error('notifyGroupAdded failed:', e);
  }
}

/** Someone blocked the bot (private chat: member → kicked) or bot removed from group */
export async function notifyBlockedOrRemoved(update) {
  try {
    const chat = update?.chat;
    if (!chat) return;
    const was = update.old_chat_member?.status;
    const now = update.new_chat_member?.status;
    // Private chat unblock
    if (chat.type === "private" && (was === "kicked" || was === "left") && (now === "member" || now === "administrator")) {
      const id = update.from?.id || chat.id;
      try {
        await db.update(users).set({ blocked: 0 }).where(eq(users.telegramId, id)).run();
      } catch (e) { console.error("unblocked flag update failed", e); }
      return;
    }

    const wasIn = was === 'member' || was === 'administrator' || was === 'restricted' || was === 'creator';
    const isOut = now === 'kicked' || now === 'left';
    if (!(wasIn && isOut)) return;

    // Private chat block
    if (chat.type === 'private') {
      const by = update.from || chat;
      const name = by.first_name || chat.first_name || 'User';
      const id = by.id || chat.id;
      const uname = by.username ? `@${by.username}` : 'no username';
      try {
        const u = await db.select().from(users).where(eq(users.telegramId, id)).get();
        if (u) await db.update(users).set({ blocked: 1 }).where(eq(users.telegramId, id)).run();
        else await db.insert(users).values({ telegramId: id, firstName: name, username: by.username || null, blocked: 1 }).run();
      } catch (e) { console.error('blocked flag failed', e); }
      let destination = SUPPORT_USERS_TOPIC_ID;
      try {
        const support = await db.select().from(supportConversations)
          .where(eq(supportConversations.userId, id)).get();
        if (support?.threadId) destination = support.threadId;
      } catch (e) {
        console.error('blocked-user support topic lookup failed:', e?.description || e?.message || 'unknown error');
      }
      await toSupportTopic(
        `#blockbot\n🚫 <b>User blocked the bot</b>\n👤 <a href="tg://user?id=${id}">${esc(name)}</a>\n🆔 <code>${id}</code>\n🔗 ${esc(uname)}`,
        destination,
      );
      return;
    }

    // Removed from group — mark inactive
    if (chat.type === 'group' || chat.type === 'supergroup') {
      try {
        await db.update(KG).set({ active: 0, updatedAt: nowSec() }).where(eq(KG.chatId, chat.id)).run();
      } catch (_) {}
    }
  } catch (e) {
    console.error('notifyBlockedOrRemoved failed:', e);
  }
}
async function toSupportTopic(plainHtml, threadId) {
  if (!Number.isSafeInteger(SUPPORT_GROUP_ID) || SUPPORT_GROUP_ID >= 0 || !Number.isSafeInteger(threadId) || threadId <= 0) {
    console.error('Support notification skipped: configure SUPPORT_GROUP_ID and a valid topic ID.');
    return;
  }
  try {
    await api.sendMessage({
      chat_id: SUPPORT_GROUP_ID,
      message_thread_id: threadId,
      text: plainHtml,
      parse_mode: 'HTML',
    });
  } catch (e) {
    console.error('Support notification failed:', e?.description || e?.message || 'unknown error');
  }
}
