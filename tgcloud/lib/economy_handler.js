import { sweepTsunadeSearches } from "./rpg/tsunade.js";
import { handleRedeemCoupon } from "./coupons.js";
// Economy commands + store/level-up buttons, restored from the old handlers.
// /start /help /claim /balance /inventory /shinobi_store /buy /mission /patrol /ability /addcoins /backup
import { runBackup, runFullBackup } from "./backup.js";
import { BotApiError, db } from 'sdk';
import { sql } from 'sdk/db';
import { api } from './message_api.js';
import {
  claimDaily, DAILY_XP, DAILY_COINS, DAILY_CHAKRA, BONUS_COINS, BONUS_CHAKRA,
  SAKURA_COINS, SAKURA_CHAKRA, getBalance, adjustBalance,
} from './economy.js';
import { render, style, escapeHtml, COIN, mention as mentionFn } from './texts.js';
import { SCREENS, screenText, screenKeyboard, findItem, fmt } from './store.js';
import { handleBuy } from './buy.js';
import { purchase } from './purchase.js';
import { ownedSet, getEquipped, setEquipped, equipShinobi, unequipShinobi, getEquippedList } from './rpg/state.js';
import { sendInventory } from './inventory.js';
import { addCoins, OWNER_ID } from './admin.js';
import { runActivity, sweepActivities } from './activities.js';
import { grantStarter, STARTER_NOTICE } from './starter.js';
import { balanceText, trackGroup } from './balance.js';
import { abilityText, abilityKeyboard, backKeyboard } from './ability.js';
import { levelsText, levelsContent } from './levels.js';
import { economyLocked, ECO_LOCKED_TEXT } from './groupadmin.js';
import { richOr, editRichOr, storeContent, abilityContent, groupOnlyContent, table } from './rich.js';
import { helpText } from './help.js';
import { profileText } from './profile.js';
import { sendWelcome, buildUserHelpBlocks } from './welcome_ui.js';
import {
  handleKill, handleRob, handleProtect, handleByakugan,
  handleCloneCallback, isCloneCallback, handleByakuganCallback, isByakuganCallback,
  sweepClones,
} from '../lib/rpg/combat.js';
import { handleSearchTsuna } from '../lib/rpg/tsunade.js';
import { send, sweepMessages, trackUser } from './chat.js';
import { groupChatLink } from './telegram_links.js';

import { BOT_USERNAME } from './config.js';

function reply(message, body, extra = {}) {
  return send(message.chat.id, {
    text: render(message.from, body),
    parse_mode: 'HTML',
    ...extra,
  });
}

function claimBody(r) {
  const bar = '●'.repeat(r.streak) + '○'.repeat(7 - r.streak);
  if (!r.claimed) {
    return `⏳ 𝐀𝐋𝐑𝐄𝐀𝐃𝐘 𝐂𝐋𝐀𝐈𝐌𝐄𝐃\n\nCome back after 12:00 AM IST.\n\nStreak: ${r.streak}/7  ${bar}\nBalance: ${fmt(r.balance)} 🍥`;
  }
  let s = `✅ 𝐃𝐀𝐈𝐋𝐘 𝐂𝐋𝐀𝐈𝐌\n\n+${fmt(DAILY_COINS)} ${COIN}\n+chakra x ${DAILY_CHAKRA} ⚡\n+${DAILY_XP} XP ✦`;
  if (r.sakura) {
    s += `\n\n🌸 𝐒𝐀𝐊𝐔𝐑𝐀 𝐁𝐎𝐎𝐒𝐓\n+${fmt(r.sakuraCoins ?? SAKURA_COINS)} ${COIN}\n+chakra x ${r.sakuraChakra ?? SAKURA_CHAKRA} ⚡`;
  }
  if (r.bonus) {
    s += `\n\n🎉 𝐃𝐀𝐘 𝟕 𝐁𝐎𝐍𝐔𝐒\n+${fmt(BONUS_COINS)} ${COIN}\n+chakra x ${BONUS_CHAKRA} ⚡`;
  }
  s += `\n\nStreak: ${r.streak}/7  ${bar}\nBalance: ${fmt(r.balance)} 🍥`;
  if (r.chakraFailed) s += `\n\n⚠️ Chakra couldn't be added. Contact the owner.`;
  return s;
}

