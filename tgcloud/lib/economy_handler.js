import { sweepTsunadeSearches } from "./rpg/tsunade.js";
import { sweepProtectionReminders } from "./rpg/protect_reminder.js";
import { handleRedeemCoupon } from "./coupons.js";
import { sweepClaimReminders, CLAIM_GROUP_BUTTON } from './claim_reminder.js';
// Economy commands + store/level-up buttons, restored from the old handlers.
// /start /help /claim /balance /inventory /shinobi_store /buy /mission /patrol /ability /addcoins /backup
import { runBackup, runFullBackup } from "./backup.js";
import { BotApiError, db } from 'sdk';
import { sql } from 'sdk/db';
import { api } from './message_api.js';
import {
  claimDaily, todayKey, DAILY_XP, DAILY_COINS, DAILY_CHAKRA, BONUS_COINS, BONUS_CHAKRA,
  SAKURA_COINS, SAKURA_CHAKRA, getBalance, adjustBalance,
} from './economy.js';
import { render, style, escapeHtml, COIN, mention as mentionFn } from './texts.js';
import { SCREENS, screenText, screenKeyboard, findItem, fmt, JUTSU } from './store.js';
import { handleBuy } from './buy.js';
import { purchase } from './purchase.js';
import { ownedSet, getEquipped, setEquipped, equipShinobi, unequipShinobi, getEquippedList } from './rpg/state.js';
import { sendInventory } from './inventory.js';
import { addCoins, OWNER_ID } from './admin.js';
import { runActivity, sweepActivities } from './activities.js';
import { grantStarter, STARTER_NOTICE } from './starter.js';
import { balanceText, trackGroup } from './balance.js';
import { abilityText, abilityKeyboard, backKeyboard, abilityCheckKeyboard } from './ability.js';
import { levelsText, levelsContent } from './levels.js';
import { economyLocked, ECO_LOCKED_TEXT } from './groupadmin.js';
import { richOr, editRichOr, storeContent, abilityContent, groupOnlyContent, table } from './rich.js';
import { helpText, helpKeyboard } from './help.js';
import { profileText } from './profile.js';
import { sendWelcome, buildUserHelpBlocks } from './welcome_ui.js';
import {
  handleKill, handleRob, handleProtect, handleByakugan,
  handleCloneCallback, isCloneCallback, handleByakuganCallback, isByakuganCallback,
  sweepClones,
} from '../lib/rpg/combat.js';
import { handleSearchTsuna } from '../lib/rpg/tsunade.js';
import { send, sendRich, sweepMessages, trackUser } from './chat.js';
import { groupChatLink } from './telegram_links.js';
import { handlePetCommand } from './pet/ui.js';
import { PETS } from './pet/defs.js';
import { equipPet } from './pet/store.js';
import { equipSuccessText, notOwnedText } from './pet/text.js';

import { MINI_APP_URL, BOT_USERNAME } from './config.js';

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
  if (r.petBonus) {
    s += `\n\n🦋 𝐀𝐗𝐎𝐅𝐋𝐘 𝐅𝐋𝐔𝐓𝐓𝐄𝐑 𝐅𝐎𝐑𝐓𝐔𝐍𝐄\n+${fmt(r.petBonus)} ${COIN}`;
  }
  s += `\n\nStreak: ${r.streak}/7  ${bar}\nBalance: ${fmt(r.balance)} 🍥`;
  if (r.chakraFailed) s += `\n\n⚠️ Chakra couldn't be added. Contact the owner.`;
  return s;
}

