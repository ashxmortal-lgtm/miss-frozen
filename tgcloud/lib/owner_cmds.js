// MissFrozen owner commands: /stats, /groups, coupons.
import { handleCreateCoupon, handleListCoupons, handleEditCoupon, handleCouponWizardCallback } from "./coupons.js";
import { db, BotApiError } from 'sdk';
import { api } from './message_api.js';
import { eq } from 'sdk/db';
import { users, knownGroups as KG, groupSettings as GS } from '../schema.js';
import { OWNER_ID } from './config.js';

const bold = (text) => ({ type: 'bold', text });
const para = (...t) => ({ type: 'paragraph', text: t.length === 1 ? t[0] : t });
const head = (text) => ({ type: 'heading', text, size: 2 });
const divider = { type: 'divider' };
const row = (...buttons) => ({ type: 'buttons', buttons, align: 'center' });
const cb = (text, data, style) => (style ? { text, callback_data: data, style } : { text, callback_data: data });
const rich = (blocks) => ({ blocks });
const mention = (u) => ({
  type: 'text_mention',
  text: (u && (u.first_name || u.firstName)) || 'User',
  user: {
    id: u.id,
    is_bot: !!(u && u.is_bot),
    first_name: (u && (u.first_name || u.firstName)) || 'User',
    last_name: u && u.last_name,
    username: u && u.username,
  },
});
const pullQuote = (...inner) => ({ type: 'pull_quotation', blocks: inner });
const urlText = (text, url) => ({ type: 'url', text, url });
const PAGE = 8;
const nowSec = () => Math.floor(Date.now() / 1000);

async function sayRich(chatId, blocks, fallbackText = null) {
  try {
    return await api.sendRichMessage({
      chat_id: chatId,
      rich_message: { blocks, skip_entity_detection: true },
    });
  } catch (e) {
    console.error('sayRich failed:', e?.description || e);
    if (fallbackText) {
      return await api.sendMessage({
        chat_id: chatId,
        text: fallbackText,
        parse_mode: 'HTML',
      });
    }
    throw e;
  }
}

async function editRich(msg, blocks) {
  try {
    await api.editMessageText({
      chat_id: msg.chat.id,
      message_id: msg.message_id,
      rich_message: rich(blocks),
    });
  } catch (e) {
    if (!(e instanceof BotApiError && e.code === 400)) console.error(e);
  }
}

function deniedBlocks(from) {
  return [para(mention(from)), head('⛔ ACCESS DENIED'), para('Only the bot owner can use this command.')];
}

async function backfillKnownGroups() {
  const seen = new Set();
  const sources = [];
  try { for (const r of await db.select().from(GS).all()) sources.push({ chatId: r.chatId }); } catch (_) {}
  for (const s of sources) {
    if (!s.chatId || seen.has(s.chatId)) continue;
    seen.add(s.chatId);
    const existing = await db.select().from(KG).where(eq(KG.chatId, s.chatId)).get();
    if (existing) continue;
    let title = String(s.chatId);
    let username = null;
    try {
      const c = await api.getChat({ chat_id: s.chatId });
      title = c.title || title;
      username = c.username || null;
    } catch (_) {}
    try {
      await db.insert(KG).values({
        chatId: s.chatId, title, username, active: 1, updatedAt: nowSec(),
      }).run();
    } catch (_) {}
  }
}

async function listKnownGroups() {
  await backfillKnownGroups();
  return (await db.select().from(KG).all()).filter((g) => g.active !== 0);
}

async function groupInviteLink(chatId, username) {
  if (username) return `https://t.me/${username}`;
  try {
    const inv = await api.createChatInviteLink({ chat_id: chatId, name: 'Bot directory' });
    return inv.invite_link || inv;
  } catch (_) {
    try {
      const inv = await api.exportChatInviteLink({ chat_id: chatId });
      return typeof inv === 'string' ? inv : inv?.invite_link;
    } catch (__) {
      return null;
    }
  }
}

function statsBlocks(from, counts) {
  const blockedLine = counts.blockedTracked ? String(counts.blocked) : 'Not tracked';
  return [
    para(mention(from)),
    head('📊 BOT STATISTICS'),
    pullQuote(
      para('👤 Users Started     ', bold(String(counts.started))),
      para('🚫 Users Blocked     ', bold(blockedLine)),
      para('👥 Groups            ', bold(String(counts.groups))),
    ),
    para('Data from the bot’s records.'),
    row(cb('🔄 Refresh', 'stats:refresh', 'primary')),
  ];
}

async function computeStats() {
  const started = await db.$count(users);
  let blocked = 0, blockedTracked = false;
  try {
    blocked = await db.$count(users, eq(users.blocked, 1));
    blockedTracked = true;
  } catch (_) {}
  return {
    started,
    blocked,
    blockedTracked,
    groups: (await listKnownGroups()).length,
  };
}