// Finished missions/patrols: group reminder + short DM + claim button.
async function announceDone() {
  try { await sweepTsunadeSearches(); } catch (e) { console.error(e); }
  for (const r of await sweepActivities()) {
    const who = { id: r.id, first_name: r.name };
    const claimKb = {
      inline_keyboard: [[{
        text: '🏯 Open Hokage Office',
        callback_data: `map_loc_hokage:${r.id}`,
        style: 'success',
      }]],
    };
    if (r.chatId && r.chatId < 0) {
      try {
        await send(r.chatId, {
          text: render(who, r.reminder),
          parse_mode: 'HTML',
          reply_markup: claimKb,
        });
      } catch (e) { console.error(e); }
    }
    try {
      await send(r.id, {
        text: render(who, r.dm),
        parse_mode: 'HTML',
        reply_markup: claimKb,
      });
    } catch (e) { /* user never started the bot in DM */ }
  }
}

// Everything that touches coins, shinobi, inventory or rewards. /start and /help stay open.
const ECONOMY_CMDS = new Set([
  'balance', 'inventory', 'profile', 'claim', 'daily', 'shinobi_store', 'buy',
  'mission', 'patrol', 'map', 'ability', 'abilities', 'addcoins',
  'kill', 'rob', 'protect', 'byakugan', 'mt', 'gift', 'gift_store',
  'search_tsuna', 'transfer', 'leaderboard', 'lb',
  'equip', 'unequip', 'redeem',
  'hug', 'slap', 'punch', 'pat',
  'xoxo', 'rps', 'games', 'xoxo_stats', 'rps_stats',
]);

