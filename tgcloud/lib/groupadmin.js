// MissFrozen: /eco for live Telegram group admins + owner. No /imfrozen.
import { db, BotApiError } from 'sdk';
import { api } from './message_api.js';
import { eq, and, lt } from 'sdk/db';
import { groupSettings as GS } from '../schema.js';
import { OWNER_ID } from './config.js';

// ---------- constants ----------
export const ECO_LOCKED_TEXT = 'All economy commands are locked for this group.';
const GROUP_TYPES = ['group', 'supergroup'];

// ---------- rich helpers (same block shapes as topic.js / compose.js) ----------
const bold = (text) => ({ type: 'bold', text });
const para = (...t) => ({ type: 'paragraph', text: t.length === 1 ? t[0] : t });
const head = (text) => ({ type: 'heading', text, size: 2 });
const row = (...buttons) => ({ type: 'buttons', buttons, align: 'center' });
const rich = (blocks) => ({ blocks, skip_entity_detection: true });
const nowSec = () => Math.floor(Date.now() / 1000);

export const isGroupChat = (chat) => !!chat && GROUP_TYPES.includes(chat.type);

// Send rich; if Telegram refuses the blocks, fall back to plain text.
async function say(chatId, blocks, plain, extra = {}) {
  try {
    return await api.sendRichMessage({ chat_id: chatId, rich_message: rich(blocks), ...extra });
  } catch (e) {
    if (!(e instanceof BotApiError)) throw e;
    console.error('rich send failed:', e.description);
    return api.sendMessage({ chat_id: chatId, text: plain, ...extra });
  }
}

// Edit the confirmation message in the DM. "Not modified" and similar 400s are ignored.
async function editTo(msg, blocks) {
  if (!msg) return;
  try {
    await api.editMessageText({
      chat_id: msg.chat.id, message_id: msg.message_id, rich_message: rich(blocks),
    });
  } catch (e) {
    if (!(e instanceof BotApiError && e.code === 400)) throw e;
  }
}

let ME = null;
async function me() {
  if (!ME) ME = await api.getMe();
  return ME;
}

// "/cmd@otherbot" is meant for another bot in the group: ignore it.
export async function commandIsForMe(message) {
  const first = String(message.text || '').trim().split(/\s+/)[0];
  const at = first.indexOf('@');
  if (at === -1) return true;
  const target = first.slice(at + 1).toLowerCase();
  return target === String((await me()).username || '').toLowerCase();
}

// ---------- admin checks ----------
// true / false, or null when Telegram could not tell us (bot not in the chat, not admin, ...).
export async function liveAdmin(chatId, userId) {
  try {
    const m = await api.getChatMember({ chat_id: chatId, user_id: userId });
    return m.status === 'creator' || m.status === 'administrator';
  } catch (e) {
    if (e instanceof BotApiError) {
      console.error('getChatMember failed:', chatId, e.description);
      return null;
    }
    throw e;
  }
}

// MissFrozen has NO /imfrozen registration: Telegram group admins (verified
// live via getChatMember) and the bot owner may manage group economy settings.
export async function canManageGroup(chatId, userId) {
  if (userId === OWNER_ID) return true;
  return (await liveAdmin(chatId, userId)) === true;
}

export async function economyLocked(chatId) {
  const s = await db.select().from(GS).where(eq(GS.chatId, chatId)).get();
  return !!s && s.economyEnabled === 0;
}

// Anonymous admins / channel posts have no real user to verify.
const anonymous = (message) => !message.from || message.from.is_bot || !!message.sender_chat;

// ---------- /eco on | off ----------
async function handleEco(message) {
  const chat = message.chat;
  const from = message.from;

  if (!isGroupChat(chat)) {
    await say(chat.id, [para('/eco works in groups only.')], '/eco works in groups only.');
    return;
  }

  const arg = (String(message.text || '').trim().split(/\s+/)[1] || '').toLowerCase();
  if (arg !== 'on' && arg !== 'off') {
    const locked = await economyLocked(chat.id);
    await say(chat.id, [
      head('💰 ECONOMY'),
      para('Status: ', bold(locked ? 'OFF 🔒' : 'ON ✅')),
      para('Group admins: /eco on  ·  /eco off'),
    ], `Economy: ${locked ? 'OFF' : 'ON'}\nGroup admins: /eco on | /eco off`);
    return;
  }

  if (anonymous(message)) {
    await say(chat.id, [para('⚠️ I cannot verify anonymous admins. Turn off "Remain anonymous" and try again.')],
      'I cannot verify anonymous admins. Turn off "Remain anonymous" and try again.');
    return;
  }
  if (!(await canManageGroup(chat.id, from.id))) {
    await say(chat.id, [para('⛔ Only Telegram admins of this group can change this.')],
      'Only Telegram admins of this group can change this.');
    return;
  }

  const enabled = arg === 'on' ? 1 : 0;
  await db.insert(GS)
    .values({ chatId: chat.id, economyEnabled: enabled, updatedBy: from.id, updatedAt: nowSec() })
    .onConflictDoUpdate({
      target: GS.chatId,
      set: { economyEnabled: enabled, updatedBy: from.id, updatedAt: nowSec() },
    }).run();

  if (enabled) {
    await say(chat.id, [para('✅ Economy is ON for this group.')], 'Economy is ON for this group.');
  } else {
    await say(chat.id, [
      para('🔒 Economy is OFF for this group.'),
      para('Balances, inventory and rewards are kept. Use /eco on to bring it back.'),
    ], 'Economy is OFF for this group. Balances, inventory and rewards are kept. Use /eco on to bring it back.');
  }
}

// ---------- command router (message.js hook) ----------
// Returns true when the message was one of our commands.
export async function handleGroupAdminCommand(message) {
  const text = message.text || '';
  if (!text.startsWith('/')) return false;
  const cmd = text.split(/[\s@]/)[0].toLowerCase();
  if (cmd !== '/eco') return false; // MissFrozen does not register /imfrozen (ExFrozen-only)
  if (!(await commandIsForMe(message))) return true; // addressed to another bot: swallow
  await handleEco(message);
  return true;
}

// ---------- callback (callback_query.js hook) ----------
// No /imfrozen confirmations on MissFrozen: nothing to handle here.
export async function handleGroupAdminCallback(_cq) {
  return false;
}
