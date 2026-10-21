import { BotApiError } from 'sdk';
import { db } from 'sdk';
import { sql } from 'sdk/db';
import { api } from './message_api.js';
import { style, escapeHtml } from './texts.js';
import { SHINOBI, JUTSU, CHAKRA_RATE, boldNum, fmt } from './store.js';
import { OWNER_ID } from './admin.js';
import { send, sendRich } from './chat.js';
import { getEquipped, getAllShinobiState } from './rpg/state.js';
import { MINI_APP_STORE_URL } from './config.js';

// ---- block shapes (the only place to fix if Telegram rejects one) ----
const S = (t) => style(t);
export const P = (t) => ({ type: 'paragraph', text: typeof t === 'string' ? S(t) : t });
export const quote = (t) => ({ type: 'blockquote', blocks: String(t).split('\n').map((l) => P(l)) });
export const table = (rows) => ({
  type: 'table', is_bordered: true, is_compact: true,
  cells: rows.map((r) => r.map((c) => {
    if (c && typeof c === 'object') {
      if (c.text) return c;
      return { text: c };
    }
    return { text: S(c) };
  })),
});
const code = (t) => ({ type: 'code', text: t });
const mentionNode = (u) => ({
  type: 'text_mention', text: u.first_name || 'User',
  user: { id: u.id, first_name: u.first_name || 'User' },
});
// A row of buttons. Each button: callback_data OR url.
export const btn = (label, extra) => ({ text: S(label), ...extra });
export const row = (...buttons) => ({ type: 'buttons', align: 'center', buttons });

// Mention paragraph always comes first.
const build = (user, content) => [P([mentionNode(user)]), ...content];

async function debug(user, e) {
  console.error(e);
  if (user.id !== OWNER_ID) return;
  try {
    await send(user.id, {
      text: `rich failed: <code>${escapeHtml(String(e.description || e.message).slice(0, 300))}</code>`,
      parse_mode: 'HTML',
    });
  } catch (_) { /* ignore */ }
}

// Send rich; on Telegram refusal run the classic sender instead.
export async function richOr(chatId, user, content, classic) {
  try {
    return await sendRich(chatId, { rich_message: { blocks: build(user, content) } });
  } catch (e) {
    if (!(e instanceof BotApiError)) throw e;
    await debug(user, e);
    return classic();
  }
}

// Edit the same message as rich; on refusal run the classic edit.
export async function editRichOr(msg, user, content, classic) {
  try {
    await api.editMessageText({
      chat_id: msg.chat.id,
      message_id: msg.message_id,
      rich_message: { blocks: build(user, content) },
    });
  } catch (e) {
    if (!(e instanceof BotApiError)) throw e;
    if (/not modified/i.test(String(e.description || ''))) return;
    await debug(user, e);
    await classic();
  }
}

// ---- screens ----
const footer = () => [
  P('───────────────'),
  P('🛒 /buy [item name]'),
];

// Short skill notes — only skills already defined in the game.
const SKILL_NOTES = {
  Sasuke: 'mission specialist',
  Sakura: 'boost on /claim, patrol, mission · patrol only · healing at Lv. 4',
  Naruto: '×3 patrol/mission rewards · shadow clone',
  Itachi: 'kill & rob · cannot patrol/mission',
  Hinata: '/byakugan — reveals protection time',
};

/**
 * Shinobi Store — rich table for items/prices, no copy buttons.
 * Async — callers must await it.
 */
export async function storeContent(screen, ownerId, options = {}) {
  const cb = (s, styleName = 'primary') => ({
    callback_data: `store:${s}:${ownerId}`,
    style: styleName,
  });
  if (screen === 'jutsu') {
    const rows = [['Item', 'Price']];
    for (const i of JUTSU) {
      rows.push([
        { text: [`${i.emoji} `, { type: 'code', text: i.name }] },
        `${fmt(i.price)} 🍥`,
      ]);
    }
    return [
      P('🌀 𝐉𝐔𝐓𝐒𝐔'),
      table(rows),
      ...footer(),
      row(btn('Back', cb('main', 'danger'))),
    ];
  }
  if (screen === 'chakra') {
    const rows = [
      ['Item', 'Price'],
      [{ text: ['⚡ ', { type: 'code', text: 'Chakra' }, ' × 100'] }, `${fmt(100 * CHAKRA_RATE)} 🍥`],
    ];
    return [
      P('⚡ 𝐂𝐇𝐀𝐊𝐑𝐀'),
      table(rows),
      ...footer(),
      row(btn('Back', cb('main', 'danger'))),
    ];
  }

  const balRow = await db.get(sql`SELECT balance FROM users WHERE telegram_id = ${ownerId}`);
  const balance = balRow ? balRow.balance : 0;
  const rows = [['Item', 'Price']];
  for (const i of SHINOBI) {
    rows.push([
      { text: [`${i.emoji} `, { type: 'code', text: i.name }] },
      `${fmt(i.price)} 🍥`,
    ]);
  }

  const buttons = [
    row(btn('Jutsu', cb('jutsu')), btn('Chakra', cb('chakra'))),
  ];
  if (options.includeMiniApp) {
    buttons.push(row(btn('Buy in Mini App', { web_app: { url: MINI_APP_STORE_URL }, style: 'success' })));
  }

  return [
    P('🏯 𝐒𝐇𝐈𝐍𝐎𝐁𝐈 𝐒𝐓𝐎𝐑𝐄'),
    P('ʀᴇᴄʀᴜɪᴛ ʏᴏᴜʀ ɴᴇxᴛ ꜱʜɪɴᴏʙɪ'),
    P(`🍥 Balance: ${fmt(balance)}`),
    P('⚔️ 𝐒𝐇𝐈𝐍𝐎𝐁𝐈'),
    table(rows),
    P('ᴜꜱᴇ /equip <shinobi name> & /unequip & <shinobi name> .\n (ᴍᴀx 3 active shinobis can be ᴇǫᴜɪᴘᴘᴇᴅ, rest shinobis will be passive.)'),
    ...footer(),
    ...buttons,
  ];
}

export function abilityContent(_ownerId, opts = {}) {
  const buttons = [
    row(btn('Check ❄️ abilities', { url: 'https://t.me/frozenblooded/27', style: 'success' })),
  ];
  if (opts.fromMap) {
    buttons.push(row(btn('Back', { callback_data: `map_home:${_ownerId}`, style: 'danger' })));
  }
  return [
    P('Clicked on button below to check abilities of all shinobis.'),
    ...buttons,
  ];
}

export function groupOnlyContent(cmd) {
  return [
    P('「𝐆𝐑𝐎𝐔𝐏 𝐂𝐎𝐌𝐌𝐀𝐍𝐃」'),
    P(`/${cmd} works in groups only.`),
    P('» use it in a group where i am a member.'),
    row(btn('Add to grp', { url: 'tg://resolve?domain=missfrozen_bot&startgroup=true', style: 'danger' })),
  ];
}