export async function handleEconomyCommand(message, ctx) {
  // ===== /backup command =====
  const backupCmd = (message.text ?? "").split(/\s+/)[0].split("@")[0].toLowerCase();
  if (backupCmd === "/backup_all") {
    if (message.from?.id !== OWNER_ID) return;
    await runFullBackup(message.chat.id);
    return;
  }
  if (backupCmd === "/backup") {
    if (message.from?.id !== OWNER_ID) return;
    await runBackup(message.chat.id);
    return;
  }
  // ===== end /backup =====
  // No scheduler: cleanup, reminders and expired clone windows run on every incoming message.
  try { await sweepMessages(); } catch (e) { console.error(e); }
  try { await announceDone(); } catch (e) { console.error(e); }
  try { await sweepClones(); } catch (e) { console.error(e); }

  const text = message.text;
  const user = message.from;
  if (!text || !text.startsWith('/') || !user || user.is_bot) return;

  const head = text.split(/\s+/)[0].slice(1);
  const [rawCmd, target] = head.split('@');
  if (target && target.toLowerCase() !== BOT_USERNAME) return;
  const cmd = rawCmd.toLowerCase();

  // Per-group economy switch (/eco off): economy commands are refused in that group.
  if (ECONOMY_CMDS.has(cmd) && message.chat.type !== 'private') {
    let locked = false;
    try { locked = await economyLocked(message.chat.id); } catch (e) { console.error(e); }
    if (locked) {
      try {
        await send(message.chat.id, {
          text: ECO_LOCKED_TEXT,
          parse_mode: 'HTML',
          reply_parameters: { message_id: message.message_id },
        });
      } catch (e) { console.error(e); }
      return;
    }
  }

  try {
    try { await trackUser(user); } catch (e) { console.error(e); }
    try { await trackGroup(message); } catch (e) { console.error(e); }
    let starterNew = false;
    try { starterNew = await grantStarter(user); } catch (e) { console.error(e); }
    if (starterNew) await reply(message, STARTER_NOTICE);

    if (cmd === 'start') {
      await sendWelcome(message.chat.id, user);
      return;
    } else if (cmd === 'help') {
      try {
        const blocks = await buildUserHelpBlocks(user);
        await api.sendRichMessage({
          chat_id: message.chat.id,
          rich_message: { blocks },
        });
      } catch (e) {
        console.error('help rich failed:', e?.description || e);
        await reply(message, helpText(user));
      }
    } else if (cmd === 'ability' || cmd === 'abilities') {
      // rich blocks + rich button; classic layout if Telegram refuses
      await richOr(message.chat.id, user, abilityContent(user.id), () =>
        reply(message, abilityText(), { reply_markup: abilityKeyboard(user.id) }));
    } else if (cmd === 'shinobi_store') {
      const isPrivate = message.chat.type === 'private';
      const bal = isPrivate ? await getBalance(user.id) : null;
      await richOr(
        message.chat.id,
        user,
        await storeContent('main', user.id, { includeMiniApp: isPrivate }),
        () => reply(message, screenText('main', bal), {
          reply_markup: screenKeyboard('main', user.id, { includeMiniApp: isPrivate }),
        }),
      );
    } else if (cmd === 'mission' || cmd === 'patrol') {
      if (message.chat.type === 'private') {
        await richOr(message.chat.id, user, groupOnlyContent(cmd), () =>
          reply(message, `「𝐆𝐑𝐎𝐔𝐏 𝐂𝐎𝐌𝐌𝐀𝐍𝐃」\n\n/${cmd} works in groups only.\n\n» Use it in a group where I am a member.`));
      } else {
        const arg = text.trim().split(/\s+/).slice(1).join(' ');
        const r = await runActivity(user, cmd, arg || null, message.chat.id);
        await send(message.chat.id, {
          text: style(r.body),
          parse_mode: 'HTML',
          reply_parameters: { message_id: message.message_id },
        });
        for (const d of r.dms) {
          try {
            await send(user.id, { text: render(user, d), parse_mode: 'HTML' });
          } catch (e) { /* user never started the bot in DM */ }
        }
      }
    } else if (cmd === 'buy') {
      const body = await handleBuy(user, text, ctx?.update?.update_id);
      if (body) {
        await reply(message, body, {
          reply_parameters: { message_id: message.message_id },
        });
      }
    } else if (cmd === 'addcoins') {
      if (user.id !== OWNER_ID) return;
      await reply(message, await addCoins(message, text));
    } else if (cmd === 'inventory') {
      await sendInventory(message.chat.id, user);
    } else if (cmd === 'kill') {
      await handleKill(message);
    } else if (cmd === 'rob') {
      await handleRob(message);
    } else if (cmd === 'protect') {
      await handleProtect(message);
    } else if (cmd === 'byakugan') {
      await handleByakugan(message);
    } else if (cmd === 'search_tsuna') {
      await send(message.chat.id, {
        text: style(await handleSearchTsuna(message)),
        parse_mode: 'HTML',
        reply_parameters: { message_id: message.message_id },
      });
    } else if (cmd === 'claim' || cmd === 'daily') {
      if (message.chat.type !== 'private') {
        await reply(message, `Please use /Claim in the bot's DM: @${BOT_USERNAME}`);
        return;
      }
      await reply(message, claimBody(await claimDaily(user.id)));
    } else if (cmd === 'balance') {
      await send(message.chat.id, {
        text: style(await balanceText(message)),
        parse_mode: 'HTML',
      });
    } else if (cmd === 'profile') {
      await reply(message, await profileText(user, message));
    } else if (cmd === 'transfer') {
      await handleTransfer(message, text);
    } else if (cmd === 'leaderboard' || cmd === 'lb') {
      await handleLeaderboard(message);
    } else if (cmd === 'equip') {
      await handleEquip(message, text);
    } else if (cmd === 'unequip') {
      await handleUnequip(message, text);
    } else if (cmd === 'redeem') {
      await handleRedeemCoupon(message, text);
    }
  } catch (e) {
    console.error(e);
    if (!(e instanceof BotApiError)) {
      let msg = 'Something went wrong. Try again later.';
      if (user.id === OWNER_ID) {
        msg += `\n\n<code>${escapeHtml(String(e && e.message ? e.message : e).replace(/\s+/g, ' ').slice(0, 300))}</code>`;
      }
      try { await reply(message, msg); } catch (_) {}
    }
  }
}

// Classic edit, used only if Telegram refuses the rich edit.
async function classicEdit(msg, text, markup) {
  try {
    await api.editMessageText({
      chat_id: msg.chat.id, message_id: msg.message_id,
      text, parse_mode: 'HTML', reply_markup: markup,
    });
  } catch (e) {
    if (!(e instanceof BotApiError && e.code === 400)) throw e;
  }
}

