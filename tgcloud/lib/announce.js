// MissFrozen: owner broadcast /ow_announce only.
import { db, BotApiError } from 'sdk';
import { api } from './message_api.js';
import { eq, and, asc } from 'sdk/db';
import {
  announceSessions as AS, announceTargets as AT, announceItems as AI,
  announcedMessages as AM, knownGroups as KG, groupSettings as GS, users,
} from '../schema.js';
import { OWNER_ID } from './config.js';
import { commandIsForMe } from './groupadmin.js';

const bold = (t) => ({ type: 'bold', text: t });
const para = (...t) => ({ type: 'paragraph', text: t.length === 1 ? t[0] : t });
const head = (t) => ({ type: 'heading', text: t, size: 2 });
const code = (t) => ({ type: 'code', text: String(t) });
const row = (...buttons) => ({ type: 'buttons', buttons, align: 'center' });
const cb = (text, data, style) => (style ? { text, callback_data: data, style } : { text, callback_data: data });
const rich = (blocks) => ({ blocks, skip_entity_detection: true });
const nowSec = () => Math.floor(Date.now() / 1000);
const SESSION_TTL = 1800;

async function say(chatId, blocks, plain) {
  try {
    return await api.sendRichMessage({ chat_id: chatId, rich_message: rich(blocks) });
  } catch (e) {
    if (!(e instanceof BotApiError)) throw e;
    return api.sendMessage({ chat_id: chatId, text: plain || ' ' });
  }
}

async function clearSession(userId) {
  await db.delete(AI).where(eq(AI.userId, userId)).run();
  await db.delete(AT).where(eq(AT.userId, userId)).run();
  await db.delete(AS).where(eq(AS.userId, userId)).run();
}

async function getSession(userId) {
  const s = await db.select().from(AS).where(eq(AS.userId, userId)).get();
  if (!s) return null;
  if (nowSec() - s.createdAt > SESSION_TTL) {
    await clearSession(userId);
    return null;
  }
  return s;
}

async function resolveTitle(chatId, fallback) {
  try {
    const c = await api.getChat({ chat_id: chatId });
    return c.title || c.first_name || fallback || String(chatId);
  } catch (_) {
    return fallback || String(chatId);
  }
}

function groupPickerBlocks(targets) {
  const blocks = [
    head('📢 ANNOUNCE — Select groups'),
    para('Tap to toggle. ✅ = selected.'),
  ];
  for (const t of targets) {
    const mark = t.selected ? '✅' : '❌';
    const label = `${mark} ${(t.title || t.chatId)}`.slice(0, 60);
    blocks.push(row(cb(label, `ann:tog:${t.chatId}`)));
  }
  blocks.push(row(
    cb('➡️ Continue', 'ann:next', 'success'),
    cb('❌ Cancel', 'ann:cancel', 'danger'),
  ));
  return blocks;
}

function scopePickerBlocks(s) {
  const g = s.sendGroups ? '✅' : '❌';
  const d = s.sendDms ? '✅' : '❌';
  return [
    head('📢 OWNER ANNOUNCE — Scope'),
    para('Choose where to send:'),
    row(cb(`${g} All groups`, 'ann:scope:groups')),
    row(cb(`${d} All user DMs`, 'ann:scope:dms')),
    row(
      cb('➡️ Continue', 'ann:next', 'success'),
      cb('❌ Cancel', 'ann:cancel', 'danger'),
    ),
  ];
}

