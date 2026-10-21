// MissFrozen welcome + gaming help (no mode chooser, no admin welcome).
import { db } from 'sdk';
import { api } from './message_api.js';
import { OWNER_ID, BOT_USERNAME } from './config.js';
import { listCommands } from './command_registry.js';
import { sql } from 'sdk/db';
import { getEquipped } from './rpg/state.js';

const bold = (text) => ({ type: 'bold', text });
const para = (...t) => ({ type: 'paragraph', text: t.length === 1 ? t[0] : t });
const head = (text) => ({ type: 'heading', text, size: 2 });
const divider = { type: 'divider' };
const row = (...buttons) => ({ type: 'buttons', buttons, align: 'center' });
const cb = (text, data, style) => (style ? { text, callback_data: data, style } : { text, callback_data: data });
const urlBtn = (text, url, style) => (style ? { text, url, style } : { text, url });
const rich = (blocks) => ({ blocks });
/** Plain-text command (no code formatting) so Telegram makes it tappable. */
const cmdLine = (cmd, desc) => para(`${cmd}  —  ${desc}`);
const mention = (u) => ({
  type: 'text_mention',
  text: (u && u.first_name) || 'User',
  user: {
    id: u.id,
    is_bot: !!(u && u.is_bot),
    first_name: (u && u.first_name) || 'User',
    last_name: u && u.last_name,
    username: u && u.username,
  },
});

async function botUsername() {
  try {
    const me = await api.getMe();
    return me.username || BOT_USERNAME;
  } catch (_) {
    return BOT_USERNAME;
  }
}

const blockquote = (...lines) => ({ type: 'blockquote', blocks: lines.map((l) => para(l)) });
const urlText = (text, url) => ({ type: 'url', text, url });
const BOT_NAME = '𝑴𝒊𝒔𝒔 𝑭𝒓❄️𝒛𝒆𝒏';

const addToGroupUrl = (uname) =>
  `https://t.me/${uname}?startgroup=true&admin=delete_messages+restrict_members+invite_users+pin_messages+manage_video_chats+change_info+manage_topics+promote_members`;

// Add to grp = red, Help = green, Contact owner = blue.
async function primaryButtons(userId) {
  const uname = await botUsername();
  return [
    row(
      urlBtn('Add to grp', addToGroupUrl(uname), 'danger'),
      cb('Help', 'wel:help', 'success'),
    ),
    row(cb('Contact ❄️ owner', `si:menu:${userId}`, 'primary')),
  ];
}

/** Mini profile shown in the normal-user welcome. */
async function miniProfile(user) {
  const uid = user.id;
  const out = { equipped: 'Starter Shinobi', balance: 0, jutsu: 'None', kills: 0, rank: '—' };
  try { out.equipped = await getEquipped(uid); } catch (_) {}
  try {
    const u = await db.get(sql`SELECT balance, kills FROM users WHERE telegram_id = ${uid}`);
    if (u) {
      out.balance = u.balance || 0;
      out.kills = u.kills || 0;
      const r = await db.get(sql`SELECT COUNT(*) + 1 AS pos FROM users WHERE balance > ${u.balance || 0}`);
      out.rank = r ? `#${r.pos}` : '—';
    }
  } catch (_) {}
  try {
    const rows = await db.all(sql`
      SELECT item_name FROM inventory WHERE telegram_id = ${uid} AND item_type = 'jutsu' ORDER BY item_name
    `);
    if (rows && rows.length) out.jutsu = rows.map((r) => r.item_name).join(', ');
  } catch (_) {}
  return out;
}


function ownerCmdLines() {
  return listCommands('owner')
    .filter((c) => c.access === 'owner')
    .map((c) => para(`${c.cmd}  —  ${c.desc}`));
}

function userHelpLines() {
  return listCommands('user').map((c) => para(`${c.cmd}  —  ${c.desc}`));
}