async function editStoreScreen(msg, user, screen) {
  const balance = screen === 'main' ? await getBalance(user.id) : null;
  const markup = screenKeyboard(screen, user.id, {
    includeMiniApp: msg.chat.type === 'private' && screen === 'main',
  });
  return classicEdit(msg, render(user, screenText(screen, balance)), markup);
}

export async function handleEconomyCallback(cb) {
  const answer = (text, show_alert = false) =>
    api.answerCallbackQuery({ callback_query_id: cb.id, ...(text ? { text, show_alert } : {}) });

  const data = String(cb.data || '');
  // Global leaderboard button
  if (data === 'lb:global') {
    await answer();
    try {
      await sendGlobalLeaderboard(cb.message ? cb.message.chat.id : cb.from.id);
    } catch (e) { console.error('[lb:global]', e); }
    return true;
  }

  const [kind, a, b] = data.split(':');
  const msg = cb.message;
  const isStore = kind === 'store' && SCREENS.includes(a);
  const isLv = kind === 'lv' && (a === 'up' || a === 'ab');
  const isBuy = kind === 'sb';
  const isEquip = kind === 'seq';
  if (!(isStore || isLv || isBuy || isEquip)) return false;
  if (!msg) {
    await answer();
    return true;
  }
  // Buttons on old store/ability messages stop working while the group's economy is off.
  if (msg.chat.type !== 'private') {
    let locked = false;
    try { locked = await economyLocked(msg.chat.id); } catch (e) { console.error(e); }
    if (locked) {
      await api.answerCallbackQuery({ callback_query_id: cb.id, text: ECO_LOCKED_TEXT, show_alert: true });
      return true;
    }
  }
  if (cb.from.id !== Number(b)) {
    await answer("This menu isn't yours. Send the command to open your own.");
    return true;
  }
  try {
    if (isBuy || isEquip) {
      // Shinobi Store actions — purchase() is duplicate-tap safe (unique
      // inventory index + grant-before-charge), so rapid taps charge once.
      const item = findItem(a);
      if (!item || item.type !== 'shinobi') {
        await answer('Unknown shinobi.', true);
        return true;
      }
      if (isEquip) {
        const own = await ownedSet(cb.from.id);
        if (!own.has(item.name)) {
          await answer('You do not own this shinobi yet.', true);
          return true;
        }
        if ((await getEquipped(cb.from.id)) === item.name) {
          await answer(`${item.name} is already equipped.`);
          return true;
        }
        await setEquipped(cb.from.id, item.name);
        await answer(`${item.name} equipped! 👤`);
      } else {
        const r = await purchase(cb.from.id, null, {
          type: item.type, name: item.name, qty: 1, cost: item.price, emoji: item.emoji,
        });
        if (r.status === 'owned') {
          await answer('You already own this shinobi — no coins were charged.', true);
          return true;
        }
        if (r.status === 'insufficient') {
          await answer(`Not enough coins: need ${fmt(item.price)} 🍥, have ${fmt(r.balance)} 🍥.`, true);
          return true;
        }
        if (r.status !== 'ok') {
          await answer('Purchase failed — no coins were charged. Try again.', true);
          return true;
        }
        await answer(`${item.name} recruited for ${fmt(item.price)} 🍥! ✅`);
      }
      if (msg.chat.type === 'private') {
        await editStoreScreen(msg, cb.from, 'main');
      } else {
        await editRichOr(msg, cb.from, await storeContent('main', cb.from.id), () =>
          classicEdit(msg, render(cb.from, screenText('main')), screenKeyboard('main', cb.from.id)));
      }
      return true;
    }
    if (isStore) {
      if (msg.chat.type === 'private') {
        await editStoreScreen(msg, cb.from, a);
      } else {
        await editRichOr(msg, cb.from, await storeContent(a, cb.from.id), () =>
          classicEdit(msg, render(cb.from, screenText(a)), screenKeyboard(a, cb.from.id)));
      }
    } else if (a === 'up') {
      await editRichOr(msg, cb.from, await levelsContent(cb.from), async () =>
        classicEdit(msg, await levelsText(cb.from), backKeyboard(cb.from.id)));
    } else {
      await editRichOr(msg, cb.from, abilityContent(cb.from.id), () =>
        classicEdit(msg, render(cb.from, abilityText()), abilityKeyboard(cb.from.id)));
    }
  } catch (e) {
    if (!(e instanceof BotApiError && e.code === 400)) {
      console.error(e);
      await answer('Something went wrong. Try again.');
      return true;
    }
  }
  await answer();
  return true;
}