/** /ow_announce (owner, DM). Plain /announce is ExFrozen-only. */
export async function handleAnnounceCommand(message) {
  const text = message.text || '';
  if (!text.startsWith('/')) return false;
  const cmd = text.split(/[\s@]/)[0].toLowerCase();
  if (cmd !== '/ow_announce') return false;
  if (!(await commandIsForMe(message))) return true;

  const from = message.from;
  if (!from) return true;
  const chat = message.chat;

  // Must be private
  if (chat.type !== 'private') {
    await say(chat.id, [
      head('📢 ANNOUNCE'),
      para('Use this command in a ', bold('private chat'), ' with the bot.'),
    ], 'Use /ow_announce in a private chat with the bot.');
    return true;
  }

  const isOwnerCmd = cmd === '/ow_announce';
  if (isOwnerCmd && from.id !== OWNER_ID) {
    await say(chat.id, [para('⛔ Owner only.')], 'Owner only.');
    return true;
  }

  await clearSession(from.id);

  if (isOwnerCmd) {
    await db.insert(AS).values({
      userId: from.id,
      chatId: 0,
      chatTitle: '',
      mode: 'owner',
      state: 'pick_scope',
      sendGroups: 1,
      sendDms: 0,
      createdAt: nowSec(),
    }).run();
    await say(from.id, scopePickerBlocks({ sendGroups: 1, sendDms: 0 }),
      'Owner announce: toggle Groups / DMs, then Continue.');
    return true;
  }

  return true;
}

/** Collecting phase + /done /cancel in private */
export async function handleAnnounceText(message) {
  if (message.chat?.type !== 'private' || !message.from) return false;
  const uid = message.from.id;
  const s = await getSession(uid);
  if (!s) return false;

  // Ignore while picking (they should use buttons)
  if (s.state === 'pick_groups' || s.state === 'pick_scope') {
    const raw = (message.text || '').trim().toLowerCase();
    if (raw === '/cancel') {
      await clearSession(uid);
      await say(uid, [head('❌ CANCELLED'), para('Cancelled.')], 'Cancelled.');
      return true;
    }
    await say(uid, [para('Use the buttons above, or /cancel.')], 'Use the buttons or /cancel.');
    return true;
  }

  const raw = (message.text || '').trim();
  const cmd = raw.split(/[\s@]/)[0].toLowerCase();

  if (cmd === '/cancel') {
    await clearSession(uid);
    await say(uid, [head('❌ CANCELLED'), para('Announcement cancelled.')], 'Cancelled.');
    return true;
  }

  if (cmd === '/done') {
    const items = await db.select().from(AI).where(eq(AI.userId, uid)).orderBy(asc(AI.sortOrder)).all();
    if (!items.length) {
      await say(uid, [para('No messages yet. Send some, then /done.')], 'No messages yet.');
      return true;
    }
    await db.update(AS).set({ state: 'confirming' }).where(eq(AS.userId, uid)).run();

    let destLine = '';
    if (s.mode === 'owner') {
      const parts = [];
      if (s.sendGroups) parts.push('all groups');
      if (s.sendDms) parts.push('all user DMs');
      destLine = parts.join(' + ') || 'nothing selected';
    } else {
      const sel = await db.select().from(AT).where(and(eq(AT.userId, uid), eq(AT.selected, 1))).all();
      destLine = sel.map((t) => t.title || t.chatId).join(', ') || 'no groups';
    }

    await say(uid, [
      head('📢 READY TO SEND'),
      para('Messages: ', bold(String(items.length))),
      para('To: ', bold(destLine)),
      para('Choose:'),
      row(
        cb('📤 Send', 'ann:send', 'success'),
        cb('📌 Send + Pin', 'ann:pin', 'primary'),
      ),
      row(cb('❌ Cancel', 'ann:cancel', 'danger')),
    ], `Ready: ${items.length} msg(s) → ${destLine}`);
    return true;
  }

  if (s.state !== 'collecting') {
    await say(uid, [para('Use the buttons, or /cancel.')], 'Use the buttons or /cancel.');
    return true;
  }

  const count = await db.$count(AI, eq(AI.userId, uid));
  await db.insert(AI).values({
    userId: uid,
    dmMessageId: message.message_id,
    sortOrder: count,
  }).run();

  await say(uid, [
    para('✅ Added (', bold(String(count + 1)), '). More, or ', code('/done'), ' / ', code('/cancel'), '.'),
  ], `Added (${count + 1}). /done when finished.`);
  return true;
}