export async function buildWelcomeBlocks(user) {
  const buttons = await primaryButtons(user.id);
  const uname = await botUsername();

  if (user.id === OWNER_ID) {
    return [
      para(mention(user)),
      head('👑 OWNER DASHBOARD'),
      para(`Welcome to @${uname}`),
      para('Owner-only commands:'),
      divider,
      ...ownerCmdLines(),
      divider,
      ...buttons,
    ];
  }

  // Normal user (MissFrozen has no /imfrozen admin welcome).
  const mp = await miniProfile(user);
  const botLink = `https://t.me/${uname}`;
  return [
    para(mention(user), ' ᴡᴇʟᴄᴏᴍᴇ!'),
    para(
      urlText(BOT_NAME, botLink),
      ' is a Naruto-inspired game bot for groups and anime fans. Check the Help menu to explore the games, store and Konoha map!',
    ),
    para('/daily — Claim your daily shinobi coins 🍥'),
    para('ʏᴏᴜʀ ᴍɪɴɪ ᴘʀᴏꜰɪʟᴇ'),
    blockquote(
      `🥷 Shinobi: ${mp.equipped}`,
      `🍥 Balance: ${Number(mp.balance).toLocaleString('en-US')}`,
      `⚡ Owned Jutsu: ${mp.jutsu}`,
      `⚔️ Kills: ${mp.kills}`,
      `🏆 Global Rank: ${mp.rank}`,
    ),
    para('Add ', urlText(BOT_NAME, botLink), ' to your group as an admin to begin your shinobi journey!'),
    ...buttons,
  ];
}

// ---- /help: gaming commands directly ----
// Callback data: hp:<screen>[:w]. The ":w" suffix means the menu was opened
// from the welcome message, so the top-level Back returns there.

const backBtn = (data) => row(cb('← Back', data, 'danger'));
const sfx = (fromWelcome) => (fromWelcome ? ':w' : '');

export async function buildUserHelpBlocks(_user, fromWelcome = false) {
  // Gaming help directly — no mode chooser.
  return gameBlocks(fromWelcome);
}

function gameBlocks(w) {
  return [
    head('Game ❄️ mode', 6),
    cmdLine('/daily', 'claim daily 500 shinobi coins 🍥'),
    cmdLine('/map', 'Open konoha village map'),
    cmdLine('/shinobi_store', 'buy shinobis and jutsu'),
    cmdLine('/gift_store', 'naruto themed gifts'),
    cmdLine('/mission', 'Start a mission'),
    cmdLine('/patrol', 'Start a patrol'),
    cmdLine('/kill', 'kill a target'),
    cmdLine('/rob', 'Rob a target'),
    cmdLine('/protect', 'Activate protection'),
    cmdLine('/byakugan', 'Check protection status'),
    cmdLine('/search_tsuna', 'Search for Tsunade'),
    cmdLine('/mt', 'send Mind Transmission to target'),
    cmdLine('/transfer', 'transfer coins (reply in group)'),
    cmdLine('/equip · /unequip', 'equip shinobi (max 3)'),
    cmdLine('/leaderboard (/lb)', 'top balances'),
    row(cb('Extras', `hp:extras${sfx(w)}`, 'primary'), cb('more ❄️ games', `hp:more${sfx(w)}`, 'primary')),
    ...(w ? [backBtn('wel:back')] : []),
  ];
}

function extrasBlocks(w) {
  return [
    head('Extras', 6),
    cmdLine('/gift', 'Send a gift'),
    cmdLine('/hug', 'Hug a user'),
    cmdLine('/slap', 'Slap a user'),
    cmdLine('/punch', 'Punch a user'),
    cmdLine('/pat', 'Pat a user'),
    backBtn(`hp:game${sfx(w)}`),
  ];
}

function moreGamesBlocks(w) {
  return [
    head('more ❄️ games', 6),
    cmdLine('/games', 'Open games menu (non naruto themed)'),
    cmdLine('/xoxo', 'Play XOXO'),
    cmdLine('/xoxo_cancel', 'Cancel XOXO'),
    cmdLine('/cancel_xoxo', 'Alternate XOXO cancel command'),
    cmdLine('/xoxo_stats', 'View XOXO stats'),
    cmdLine('/rps', 'Play Rock Paper Scissors'),
    cmdLine('/rps_stats', 'View RPS stats'),
    cmdLine('/rps_cancel', 'Cancel RPS lobby'),
    backBtn(`hp:game${sfx(w)}`),
  ];
}