async function handleStats(message) {
  const from = message.from;
  if (!from) return true;
  if (from.id !== OWNER_ID) {
    await sayRich(message.chat.id, deniedBlocks(from), '⛔ Only the bot owner can use this command.');
    return true;
  }
  const counts = await computeStats();
  const blockedLine = counts.blockedTracked ? String(counts.blocked) : 'Not tracked';
  const plainText =
    `📊 <b>BOT STATISTICS</b>\n\n` +
    `👤 Users Started: <b>${counts.started}</b>\n` +
    `🚫 Users Blocked: <b>${blockedLine}</b>\n` +
    `👥 Groups: <b>${counts.groups}</b>\n\n` +
    `<i>Data from the bot’s records.</i>`;
  await sayRich(message.chat.id, statsBlocks(from, counts), plainText);
  return true;
}

/**
 * Rich table:
 * | Group (id) — name is embedded link when invite exists | Added by (mention) |
 * User asked 3 columns: name(id) | adder | link — link is embedded IN the name, not a button.
 */
async function renderGroupsPage(from, page) {
  const all = await listKnownGroups();
  const total = all.length;
  if (!total) {
    return [
      para(mention(from)),
      head('📋 GROUPS'),
      para('No groups recorded yet.'),
    ];
  }
  const pages = Math.max(1, Math.ceil(total / PAGE));
  const p = Math.min(Math.max(page, 0), pages - 1);
  const slice = all.slice(p * PAGE, p * PAGE + PAGE);

  // Header row
  const cells = [
    [
      { text: [bold('#')] },
      { text: [bold('Group (ID)')] },
      { text: [bold('Added By')] },
    ],
  ];

  for (let i = 0; i < slice.length; i++) {
    const g = slice[i];
    const n = p * PAGE + i + 1;
    const title = g.title || String(g.chatId);
    const link = await groupInviteLink(g.chatId, g.username);
    const nameCell = link
      ? { text: [urlText(`${title} (${g.chatId})`, link)] }
      : { text: [`${title} (${g.chatId})`] };
    const adderCell = g.addedById
      ? {
          text: [{
            type: 'text_mention',
            text: g.addedByName || 'User',
            user: { id: g.addedById, is_bot: false, first_name: g.addedByName || 'User' },
          }],
        }
      : { text: ['Unknown'] };
    cells.push([{ text: [String(n)] }, nameCell, adderCell]);
  }

  const blocks = [
    para(mention(from)),
    head('📋 GROUPS'),
    para('Total: ', bold(String(total)), `  ·  page ${p + 1}/${pages}`),
    {
      type: 'table',
      cells,
      is_bordered: true,
      is_striped: true,
      is_compact: true,
    },
  ];

  const nav = [];
  if (p > 0) nav.push(cb('⬅️ Previous', `aplist:${p - 1}`));
  if (p < pages - 1) nav.push(cb('Next ➡️', `aplist:${p + 1}`, 'primary'));
  if (nav.length) blocks.push(row(...nav));
  return blocks;
}

async function handleGroupsList(message) {
  const from = message.from;
  if (!from) return true;
  if (from.id !== OWNER_ID) {
    await sayRich(message.chat.id, deniedBlocks(from));
    return true;
  }
  await sayRich(message.chat.id, await renderGroupsPage(from, 0));
  return true;
}

export async function handleOwnerCommand(message) {
  const text = message.text || '';
  if (!text.startsWith('/')) return false;
  const cmd = text.split(/[\s@]/)[0].toLowerCase();
  if (cmd === '/stats') return handleStats(message);
  if (cmd === '/groups' || cmd === '/approved_list') return handleGroupsList(message);
  if (cmd === '/create_cc') return handleCreateCoupon(message, text);
  if (cmd === '/list_cc') return handleListCoupons(message);
  if (cmd === '/edit_cc') return handleEditCoupon(message, text);
  return false;
}

export async function handleOwnerCallback(cq) {
  const data = cq.data || '';
  if (data.startsWith('cc:')) return handleCouponWizardCallback(cq);
  if (data === 'stats:refresh') {
    if (cq.from.id !== OWNER_ID) {
      await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'Owner only.', show_alert: true });
      return true;
    }
    await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'Updated' });
    if (cq.message) await editRich(cq.message, statsBlocks(cq.from, await computeStats()));
    return true;
  }
  if (!data.startsWith('aplist:')) return false;
  if (cq.from.id !== OWNER_ID) {
    await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'Owner only.', show_alert: true });
    return true;
  }
  await api.answerCallbackQuery({ callback_query_id: cq.id });
  if (cq.message) await editRich(cq.message, await renderGroupsPage(cq.from, Number(data.slice(7)) || 0));
  return true;
}