async function handleTransfer(message, text) {
  const user = message.from;
  const chat = message.chat;
  if (chat.type !== 'group' && chat.type !== 'supergroup') {
    await reply(message, 'Use /transfer in a group by replying to the receiver.');
    return;
  }
  const replied = message.reply_to_message?.from;
  if (!replied || replied.is_bot) {
    await reply(message, "Reply to a user's message: /transfer <amount>");
    return;
  }
  if (replied.id === user.id) {
    await reply(message, 'You cannot transfer to yourself.');
    return;
  }
  const args = text.trim().split(/\s+/).slice(1);
  const amountRaw = args[0];
  if (!amountRaw || !/^\d{1,9}$/.test(amountRaw) || Number(amountRaw) <= 0) {
    await reply(message, 'Usage: reply to user then /transfer <amount>');
    return;
  }
  const amount = Number(amountRaw);
  const bal = await getBalance(user.id);
  if (bal < amount) {
    await reply(message, `Not enough coins. You have ${fmt(bal)} 🍥.`);
    return;
  }
  await adjustBalance(user.id, -amount);
  await adjustBalance(replied.id, amount);
  const grpName = groupChatLink(chat, message.message_id);
  await reply(message, `✅ Transferred ${fmt(amount)} 🍥 to ${mentionFn(replied)}.`);
  try {
    await api.sendMessage({
      chat_id: replied.id,
      text: style(`🕸️ transferred ${fmt(amount)} 🍥 to your account.\nGrp name:  ${grpName}\nUse: /balance to check`),
      parse_mode: 'HTML',
    });
  } catch (_) {}
  try {
    await api.sendMessage({
      chat_id: user.id,
      text: style(`${mentionFn(user)}, ${fmt(amount)} 🍥 deducted from your account.\nYou transferred konoha coins to ${mentionFn(replied)} in ${grpName}`),
      parse_mode: 'HTML',
    });
  } catch (_) {}
}

async function handleLeaderboard(message) {
  const chat = message.chat;
  const isGroup = chat.type === 'group' || chat.type === 'supergroup';
  if (isGroup) {
    const rows = await db.all(sql`
      SELECT u.telegram_id AS id, u.username, u.first_name, u.balance
      FROM group_members g
      JOIN users u ON u.telegram_id = g.telegram_id
      WHERE g.chat_id = ${chat.id}
      ORDER BY u.balance DESC
      LIMIT 10
    `);
    const tableRows = [['Rank', 'Name', 'Coins']];
    if (rows && rows.length) {
      rows.forEach((r, i) => {
        const display = r.username
          ? `@${r.username}`
          : (r.first_name || String(r.id));
        // Group: mention everyone (text_mention works with or without username)
        tableRows.push([String(i + 1), display, `${fmt(r.balance)} 🍥`]);
      });
    } else {
      tableRows.push(['—', 'No data yet', '—']);
    }
    const blocks = [
      { type: 'heading', text: '🏆 Group Leaderboard', size: 2 },
      table(tableRows),
      { type: 'buttons', align: 'center', buttons: [
        { text: style('Global leaderboard'), callback_data: 'lb:global', style: 'primary' },
      ]},
    ];
    // For group mentions we still want clickable names when possible; use classic fallback with mentions
    try {
      await api.sendRichMessage({
        chat_id: message.chat.id,
        rich_message: { blocks },
      });
    } catch (e) {
      // Fallback classic with mentions for all
      let body = `🏆 <b>Group Leaderboard</b>\n\n`;
      if (!rows || !rows.length) body += 'No data yet.';
      else {
        rows.forEach((r, i) => {
          body += `${i + 1}. ${mentionFn({ id: r.id, first_name: r.first_name || r.username || String(r.id) })} — ${fmt(r.balance)} 🍥\n`;
        });
      }
      await send(message.chat.id, {
        text: style(body),
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[{ text: 'Global leaderboard', callback_data: 'lb:global', style: 'primary' }]],
        },
      });
    }
  } else {
    await sendGlobalLeaderboard(message.chat.id);
  }
}

