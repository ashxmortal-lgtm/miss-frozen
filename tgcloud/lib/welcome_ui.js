// MissFrozen welcome + gaming help (no mode chooser, no admin welcome).
import { api } from './message_api.js';
import { OWNER_ID, BOT_USERNAME } from './config.js';
import { listCommands, PET_COMMANDS } from './command_registry.js';

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

/** Quoted block of already-built paragraph blocks. */
const blockquote = (...blocks) => ({ type: 'blockquote', blocks });
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
  const botLink = `https://t.me/${uname}`;
  return [
    para(mention(user), ' ᴡᴇʟᴄᴏᴍᴇ! ❄️'),
    // Requested: the intro + HELP line are quoted together.
    blockquote(
      // The bot name is linked to the bot itself.
      para(urlText(BOT_NAME, botLink), ' ɪꜱ ᴀ ɴᴀʀᴜᴛᴏ-ɪɴꜱᴘɪʀᴇᴅ ɢᴀᴍᴇ ʙᴏᴛ ꜰᴏʀ ɢʀᴏᴜᴘꜱ ᴀɴᴅ ᴀɴɪᴍᴇ ꜰᴀɴꜱ.'),
      para('🎮 ᴛᴀᴘ ᴛʜᴇ 𝐇𝐄𝐋𝐏 ʙᴜᴛᴛᴏɴ ᴛᴏ ᴇxᴘʟᴏʀᴇ ɢᴀᴍᴇꜱ, ᴄᴏᴍᴍᴀɴᴅꜱ & ʀᴇᴡᴀʀᴅꜱ! ❄️'),
    ),
    para('❓ ᴡᴀɴɴᴀ ʟᴇᴀʀɴ ʜᴏᴡ ᴛᴏ ᴘʟᴀʏ?'),
    para('➜ ', urlText('ᴄʜᴇᴄᴋ ᴛʜɪꜱ', 'https://t.me/frozenblooded/22'), ' ᴏᴜᴛ!'),
    para('➕ ᴀᴅᴅ ', urlText(BOT_NAME, botLink),
      ' ᴛᴏ ᴜʀ ɢʀᴏᴜᴘ ᴀꜱ ᴀɴ ᴀᴅᴍɪɴ ᴛᴏ ʙᴇɢɪɴ ᴜʀ ꜱʜɪɴᴏʙɪ ᴊᴏᴜʀɴᴇʏ! 🗡️'),
    ...buttons,
  ];
}

// ---- /help: gaming commands directly ----
// Callback data: hp:<screen>[:w]. The ":w" suffix means the menu was opened
// from the welcome message, so Back returns there (instead of the help home).
//
// Layout (requested): quoted combat/profile block → divider → quoted PvP block
// → divider → /start /help /owner, then [PETS][JUTSU][FUN] and
// [MORE ❄️ GAMES][BACK]. Commands stay plain text (never code) so Telegram
// keeps them tappable.

const backBtn = (data) => row(cb('⬅️ Back', data, 'danger'));
const sfx = (fromWelcome) => (fromWelcome ? ':w' : '');

const HELP_BLOCK_ONE = [
  '/claim', '/balance', '/profile', '/inventory', '/shinobi_store', '/gift_store',
  '/buy', '/mission', '/patrol', '/map', '/ability',
];
const HELP_BLOCK_TWO = [
  '/kill', '/rob', '/protect', '/transfer', '/leaderboard', '/equip', '/unequip', '/redeem',
];
const HELP_FOOTER = ['/start', '/help', '/owner'];

// Jutsu / shinobi arts live behind their own button.
const JUTSU_COMMANDS = ['/mt', '/byakugan'];
const FUN_COMMANDS = ['/gift', '/hug', '/slap', '/punch', '/pat'];
const MORE_GAMES_COMMANDS = [
  '/games', '/xoxo', '/xoxo_cancel', '/xoxo_stats', '/rps', '/rps_cancel', '/rps_stats',
];

function commandDesc(cmd) {
  const entry = listCommands('user').find((c) => c.cmd === cmd);
  return entry ? entry.desc : '';
}

/** One tappable command line (`/cmd — description`). */
function commandPara(cmd) {
  const desc = commandDesc(cmd);
  return desc ? cmdLine(cmd, desc) : para(cmd);
}

const quoteOf = (cmds) => blockquote(...cmds.map(commandPara));

function helpNav(w) {
  return [
    row(
      cb('PETS', `hp:pets${sfx(w)}`, 'primary'),
      cb('JUTSU', `hp:jutsu${sfx(w)}`, 'primary'),
      cb('FUN', `hp:fun${sfx(w)}`, 'primary'),
    ),
    row(
      cb('MORE ❄️ GAMES', `hp:more${sfx(w)}`, 'primary'),
      cb('BACK', w ? 'wel:back' : `hp:main${sfx(w)}`, 'danger'),
    ),
  ];
}

export async function buildUserHelpBlocks(_user, fromWelcome = false) {
  // Gaming help directly — no mode chooser.
  return gameBlocks(fromWelcome);
}