export async function sendWelcome(chatId, user) {
  const blocks = await buildWelcomeBlocks(user);
  try {
    return await api.sendRichMessage({ chat_id: chatId, rich_message: rich(blocks) });
  } catch (e) {
    console.error('sendWelcome failed:', e?.description || e);
    // Second try without mention entity (some clients reject text_mention in certain contexts)
    try {
      const uname = await botUsername();
      const simple = [
        para(`Welcome to ${BOT_NAME} bot.`),
        para('Naruto inspired game for groups and anime fans.'),
        para('/daily : claim daily shinobi coins 🍥'),
        ...(await primaryButtons(user.id)),
      ];
      return await api.sendRichMessage({ chat_id: chatId, rich_message: rich(simple) });
    } catch (e2) {
      console.error('sendWelcome simple failed:', e2?.description || e2);
      const uname = await botUsername();
      return api.sendMessage({
        chat_id: chatId,
        text:
          `${user.first_name || 'User'} welcome to ${BOT_NAME} bot.\n\n` +
          'Naruto inspired game for groups and anime fans.\n\n' +
          '/daily : claim daily shinobi coins 🍥',
      });
    }
  }
}

async function editTo(cq, blocks, detectEntities = false) {
  try {
    await api.editMessageText({
      chat_id: cq.message.chat.id,
      message_id: cq.message.message_id,
      rich_message: detectEntities
        ? { blocks: Array.isArray(blocks) ? blocks : blocks?.blocks || [] }
        : { blocks: Array.isArray(blocks) ? blocks : blocks?.blocks || [], skip_entity_detection: true },
    });
  } catch (e) {
    if (Array.isArray(blocks)) {
      const text = plainBlocksText(blocks);
      await api.editMessageText({
        chat_id: cq.message.chat.id,
        message_id: cq.message.message_id,
        text,
      });
      return;
    }
    throw e;
  }
}

function plainRichText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(plainRichText).join('');
  if (!value || typeof value !== 'object') return '';
  if (value.type === 'text_mention' || value.type === 'url') return String(value.text || '');
  return plainRichText(value.text ?? value.blocks ?? '');
}

function plainBlocksText(blocks) {
  return (blocks || []).map((block) => {
    if (!block || typeof block !== 'object') return '';
    if (block.type === 'divider') return '────────────';
    if (block.type === 'heading' || block.type === 'paragraph') return plainRichText(block.text);
    return '';
  }).filter(Boolean).join('\n');
}

export async function handleWelcomeCallback(cq) {
  const data = cq.data || '';
  const isHelp = data.startsWith('hp:');
  if (data !== 'wel:help' && data !== 'wel:back' && !isHelp) return false;
  if (!cq.message) {
    await api.answerCallbackQuery({ callback_query_id: cq.id }).catch(() => {});
    return true;
  }

  try {
    if (data === 'wel:back') {
      await api.answerCallbackQuery({ callback_query_id: cq.id });
      await editTo(cq, await buildWelcomeBlocks(cq.from));
      return true;
    }
    if (data === 'wel:help') {
      await api.answerCallbackQuery({ callback_query_id: cq.id });
      await editTo(cq, await buildUserHelpBlocks(cq.from, true));
      return true;
    }

    const [, screen, flag] = data.split(':');
    const w = flag === 'w';
    await api.answerCallbackQuery({ callback_query_id: cq.id });
    const blocks = screen === 'game' ? gameBlocks(w)
      : screen === 'extras' ? extrasBlocks(w)
        : screen === 'more' ? moreGamesBlocks(w)
          : await buildUserHelpBlocks(cq.from, w);
    await editTo(cq, blocks, screen === 'game' || screen === 'extras' || screen === 'more');
  } catch (e) {
    console.error('welcome callback failed:', e?.description || e);
    try { await api.answerCallbackQuery({ callback_query_id: cq.id }); } catch (_) {}
  }
  return true;
}

export async function buildWelcome(user) {
  return { blocks: await buildWelcomeBlocks(user), rich: true };
}
export function buildUserHelp() { return 'Use /help'; }
export async function primaryKeyboard(userId) {
  const uname = await botUsername();
  return {
    inline_keyboard: [
      [
        { text: 'Add to grp', url: addToGroupUrl(uname), style: 'danger' },
        { text: 'Help', callback_data: 'wel:help', style: 'success' },
      ],
      ...(userId ? [[{ text: 'Contact ❄️ owner', callback_data: `si:menu:${userId}`, style: 'primary' }]] : []),
    ],
  };
}