async function sendGlobalLeaderboard(chatId) {
  const rows = await db.all(sql`
    SELECT telegram_id AS id, username, first_name, balance
    FROM users
    ORDER BY balance DESC
    LIMIT 10
  `);
  const tableRows = [['Rank', 'Name', 'Coins']];
  if (rows && rows.length) {
    rows.forEach((r, i) => {
      // Global: plain name; only show @username if set (no forced mention link)
      const display = r.username ? `@${r.username}` : (r.first_name || String(r.id));
      tableRows.push([String(i + 1), display, `${fmt(r.balance)} 🍥`]);
    });
  } else {
    tableRows.push(['—', 'No data yet', '—']);
  }
  const blocks = [
    { type: 'heading', text: '🌍 Global Leaderboard', size: 2 },
    table(tableRows),
  ];
  try {
    await api.sendRichMessage({
      chat_id: chatId,
      rich_message: { blocks },
    });
  } catch (e) {
    let body = `🌍 <b>Global Leaderboard</b>\n\n`;
    if (!rows || !rows.length) body += 'No data yet.';
    else {
      rows.forEach((r, i) => {
        const label = r.username ? `@${r.username}` : (r.first_name || r.id);
        body += `${i + 1}. ${label} — ${fmt(r.balance)} 🍥\n`;
      });
    }
    await send(chatId, { text: style(body), parse_mode: 'HTML' });
  }
}



async function handleEquip(message, text) {
  const args = text.trim().split(/\s+/).slice(1).join(' ').trim();
  if (!args) {
    await reply(message, 'Usage: /equip &lt;shinobi name&gt;\nExample: /equip Naruto\nMax 3 equipped. Check /inventory');
    return;
  }
  const r = await equipShinobi(message.from.id, args);
  if (r.code === 'not_owned') {
    await reply(message, `You don't own <b>${escapeHtml(args)}</b>. Recruit at /shinobi_store\n\nCheck /inventory`);
    return;
  }
  if (r.code === 'already') {
    await reply(message, `<b>${escapeHtml(args)}</b> is already equipped.\n\nEquipped: ${(r.list || []).map(escapeHtml).join(', ') || 'none'}\nCheck /inventory`);
    return;
  }
  if (r.code === 'full') {
    await reply(message, `Max 3 shinobi equipped.\nCurrently: ${(r.list || []).map(escapeHtml).join(', ')}\nUse /unequip &lt;name&gt; first.\n\nCheck /inventory`);
    return;
  }
  if (!r.ok) {
    await reply(message, `Could not equip. Try /equip Naruto\n\nCheck /inventory`);
    return;
  }
  const shown = (r.list && r.list.find((s) => s.toLowerCase().includes(args.toLowerCase()))) || args;
  await reply(message,
    `✅ <b>${escapeHtml(shown)}</b> equipped!\n` +
    `Active + passive skills apply.\n` +
    `Equipped (${r.list.length}/3): ${r.list.map(escapeHtml).join(', ')}\n\n` +
    `Check /inventory`);
}

async function handleUnequip(message, text) {
  const args = text.trim().split(/\s+/).slice(1).join(' ').trim();
  if (!args) {
    await reply(message, 'Usage: /unequip &lt;shinobi name&gt;\nExample: /unequip Sasuke\n\nCheck /inventory');
    return;
  }
  const r = await unequipShinobi(message.from.id, args);
  if (r.code === 'not_equipped') {
    await reply(message, `<b>${escapeHtml(args)}</b> is not equipped.\n\nCheck /inventory`);
    return;
  }
  if (!r.ok) {
    await reply(message, `Could not unequip.\n\nCheck /inventory`);
    return;
  }
  const list = r.list || [];
  await reply(message,
    `✅ <b>${escapeHtml(args)}</b> unequipped.\n` +
    (list.length
      ? `Still equipped (${list.length}/3): ${list.map(escapeHtml).join(', ')}`
      : 'No shinobi equipped now.') +
    `\n\nCheck /inventory`);
}

export { sendGlobalLeaderboard };