/** Callbacks: ann:tog, ann:scope, ann:next, ann:send, ann:pin, ann:cancel */
export async function handleAnnounceCallback(cq) {
  const data = cq.data || '';
  if (!data.startsWith('ann:')) return false;

  const uid = cq.from.id;
  const msg = cq.message;
  const alert = (t) => api.answerCallbackQuery({ callback_query_id: cq.id, text: t, show_alert: true });
  const s = await getSession(uid);

  if (data === 'ann:cancel') {
    await clearSession(uid);
    await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'Cancelled' });
    if (msg) {
      try {
        await api.editMessageText({
          chat_id: msg.chat.id, message_id: msg.message_id,
          rich_message: rich([head('❌ CANCELLED'), para('Cancelled.')]),
        });
      } catch (_) {}
    }
    return true;
  }

  if (!s) {
    await alert('Session expired. Send /announce again.');
    return true;
  }

  // Toggle group
  if (data.startsWith('ann:tog:')) {
    const chatId = Number(data.slice(8));
    const row = await db.select().from(AT)
      .where(and(eq(AT.userId, uid), eq(AT.chatId, chatId))).get();
    if (!row) { await alert('Not found'); return true; }
    const next = row.selected ? 0 : 1;
    await db.update(AT).set({ selected: next })
      .where(and(eq(AT.userId, uid), eq(AT.chatId, chatId))).run();
    const targets = await db.select().from(AT).where(eq(AT.userId, uid)).all();
    await api.answerCallbackQuery({ callback_query_id: cq.id, text: next ? 'Selected' : 'Deselected' });
    if (msg) {
      try {
        await api.editMessageText({
          chat_id: msg.chat.id, message_id: msg.message_id,
          rich_message: rich(groupPickerBlocks(targets)),
        });
      } catch (_) {}
    }
    return true;
  }

  // Owner scope toggle
  if (data.startsWith('ann:scope:')) {
    const kind = data.slice(10);
    if (kind === 'groups') {
      await db.update(AS).set({ sendGroups: s.sendGroups ? 0 : 1 }).where(eq(AS.userId, uid)).run();
    } else if (kind === 'dms') {
      await db.update(AS).set({ sendDms: s.sendDms ? 0 : 1 }).where(eq(AS.userId, uid)).run();
    }
    const ns = await getSession(uid);
    await api.answerCallbackQuery({ callback_query_id: cq.id });
    if (msg && ns) {
      try {
        await api.editMessageText({
          chat_id: msg.chat.id, message_id: msg.message_id,
          rich_message: rich(scopePickerBlocks(ns)),
        });
      } catch (_) {}
    }
    return true;
  }

  // Continue → collecting
  if (data === 'ann:next') {
    if (s.mode === 'admin') {
      const sel = await db.select().from(AT).where(and(eq(AT.userId, uid), eq(AT.selected, 1))).all();
      if (!sel.length) {
        await alert('Select at least one group.');
        return true;
      }
    } else {
      if (!s.sendGroups && !s.sendDms) {
        await alert('Enable Groups and/or DMs.');
        return true;
      }
    }
    await db.update(AS).set({ state: 'collecting' }).where(eq(AS.userId, uid)).run();
    await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'OK' });
    await say(uid, [
      head('📢 COMPOSE'),
      para('Send the messages to announce (any type: text, photo, file, sticker, spoiler, quote…).'),
      para('As many as you want. When done: ', code('/done'), ' · Cancel: ', code('/cancel')),
    ], 'Send announcement messages. /done when finished.');
    if (msg) {
      try {
        await api.editMessageText({
          chat_id: msg.chat.id, message_id: msg.message_id,
          rich_message: rich([head('📢 COMPOSE'), para('Send messages in chat. /done when finished.')]),
        });
      } catch (_) {}
    }
    return true;
  }

  // Send / pin
  if (data === 'ann:send' || data === 'ann:pin') {
    const doPin = data === 'ann:pin';
    const items = await db.select().from(AI).where(eq(AI.userId, uid)).orderBy(asc(AI.sortOrder)).all();
    if (!items.length) {
      await alert('No messages.');
      return true;
    }
    await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'Sending…' });

    // Build destination list
    const dests = []; // { chatId, kind: 'group'|'dm', title }
    if (s.mode === 'admin') {
      const sel = await db.select().from(AT).where(and(eq(AT.userId, uid), eq(AT.selected, 1))).all();
      for (const t of sel) dests.push({ chatId: t.chatId, kind: 'group', title: t.title || String(t.chatId) });
    } else {
      if (s.sendGroups) {
        const groups = await db.select().from(KG).where(eq(KG.active, 1)).all();
        // also include groups known from /eco settings
        const fromGS = await db.select().from(GS).all();
        const seen = new Set();
        for (const g of groups) {
          if (seen.has(g.chatId)) continue;
          seen.add(g.chatId);
          dests.push({ chatId: g.chatId, kind: 'group', title: g.title || String(g.chatId) });
        }
        for (const g of fromGS) {
          if (seen.has(g.chatId)) continue;
          seen.add(g.chatId);
          dests.push({ chatId: g.chatId, kind: 'group', title: String(g.chatId) });
        }
      }
      if (s.sendDms) {
        const allUsers = await db.select().from(users).all();
        for (const u of allUsers) {
          if (u.telegramId === OWNER_ID) continue;
          dests.push({ chatId: u.telegramId, kind: 'dm', title: u.firstName || String(u.telegramId) });
        }
      }
    }

    let okGroups = 0, failGroups = 0, okDms = 0, failDms = 0, pinned = 0, pinFail = 0;
    const errors = [];

    for (const dest of dests) {
      let lastId = null;
      let destOk = true;
      for (const it of items) {
        try {
          const r = await api.copyMessage({
            chat_id: dest.chatId,
            from_chat_id: uid,
            message_id: it.dmMessageId,
          });
          const mid = r?.message_id ?? r;
          lastId = mid;
          // Track announced messages only for groups (reply bridge)
          if (dest.kind === 'group' && mid) {
            try {
              await db.insert(AM).values({
                chatId: dest.chatId,
                messageId: mid,
                announcerId: uid,
                sourceDmMsgId: it.dmMessageId,
                createdAt: nowSec(),
              }).run();
            } catch (_) {}
          }
        } catch (e) {
          destOk = false;
          errors.push(`${dest.title}: ${e.description || e.message}`);
        }
      }
      if (dest.kind === 'group') {
        if (destOk) okGroups++; else failGroups++;
        if (doPin && lastId && destOk) {
          try {
            await api.pinChatMessage({ chat_id: dest.chatId, message_id: lastId });
            pinned++;
          } catch (e) {
            pinFail++;
            errors.push(`pin ${dest.title}: ${e.description || e.message}`);
          }
        }
      } else {
        if (destOk) okDms++; else failDms++;
      }
    }

    await clearSession(uid);

    const report = [
      head('✅ ANNOUNCE REPORT'),
      para('Messages: ', bold(String(items.length))),
      para('Groups sent: ', bold(String(okGroups)), failGroups ? ` · failed ${failGroups}` : ''),
      ...(s.mode === 'owner' ? [para('DMs sent: ', bold(String(okDms)), failDms ? ` · failed ${failDms}` : '')] : []),
      ...(doPin ? [para('Pinned: ', bold(String(pinned)), pinFail ? ` · pin fail ${pinFail}` : '')] : []),
      ...(errors.length ? [para('⚠️ ', errors.slice(0, 5).join(' · '))] : []),
    ];

    if (msg) {
      try {
        await api.editMessageText({
          chat_id: msg.chat.id, message_id: msg.message_id,
          rich_message: rich(report),
        });
      } catch (_) {
        await say(uid, report, 'Announce done.');
      }
    } else {
      await say(uid, report, 'Announce done.');
    }
    return true;
  }

  await alert('Unknown action.');
  return true;
}