function gameBlocks(w) {
  return [
    head('🎮 𝐆𝐀𝐌𝐄 𝐂𝐎𝐌𝐌𝐀𝐍𝐃𝐒', 6),
    quoteOf(HELP_BLOCK_ONE),
    divider,
    quoteOf(HELP_BLOCK_TWO),
    divider,
    ...HELP_FOOTER.map(commandPara),
    ...helpNav(w),
  ];
}

function petsBlocks(w) {
  return [
    head('🐾 𝐏𝐄𝐓 𝐂𝐎𝐌𝐌𝐀𝐍𝐃𝐒', 6),
    quoteOf(PET_COMMANDS),
    para('Buy with /buy, equip with /equip — food & abilities live in /pet_store.'),
    backBtn(`hp:main${sfx(w)}`),
  ];
}

function jutsuBlocks(w) {
  return [
    head('🌀 𝐉𝐔𝐓𝐒𝐔 & 𝐒𝐇𝐈𝐍𝐎𝐁𝐈 𝐀𝐑𝐓𝐒', 6),
    quoteOf(JUTSU_COMMANDS),
    backBtn(`hp:main${sfx(w)}`),
  ];
}

function funBlocks(w) {
  return [
    head('🎉 𝐅𝐔𝐍', 6),
    quoteOf(FUN_COMMANDS),
    backBtn(`hp:main${sfx(w)}`),
  ];
}

function moreGamesBlocks(w) {
  return [
    head('🎲 𝐌𝐎𝐑𝐄 ❄️ 𝐆𝐀𝐌𝐄𝐒', 6),
    quoteOf(MORE_GAMES_COMMANDS),
    backBtn(`hp:main${sfx(w)}`),
  ];
}

export async function sendWelcome(chatId, user) {
  const blocks = await buildWelcomeBlocks(user);
  try {
    return await api.sendRichMessage({ chat_id: chatId, rich_message: rich(blocks) });
  } catch (e) {
    console.error('sendWelcome failed:', e?.description || e);
    const uname = await botUsername();
    const botLink = `https://t.me/${uname}`;
    return api.sendMessage({
      chat_id: chatId,
      parse_mode: 'HTML',
      text: `${user.first_name || 'User'} ᴡᴇʟᴄᴏᴍᴇ! ❄️\n\n` +
        `<blockquote><a href="${botLink}">${BOT_NAME}</a> ɪꜱ ᴀ ɴᴀʀᴜᴛᴏ-ɪɴꜱᴘɪʀᴇᴅ ɢᴀᴍᴇ ʙᴏᴛ ꜰᴏʀ ɢʀᴏᴜᴘꜱ ᴀɴᴅ ᴀɴɪᴍᴇ ꜰᴀɴꜱ.\n\n` +
        '🎮 ᴛᴀᴘ ᴛʜᴇ 𝐇𝐄𝐋𝐏 ʙᴜᴛᴛᴏɴ ᴛᴏ ᴇxᴘʟᴏʀᴇ ɢᴀᴍᴇꜱ, ᴄᴏᴍᴍᴀɴᴅꜱ & ʀᴇᴡᴀʀᴅꜱ! ❄️</blockquote>\n\n' +
        '❓ ᴡᴀɴɴᴀ ʟᴇᴀʀɴ ʜᴏᴡ ᴛᴏ ᴘʟᴀʏ?\n➜ ᴄʜᴇᴄᴋ ᴛʜɪꜱ ᴏᴜᴛ! https://t.me/frozenblooded/22\n\n' +
        `➕ ᴀᴅᴅ <a href="${botLink}">${BOT_NAME}</a> ᴛᴏ ᴜʀ ɢʀᴏᴜᴘ ᴀꜱ ᴀɴ ᴀᴅᴍɪɴ ᴛᴏ ʙᴇɢɪɴ ᴜʀ ꜱʜɪɴᴏʙɪ ᴊᴏᴜʀɴᴇʏ! 🗡️`,
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
      // Classic fallback: keep every quoted command and the navigation buttons.
      const text = plainBlocksText(blocks);
      const keyboard = plainKeyboard(blocks);
      await api.editMessageText({
        chat_id: cq.message.chat.id,
        message_id: cq.message.message_id,
        text,
        ...(keyboard ? { reply_markup: keyboard } : {}),
      });
      return;
    }
    throw e;
  }
}

function plainKeyboard(blocks) {
  const rows = (blocks || [])
    .filter((block) => block?.type === 'buttons')
    .map((block) => (block.buttons || [])
      .filter((button) => button.callback_data || button.url)
      .map((button) => ({
        text: button.text,
        ...(button.callback_data ? { callback_data: button.callback_data } : {}),
        ...(button.url ? { url: button.url } : {}),
      })))
    .filter((row) => row.length);
  return rows.length ? { inline_keyboard: rows } : null;
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
    if (block.type === 'blockquote') return plainBlocksText(block.blocks);
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
    // Old codes (game / extras) are kept so buttons sent before this update
    // still land on a working screen.
    const blocks = (screen === 'pets') ? petsBlocks(w)
      : (screen === 'jutsu') ? jutsuBlocks(w)
        : (screen === 'fun' || screen === 'extras') ? funBlocks(w)
          : (screen === 'more') ? moreGamesBlocks(w)
            : gameBlocks(w);
    await editTo(cq, blocks, ['game', 'main', 'pets', 'jutsu', 'fun', 'extras', 'more'].includes(screen));
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