// Finished missions/patrols: group reminder + short DM + claim button.
async function announceDone(chat = null, skipClaimIds = []) {
  try { await sweepTsunadeSearches(); } catch (e) { console.error(e); }
  // Private "shield expires soon" DM — timers never appear in group messages.
  try { await sweepProtectionReminders(); } catch (e) { console.error(e); }
  // "You haven't claimed today" mention for this group (once per user per day).
  if (chat) {
    try { await sweepClaimReminders(chat, undefined, { skip: skipClaimIds }); } catch (e) { console.error(e); }
  }
  for (const r of await sweepActivities()) {
    const who = { id: r.id, first_name: r.name };
    const claimKb = {
      inline_keyboard: [[{
        // Group card: one rich button straight into the Hokage Office claim.
        text: r.kind === 'pet' ? '🐾 Open Pets' : 'claim 🍥 reward',
        // Pet completions open the latest /pet card (not the retired menu).
        callback_data: r.kind === 'pet' ? `pet_me:${r.id}` : `map_loc_hokage:${r.id}`,
        style: 'success',
      }]],
    };
    if (r.chatId && r.chatId < 0) {
      try {
        await send(r.chatId, {
          text: render(who, r.reminder),
          parse_mode: 'HTML',
          reply_markup: claimKb,
          disable_reply_target: true,
        });
      } catch (e) { console.error(e); }
    }
    try {
      await send(r.id, {
        text: render(who, r.dm),
        parse_mode: 'HTML',
        reply_markup: claimKb,
        disable_reply_target: true,
      });
    } catch (e) { /* user never started the bot in DM */ }
  }
}

// ---- /claim · /daily ----
// Claiming happens in the Mini App only. The bot DM gets the Mini App button;
// groups are told to move to the DM (the old text promised a Mini App that the
// group button could not open); already-claimed users get the short notice.
export const CLAIM_DM_TEXT = '❄️ ᴏᴘᴇɴ ᴛʜᴇ ᴍɪɴɪ ᴀᴘᴘ ᴛᴏ ᴄʟᴀɪᴍ ʏᴏᴜʀ ᴅᴀɪʟʏ ʀᴇᴡᴀʀᴅ!';
export const CLAIM_ALREADY_TEXT = '❄️ ʏᴏᴜ’ᴠᴇ ᴀʟʀᴇᴀᴅʏ ᴄʟᴀɪᴍᴇᴅ ʏᴏᴜʀ ʀᴇᴡᴀʀᴅ ᴛᴏᴅᴀʏ!\n\n✨ ᴄᴏᴍᴇ ʙᴀᴄᴋ ᴛᴏᴍᴏʀʀᴏᴡ ꜰᴏʀ ᴍᴏʀᴇ!';
export const CLAIM_GROUP_TEXT = {
  claim: "❄️ ᴘʟᴇᴀꜱᴇ ᴜꜱᴇ /claim ɪɴ ᴛʜᴇ ʙᴏᴛ'ꜱ ᴅᴍ ᴛᴏ ᴄʟᴀɪᴍ ʏᴏᴜʀ ᴅᴀɪʟʏ ʀᴇᴡᴀʀᴅꜱ!",
  daily: "❄️ ᴘʟᴇᴀꜱᴇ ᴜꜱᴇ /daily ɪɴ ᴛʜᴇ ʙᴏᴛ'ꜱ ᴅᴍ ᴛᴏ ᴄʟᴀɪᴍ ʏᴏᴜʀ ᴅᴀɪʟʏ ʀᴇᴡᴀʀᴅꜱ!",
};

/** `last_claim_date` is stamped by the Mini App claim (IST day key). */
async function claimedToday(telegramId) {
  const row = await db.get(sql`
    SELECT last_claim_date AS d FROM users WHERE telegram_id = ${telegramId}
  `);
  return !!row && row.d === todayKey();
}

async function replyClaimPrompt(message, cmd) {
  if (await claimedToday(message.from.id)) {
    await reply(message, CLAIM_ALREADY_TEXT);
    return;
  }
  if (message.chat.type === 'private') {
    await reply(message, CLAIM_DM_TEXT, {
      reply_markup: { inline_keyboard: [[{ text: '🎁 Claim', web_app: { url: MINI_APP_URL } }]] },
    });
    return;
  }
  await reply(message, CLAIM_GROUP_TEXT[cmd] || CLAIM_GROUP_TEXT.claim, {
    reply_markup: { inline_keyboard: [[{ ...CLAIM_GROUP_BUTTON }]] },
  });
}

