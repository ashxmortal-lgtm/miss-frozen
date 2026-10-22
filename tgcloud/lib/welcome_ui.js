// MissFrozen welcome + gaming help (no mode chooser, no admin welcome).
import { api } from './message_api.js';
import { OWNER_ID, BOT_USERNAME } from './config.js';
import { listCommands } from './command_registry.js';

const bold = (text) => ({ type: 'bold', text });
const para = (...t) => ({ type: 'paragraph', text: t.length === 1 ? t[0] : t });
const head = (text) => ({ type: 'heading', text, size: 2 });
const divider = { type: 'divider' };
const row = (...buttons) => ({ type: 'buttons', buttons, align: 'center' });
const cb = (text, data, style) => (style ? { text, callback_data: data, style } : { text, callback_data: data });
const urlBtn = (text, url, style) => (style ? { text, url, style } : { text, url });
const rich = (blocks) => ({ blocks, skip_entity_detection: false });
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

  // Normal welcome: retain the existing primary button rows.
  return [
    para(mention(user), ' ᴡᴇʟᴄᴏᴍᴇ! ❄️'),
    para(`${BOT_NAME} ɪꜱ ᴀ ɴᴀʀᴜᴛᴏ-ɪɴꜱᴘɪʀᴇᴅ ɢᴀᴍᴇ ʙᴏᴛ ꜰᴏʀ ɢʀᴏᴜᴘꜱ ᴀɴᴅ ᴀɴɪᴍᴇ ꜰᴀɴꜱ.`),
    para('🎮 ᴇxᴘʟᴏʀᴇ /help ꜰᴏʀ ɢᴀᴍᴇꜱ, ᴛʜᴇ ꜱᴛᴏʀᴇ & ᴋᴏɴᴏʜᴀ /map!'),
    para('❓ ᴡᴀɴɴᴀ ʟᴇᴀʀɴ ʜᴏᴡ ᴛᴏ ᴘʟᴀʏ?'),
    para('➜ ', urlText('ᴄʜᴇᴄᴋ ᴛʜɪꜱ', 'https://t.me/frozenblooded/22'), ' ᴏᴜᴛ!'),
    para(`➕ ᴀᴅᴅ ${BOT_NAME} ᴛᴏ ᴜʀ ɢʀᴏᴜᴘ ᴀꜱ ᴀɴ ᴀᴅᴍɪɴ ᴛᴏ ʙᴇɢɪɴ ᴜʀ ꜱʜɪɴᴏʙɪ ᴊᴏᴜʀɴᴇʏ! 🗡️`),
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
    ...listCommands('user')
      .filter(({ cmd }) => !['/gift', '/hug', '/slap', '/punch', '/pat', '/games', '/xoxo', '/xoxo_stats', '/rps', '/rps_stats', '/xoxo_cancel', '/cancel_xoxo', '/rps_cancel', '/cancel_rps'].includes(cmd))
      .map(({ cmd, desc }) => cmdLine(cmd, desc)),
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
    cmdLine('/cancel_rps', 'Alternate RPS cancel command'),
    backBtn(`hp:game${sfx(w)}`),
  ];
}

export async function sendWelcome(chatId, user) {
  const blocks = await buildWelcomeBlocks(user);
  try {
    return await api.sendRichMessage({ chat_id: chatId, rich_message: rich(blocks) });
  } catch (e) {
    console.error('sendWelcome failed:', e?.description || e);
    return api.sendMessage({
      chat_id: chatId,
      text: `${user.first_name || 'User'} ᴡᴇʟᴄᴏᴍᴇ! ❄️\n\n` +
        `${BOT_NAME} ɪꜱ ᴀ ɴᴀʀᴜᴛᴏ-ɪɴꜱᴘɪʀᴇᴅ ɢᴀᴍᴇ ʙᴏᴛ ꜰᴏʀ ɢʀᴏᴜᴘꜱ ᴀɴᴅ ᴀɴɪᴍᴇ ꜰᴀɴꜱ.\n\n` +
        '🎮 ᴇxᴘʟᴏʀᴇ /help ꜰᴏʀ ɢᴀᴍᴇꜱ, ᴛʜᴇ ꜱᴛᴏʀᴇ & ᴋᴏɴᴏʜᴀ /map!\n\n' +
        '❓ ᴡᴀɴɴᴀ ʟᴇᴀʀɴ ʜᴏᴡ ᴛᴏ ᴘʟᴀʏ?\n➜ ᴄʜᴇᴄᴋ ᴛʜɪꜱ ᴏᴜᴛ! https://t.me/frozenblooded/22\n\n' +
        `➕ ᴀᴅᴅ ${BOT_NAME} ᴛᴏ ᴜʀ ɢʀᴏᴜᴘ ᴀꜱ ᴀɴ ᴀᴅᴍɪɴ ᴛᴏ ʙᴇɢɪɴ ᴜʀ ꜱʜɪɴᴏʙɪ ᴊᴏᴜʀɴᴇʏ! 🗡️`,
      reply_markup: await primaryKeyboard(user.id),
    });
  }
}

async function editTo(cq, blocks, detectEntities = false) {
  try {
    await api.editMessageText({
      chat_id: cq.message.chat.id,
      message_id: cq.message.message_id,
      rich_message: detectEntities
        ? { blocks: Array.isArray(blocks) ? blocks : blocks?.blocks || [] }
        : { blocks: Array.isArray(blocks) ? blocks : blocks?.blocks || [], skip_entity_detection: false },
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