// Everything that touches coins, shinobi, inventory or rewards. /start and /help stay open.
const ECONOMY_CMDS = new Set([
  'balance', 'inventory', 'profile', 'claim', 'daily', 'shinobi_store', 'buy',
  'mission', 'patrol', 'map', 'ability', 'abilities', 'addcoins',
  'kill', 'rob', 'protect', 'byakugan', 'mt', 'gift', 'gift_store',
  'search_tsuna', 'transfer', 'leaderboard', 'lb',
  'equip', 'unequip', 'redeem', 'pet', 'pet_store', 'pet_rename',
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
  // A member typing /claim right now gets no reminder double-tap.
  const claimingNow = /^\/(?:claim|daily)(?:@\w+)?(?:\s|$)/i.test(String(message.text || ''))
    ? [message.from?.id]
    : [];
  try { await announceDone(message.chat, claimingNow); } catch (e) { console.error(e); }
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
    if (starterNew) await reply(message, STARTER_NOTICE(user));

    if (cmd === 'start') {
      await sendWelcome(message.chat.id, user);
      return;
    } else if (cmd === 'help') {
      try {
        const blocks = await buildUserHelpBlocks(user);
        await api.sendRichMessage({
          chat_id: message.chat.id,
          rich_message: { blocks, skip_entity_detection: false },
        });
      } catch (e) {
        console.error('help rich failed:', e?.description || e);
        await reply(message, helpText(user), { reply_markup: helpKeyboard() });
      }
    } else if (
      cmd === 'pet' || cmd === 'pet_store' || cmd === 'pet_rename'
    ) {
      await handlePetCommand(message);
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
          reply(message, cmd === 'mission'
            ? '𝐆𝐑𝐎𝐔𝐏 𝐂𝐎𝐌𝐌𝐀𝐍𝐃 🏘️\n\n⚠️ /mission &lt;shinobi name&gt; ᴡᴏʀᴋꜱ ɪɴ ɢʀᴏᴜᴘꜱ ᴏɴʟʏ.\n\n» ᴜꜱᴇ ɪᴛ ɪɴ ᴀ ɢʀᴏᴜᴘ ᴡʜᴇʀᴇ ɪ ᴀᴍ ᴀ ᴍᴇᴍʙᴇʀ! ❄️'
            : '𝐆𝐑𝐎𝐔𝐏 𝐂𝐎𝐌𝐌𝐀𝐍𝐃\n\n/patrol ᴡᴏʀᴋꜱ ɪɴ ɢʀᴏᴜᴘꜱ ᴏɴʟʏ.\n\n» ᴜꜱᴇ ɪᴛ ɪɴ ᴀ ɢʀᴏᴜᴘ ᴡʜᴇʀᴇ ɪ ᴀᴍ ᴀ ᴍᴇᴍʙᴇʀ..'));
      } else {
        const arg = text.trim().split(/\s+/).slice(1).join(' ');
        const r = await runActivity(user, cmd, arg || null, message.chat.id);
        // A settled return is claimable straight from this reply.
        const claimKb = r.settled
          ? { inline_keyboard: [[{ text: 'claim 🍥 reward', callback_data: `map_loc_hokage:${user.id}`, style: 'success' }]] }
          : undefined;
        await send(message.chat.id, {
          text: style(r.body),
          parse_mode: 'HTML',
          reply_parameters: { message_id: message.message_id },
          ...(claimKb ? { reply_markup: claimKb } : {}),
        });
        for (const d of r.dms) {
          try {
            await send(user.id, {
              text: render(user, d),
              parse_mode: 'HTML',
              reply_markup: {
                inline_keyboard: [[{
                  text: 'claim 🍥 reward',
                  callback_data: `map_loc_hokage:${user.id}`,
                  style: 'success',
                }]],
              },
            });
          } catch (e) { /* user never started the bot in DM */ }
        }
      }
    } else if (cmd === 'buy') {
      const out = await handleBuy(user, text, ctx?.update?.update_id);
      if (out) {
        // Shinobi / pet purchases carry `Check ❄️ ability` for that exact item.
        const body = typeof out === 'string' ? out : out.text;
        const abilityKb = typeof out === 'object' ? abilityCheckKeyboard(out.ability) : undefined;
        await reply(message, body, {
          reply_parameters: { message_id: message.message_id },
          ...(abilityKb ? { reply_markup: abilityKb } : {}),
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
      const out = await handleSearchTsuna(message);
      const replyTo = { message_id: message.message_id };
      if (out && typeof out === 'object' && Array.isArray(out.blocks)) {
        // Heading outside, rich divider, the timer lines quoted.
        try {
          await sendRich(message.chat.id, {
            rich_message: { blocks: out.blocks, skip_entity_detection: false },
            reply_parameters: replyTo,
          });
        } catch (e) {
          console.error('search rich failed:', e?.description || e);
          await send(message.chat.id, {
            text: style(out.text || ''),
            parse_mode: 'HTML',
            reply_parameters: replyTo,
          });
        }
      } else {
        await send(message.chat.id, {
          text: style(String(out)),
          parse_mode: 'HTML',
          reply_parameters: replyTo,
        });
      }
    } else if (cmd === 'claim' || cmd === 'daily') {
      await replyClaimPrompt(message, cmd);
    } else if (cmd === 'balance') {
      // Classic HTML keeps the <blockquote> stats and the tg:// mention intact.
      await send(message.chat.id, {
        text: style(await balanceText(message)),
        parse_mode: 'HTML',
        classic: true,
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
  const options = { includeMiniApp: msg.chat.type === 'private' };
  return editRichOr(msg, user, await storeContent(screen, user.id, options), async () => {
    const balance = screen === 'main' ? await getBalance(user.id) : null;
    return classicEdit(msg, render(user, screenText(screen, balance)), screenKeyboard(screen, user.id, options));
  });
}

export async function handleEconomyCallback(cb) {
  const answer = (text, show_alert = false) =>
    api.answerCallbackQuery({ callback_query_id: cb.id, ...(text ? { text, show_alert } : {}) });

  const data = String(cb.data || '');
  // Leaderboard switch buttons: edit the tapped board in place (requested).
  if (data === 'lb:global' || data === 'lb:group') {
    await answer();
    const kind = data === 'lb:global' ? 'global' : 'group';
    const chat = cb.message?.chat;
    const isGroup = !!chat && (chat.type === 'group' || chat.type === 'supergroup');
    const options = kind === 'global' && isGroup ? { backToGroup: true } : {};
    try {
      if (kind === 'group' && !isGroup) {
        // A stray group button outside a group: show the personal board.
        await sendGlobalLeaderboard(cb.from.id);
      } else if (chat && cb.message?.message_id) {
        await editLeaderboardScreen(cb, kind, options);
      } else {
        await sendLeaderboardScreen(chat?.id || cb.from.id, kind, options);
      }
    } catch (e) { console.error(`[${data}]`, e); }
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
  // Debit atomically: the balance check and the deduction must be one
  // statement, otherwise two concurrent transfers both pass the read-only
  // check and mint coins (sender pays once, receiver is credited twice).
  const paid = await db.run(sql`
    UPDATE users SET balance = balance - ${amount}
    WHERE telegram_id = ${user.id} AND balance >= ${amount}
  `);
  if (!paid?.rowsAffected) {
    const bal = await getBalance(user.id);
    await reply(message, `Not enough coins. You have ${fmt(bal)} 🍥.`);
    return;
  }
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

const LB_LIMIT = 10;

async function groupLeaderboardRows(chatId) {
  return (await db.all(sql`
    SELECT u.telegram_id AS id, u.username, u.first_name, u.balance
    FROM group_members g
    JOIN users u ON u.telegram_id = g.telegram_id
    WHERE g.chat_id = ${chatId}
    ORDER BY u.balance DESC
    LIMIT ${LB_LIMIT}
  `)) || [];
}

async function globalLeaderboardRows() {
  return (await db.all(sql`
    SELECT telegram_id AS id, username, first_name, balance
    FROM users
    ORDER BY balance DESC
    LIMIT ${LB_LIMIT}
  `)) || [];
}

function leaderboardTableRows(rows) {
  const tableRows = [['Rank', 'Name', 'Coins']];
  if (!rows.length) {
    tableRows.push(['—', 'No data yet', '—']);
    return tableRows;
  }
  rows.forEach((r, i) => {
    // Global rows show @username when set; group rows mention everyone.
    const display = r.username ? `@${r.username}` : (r.first_name || String(r.id));
    tableRows.push([String(i + 1), display, `${fmt(r.balance)} 🍥`]);
  });
  return tableRows;
}

const LB_BUTTONS = {
  global: { text: style('Global leaderboard'), callback_data: 'lb:global', style: 'primary' },
  group: { text: style('Group leaderboard'), callback_data: 'lb:group', style: 'primary' },
};

function leaderboardBlocks(kind, rows, options = {}) {
  const blocks = [
    { type: 'heading', text: kind === 'global' ? '🌍 Global Leaderboard' : '🏆 Group Leaderboard', size: 2 },
    table(leaderboardTableRows(rows)),
  ];
  // A group board always offers the global board; the global board offers the
  // way back only when it was opened from a group.
  const button = kind === 'group' ? LB_BUTTONS.global : (options.backToGroup ? LB_BUTTONS.group : null);
  if (button) blocks.push({ type: 'buttons', align: 'center', buttons: [button] });
  return blocks;
}

function leaderboardHtml(kind, rows) {
  const title = kind === 'global' ? '🌍 <b>Global Leaderboard</b>' : '🏆 <b>Group Leaderboard</b>';
  let body = `${title}\n\n`;
  if (!rows.length) {
    body += 'No data yet.';
  } else {
    rows.forEach((r, i) => {
      // Group names stay clickable in the classic fallback.
      const label = kind === 'group'
        ? mentionFn({ id: r.id, first_name: r.first_name || r.username || String(r.id) })
        : (r.username ? `@${r.username}` : (r.first_name || r.id));
      body += `${i + 1}. ${label} — ${fmt(r.balance)} 🍥\n`;
    });
  }
  return style(body);
}

function leaderboardKeyboard(kind, options = {}) {
  const button = kind === 'group' ? LB_BUTTONS.global : (options.backToGroup ? LB_BUTTONS.group : null);
  return button ? { inline_keyboard: [[button]] } : undefined;
}

async function sendLeaderboardScreen(chatId, kind, options = {}) {
  const rows = kind === 'global' ? await globalLeaderboardRows() : await groupLeaderboardRows(chatId);
  try {
    await api.sendRichMessage({
      chat_id: chatId,
      rich_message: { blocks: leaderboardBlocks(kind, rows, options), skip_entity_detection: false },
    });
  } catch (e) {
    const keyboard = leaderboardKeyboard(kind, options);
    await send(chatId, {
      text: leaderboardHtml(kind, rows),
      parse_mode: 'HTML',
      ...(keyboard ? { reply_markup: keyboard } : {}),
    });
  }
}

/** Edit the tapped board in place — /lb never sends a second message. */
async function editLeaderboardScreen(cb, kind, options = {}) {
  const msg = cb.message;
  const rows = kind === 'global' ? await globalLeaderboardRows() : await groupLeaderboardRows(msg.chat.id);
  try {
    await api.editMessageText({
      chat_id: msg.chat.id,
      message_id: msg.message_id,
      rich_message: { blocks: leaderboardBlocks(kind, rows, options) },
    });
  } catch (e) {
    if (!(e instanceof BotApiError)) throw e;
    if (/not modified/i.test(String(e.description || ''))) return;
    await classicEdit(msg, leaderboardHtml(kind, rows), leaderboardKeyboard(kind, options));
  }
}

async function handleLeaderboard(message) {
  const chat = message.chat;
  const isGroup = chat.type === 'group' || chat.type === 'supergroup';
  if (isGroup) await sendLeaderboardScreen(chat.id, 'group');
  else await sendGlobalLeaderboard(chat.id);
}

async function sendGlobalLeaderboard(chatId, options = {}) {
  await sendLeaderboardScreen(chatId, 'global', options);
}


// `Check ❄️ ability` for the item a reply is about (nothing for jutsu/chakra).
function abilityExtra(name) {
  const keyboard = abilityCheckKeyboard(name);
  return keyboard ? { reply_markup: keyboard } : {};
}

export async function handleEquip(message, text) {
  const args = text.trim().split(/\s+/).slice(1).join(' ').trim();
  if (!args) {
    await reply(message, 'ᴜsᴀɢᴇ: /equip &lt;pet or shinobi name&gt;\nᴇxᴀᴍᴘʟᴇ: /equip Naruto · /equip Axofly\nꜱʜɪɴᴏʙɪ: ᴍᴀx 3 ᴇǫᴜɪᴘᴘᴇᴅ. ᴄʜᴇᴄᴋ /inventory');
    return;
  }
  // Jutsu are passive: buying one unlocks the skill, nothing is equipped. The
  // shinobi "you don't own it" card was misleading right after a purchase.
  const jutsuKey = args.toLowerCase().replace(/\s+/g, ' ').trim();
  const jutsu = JUTSU.find((j) => {
    const name = j.name.toLowerCase();
    // "Mind Transmission Jutsu" also answers to "mind transmission".
    return name === jutsuKey || name.replace(/\s*jutsu$/, '') === jutsuKey.replace(/\s*jutsu$/, '');
  });
  if (jutsu) {
    let owned = false;
    try {
      const row = await db.get(sql`
        SELECT qty FROM inventory WHERE telegram_id = ${message.from.id} AND item_name = ${jutsu.name}
      `);
      owned = !!row && Number(row.qty) > 0;
    } catch (_) { /* treat as not owned */ }
    await reply(message, owned
      ? `🧠 <b>${escapeHtml(jutsu.name)}</b> is already unlocked — jutsu are always active and never equipped.\n\n» In a group, reply to a member with <code>/mt your message</code>.\n\nCheck /inventory`
      : `🔒 You don't own <b>${escapeHtml(jutsu.name)}</b> yet.\n\n» Unlock it with <code>/buy ${escapeHtml(jutsu.name)}</code>, then reply in a group with <code>/mt your message</code>.`);
    return;
  }
  // Pets and shinobi share /equip; the pet catalogue is checked first.
  const petDef = Object.values(PETS).find(
    (p) => p.id === args.toLowerCase() || p.name.toLowerCase() === args.toLowerCase(),
  );
  if (petDef) {
    const r = await equipPet(message.from.id, petDef.id);
    if (r.code === 'ok' || r.code === 'already_equipped') {
      await reply(message, equipSuccessText(petDef.name), abilityExtra(petDef.name));
    } else {
      await reply(message, notOwnedText(petDef.name));
    }
    return;
  }
  const r = await equipShinobi(message.from.id, args);
  if (r.code === 'not_owned') {
    await reply(message, `You don't own <b>${escapeHtml(args)}</b>. Recruit at /shinobi_store\n\nCheck /inventory`);
    return;
  }
  if (r.code === 'already') {
    await reply(message, `<b>${escapeHtml(args)}</b> is already equipped.\n\nEquipped: ${(r.list || []).map(escapeHtml).join(', ') || 'none'}\nCheck /inventory`, abilityExtra(args));
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
    `Check /inventory`, abilityExtra(shown));
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
