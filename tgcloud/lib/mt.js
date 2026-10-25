import { db } from 'sdk';
import { api } from './message_api.js';
import { sql } from 'sdk/db';
import { COMMANDS } from './command_registry.js';
import { style } from './texts.js';

const MAX_LEN = 1000;

// Group command menu + ephemeral registration (Bot API 10.2+: BotCommand.is_ephemeral).
const SCOPE = { type: 'all_group_chats' };
const MAX_COMMANDS = 100; // Telegram's own limit for setMyCommands
const VERIFY_TTL_MS = 60_000; // re-check a verified menu at most once a minute per isolate
const RETRY_TTL_MS = 60_000; // retry a failed registration at most once a minute
const MT_COMMAND = 'mt';

// Per-isolate state. There is no scheduler in the serverless runtime, so every
// /mt (or the my_chat_member hook) is a chance to verify/repair the menu.
const state = { verifiedAt: 0, failedAt: 0, botId: 0 };

/** Test hook: forget the registration/admin cache of this isolate. */
export function resetMtRegistrationState() {
  state.verifiedAt = 0;
  state.failedAt = 0;
  state.botId = 0;
}

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const mentionHtml = (u) => {
  if (!u?.id) return 'User';
  return `<a href="tg://user?id=${u.id}">${esc(u.first_name || 'User')}</a>`;
};

/** One-line, content-free error description for logs and failure cards. */
const describeError = (e) => {
  const code = e?.code ? `[${e.code}] ` : '';
  return `${code}${e?.description || e?.message || 'unknown error'}`;
};

/**
 * The group menu this code base wants: every visible user command, /mt ephemeral.
 * Descriptions are pre-styled: message_api's styleOutgoingPayload applies the
 * small-caps style on the way out, so the live list reads back styled and an
 * unstyled comparison would rewrite the menu on every verification.
 */
function buildCommandList() {
  const list = [];
  for (const entry of COMMANDS) {
    if (entry.access !== 'user' || entry.hidden) continue;
    const name = String(entry.cmd || '').replace(/^\//, '').toLowerCase();
    if (!/^[a-z0-9_]{1,32}$/.test(name) || list.length >= MAX_COMMANDS) continue;
    const command = { command: name, description: style(String(entry.desc || '').slice(0, 256)) };
    if (name === MT_COMMAND) command.is_ephemeral = true;
    list.push(command);
  }
  return list;
}

/**
 * Sanitize a getMyCommands result. Returns null for a missing/malformed list
 * (unknown state — do not treat it as "no commands"), and [] for a valid empty
 * list. Both a bare array and `{ commands: [...] }` are accepted.
 */
function normalizeCommands(value) {
  const list = Array.isArray(value) ? value : Array.isArray(value?.commands) ? value.commands : null;
  if (!list) return null;
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const name = String(raw.command ?? '').replace(/^\//, '').trim().toLowerCase();
    if (!/^[a-z0-9_]{1,32}$/.test(name) || seen.has(name)) continue;
    seen.add(name);
    const entry = { command: name, description: String(raw.description ?? '').slice(0, 256) };
    if (raw.is_ephemeral === true) entry.is_ephemeral = true;
    out.push(entry);
  }
  return out;
}

/**
 * Merge the live menu with the desired one: commands this code base does not
 * own are kept exactly as they are, known commands get the current description
 * and /mt always carries is_ephemeral.
 */
function mergeCommands(existing, desired) {
  const wanted = new Map(desired.map((c) => [c.command, c]));
  const merged = [];
  const seen = new Set();
  for (const entry of existing) {
    if (seen.has(entry.command) || merged.length >= MAX_COMMANDS) continue;
    const ours = wanted.get(entry.command);
    // `...entry` first so an outer/legacy entry keeps its own fields; ours wins
    // for command/description and adds is_ephemeral to /mt.
    merged.push(ours ? { ...entry, ...ours } : entry);
    seen.add(entry.command);
  }
  for (const entry of desired) {
    if (seen.has(entry.command) || merged.length >= MAX_COMMANDS) continue;
    merged.push(entry);
    seen.add(entry.command);
  }
  return merged;
}

/** True when /mt is ephemeral and every expected command is present as described. */
function registrationIsCurrent(existing, desired) {
  const current = new Map(existing.map((c) => [c.command, c]));
  const mt = current.get(MT_COMMAND);
  if (!mt || mt.is_ephemeral !== true) return false;
  return desired.every((want) => {
    const have = current.get(want.command);
    return Boolean(have) && have.description === want.description;
  });
}

/** Live group menu, or null when the platform cannot tell us. */
async function readGroupCommands() {
  if (typeof api.getMyCommands !== 'function') return null;
  try {
    return normalizeCommands(await api.getMyCommands({ scope: SCOPE }));
  } catch (e) {
    console.error('[mt menu] getMyCommands failed:', describeError(e));
    return null;
  }
}

async function writeGroupCommands(commands) {
  try {
    await api.setMyCommands({ scope: SCOPE, commands });
    return true;
  } catch (e) {
    console.error('[mt menu] setMyCommands failed:', describeError(e));
    return false;
  }
}

/**
 * Register /mt as an ephemeral group command so Telegram hides the command and
 * its text from the rest of the group (Bot API 10.2+).
 *
 * `setMyCommands` replaces the whole scope, so the live list is read first and
 * merged: unrelated entries are preserved, only /mt gains `is_ephemeral`.
 * The per-isolate cache is refreshed at most once a minute, so a menu whose flag
 * was lost is repaired instead of being suppressed forever by a warm flag.
 * Returns true when the ephemeral entry is known to be in place.
 */
export async function ensureMtEphemeralCommand({ force = false } = {}) {
  const now = Date.now();
  if (!force) {
    if (state.verifiedAt && now - state.verifiedAt < VERIFY_TTL_MS) return true;
    if (!state.verifiedAt && state.failedAt && now - state.failedAt < RETRY_TTL_MS) return false;
  }

  const desired = buildCommandList();
  const existing = await readGroupCommands();

  if (existing && registrationIsCurrent(existing, desired)) {
    state.verifiedAt = Date.now();
    state.failedAt = 0;
    return true;
  }

  const commands = existing ? mergeCommands(existing, desired) : desired;
  if (await writeGroupCommands(commands)) {
    state.verifiedAt = Date.now();
    state.failedAt = 0;
    return true;
  }

  // The platform refused `is_ephemeral` (Bot API < 10.2). Still keep the group
  // menu usable, but never mark it verified: the next call retries with the flag.
  const withoutFlag = commands.map(({ is_ephemeral, ...rest }) => rest);
  if (await writeGroupCommands(withoutFlag)) {
    console.error('[mt menu] /mt registered without is_ephemeral; will retry.');
  }
  state.failedAt = Date.now();
  return false;
}

/**
 * The jutsu check reads the same inventory rows /inventory shows (raw SQL, no
 * query-builder dependency). A purchased jutsu is item_type 'jutsu' with the
 * name "Mind Transmission Jutsu".
 */
async function hasMtJutsu(userId) {
  try {
    const row = await db.get(sql`
      SELECT qty FROM inventory
      WHERE telegram_id = ${userId} AND item_name LIKE '%Mind Transmission%'
      LIMIT 1
    `);
    if (row && Number(row.qty) > 0) return true;
  } catch (e) {
    console.error('[mt jutsu check]', e?.message || e);
  }
  try {
    const rows = await db.all(sql`
      SELECT item_name FROM inventory WHERE telegram_id = ${userId} AND item_type = 'jutsu'
    `);
    return (rows || []).some((r) => String(r.item_name || '').toLowerCase().includes('mind transmission'));
  } catch (_) {
    return false;
  }
}

/**
 * Only an incoming ephemeral message may trigger another ephemeral message
 * (`reply_parameters.ephemeral_message_id`, valid for 15s). A plain message_id
 * is NOT an eligible trigger — sending with it makes Telegram reject the call.
 */
function ephemeralTrigger(message) {
  const ephemeralId = Number(message?.ephemeral_message_id || 0);
  return ephemeralId > 0 ? { ephemeral_message_id: ephemeralId } : null;
}

async function botUserId() {
  if (state.botId) return state.botId;
  try {
    const me = await api.getMe();
    if (me?.id) state.botId = Number(me.id);
    return state.botId || 0;
  } catch (e) {
    console.error('[mt me]', describeError(e));
    return 0;
  }
}

/**
 * A chat administrator may send an ephemeral message to any non-bot member at
 * any time — that is the only route for a receiver who triggered nothing.
 * true / false when known, null when it cannot be checked.
 */
async function botAdminStatus(chatId) {
  const botId = await botUserId();
  if (!botId || typeof api.getChatMember !== 'function') return null;
  try {
    const member = await api.getChatMember({ chat_id: chatId, user_id: botId });
    const status = String(member?.status || '');
    return status === 'administrator' || status === 'creator';
  } catch (e) {
    console.error('[mt admin check]', describeError(e));
    return null;
  }
}

async function sendEphemeral(chatId, receiverUserId, text, trigger) {
  // receiver_user_id must be a JSON number (Bot API 10.3 shape inside
  // ephemeral_message_parameters); the wrapper forwards this object verbatim.
  const base = {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    ephemeral_message_parameters: { receiver_user_id: Number(receiverUserId) },
  };
  if (!trigger) return api.sendMessage(base);
  try {
    return await api.sendMessage({ ...base, reply_parameters: trigger });
  } catch (e) {
    // Some API builds refuse the reply target on an ephemeral send; deliver it
    // without the quoted trigger instead of dropping the message.
    console.error('[mt ephemeral retry]', describeError(e));
    return api.sendMessage(base);
  }
}

/**
 * Best-effort: hide the invoking /mt command from the group timeline.
 * Deletion is only a fallback — without the delete-message right (or when
 * Telegram refuses) the command stays visible; the transmission still runs.
 */
async function hideCommandMessage(message) {
  // Already ephemeral: Telegram never showed it to the group, nothing to delete.
  if (Number(message?.ephemeral_message_id || 0) > 0) return false;
  const chatId = message?.chat?.id;
  const messageId = message?.message_id;
  // Only ever the invoking command — never the recipient's message.
  if (!chatId || !messageId) return false;
  try {
    await api.deleteMessage({ chat_id: chatId, message_id: messageId });
    return true;
  } catch (e) {
    console.error('[mt hide] deleteMessage failed:', describeError(e), `chat=${chatId}`, `message=${messageId}`);
    return false;
  }
}

export async function handleMtCommand(message) {
  const text = message.text || '';
  if (!text.startsWith('/')) return false;
  const head = text.split(/\s+/)[0];
  const [rawCmd, atTarget] = head.slice(1).split('@');
  if (rawCmd.toLowerCase() !== 'mt') return false;

  if (atTarget) {
    try {
      const me = await api.getMe();
      if (atTarget.toLowerCase() !== String(me.username || '').toLowerCase()) return true;
    } catch (_) {}
  }

  const from = message.from;
  if (!from || from.is_bot) return true;

  const chat = message.chat;
  const isGroup = chat.type === 'group' || chat.type === 'supergroup';
  const payload = text.replace(/^\/mt(@\w+)?\s*/i, '').trim();
  const commandMessageId = message.message_id || null;

  // Hide the invoking command first: no point waiting for DB/API work while the
  // whole group can read a private transmission request.
  if (isGroup) await hideCommandMessage(message);

  // Register or repair the ephemeral /mt entry (cheap, cached per isolate).
  await ensureMtEphemeralCommand();

  // Ephemeral delivery needs an eligible trigger, or bot-admin rights in the
  // chat. `null` means "cannot tell" — try ephemeral rather than skipping it.
  const trigger = ephemeralTrigger(message);
  const canEphemeral = Boolean(trigger) || (await botAdminStatus(chat.id)) !== false;

  // Answers go to the sender only. Ephemeral first; the bot's DM is the private
  // fallback so a refused ephemeral send never leaves the player without a reply.
  const tellSender = async (html) => {
    if (!isGroup) {
      try {
        await api.sendMessage({ chat_id: from.id, text: html, parse_mode: 'HTML' });
      } catch (e) {
        console.error('[mt dm ack]', describeError(e));
      }
      return;
    }
    if (canEphemeral) {
      try {
        await sendEphemeral(chat.id, from.id, html, trigger);
        return;
      } catch (e) {
        console.error('[mt ack ephemeral]', describeError(e));
      }
    }
    try {
      await api.sendMessage({ chat_id: from.id, text: html, parse_mode: 'HTML' });
      return;
    } catch (e) {
      console.error('[mt ack dm]', describeError(e));
    }
    // Last resort: a short status in the group beats a silent command. Only the
    // status text is public — the transmitted body never is.
    try {
      const fallback = { chat_id: chat.id, text: html, parse_mode: 'HTML' };
      if (commandMessageId) {
        fallback.reply_parameters = { message_id: commandMessageId, allow_sending_without_reply: true };
      }
      await api.sendMessage(fallback);
    } catch (e) {
      console.error('[mt ack public]', describeError(e));
    }
  };

  if (!isGroup) {
    await tellSender(
      `${mentionHtml(from)}\n\n⚠️ <b>GROUP ONLY</b>\n\n/mt works inside a group — reply to the receiver’s message.`,
    );
    return true;
  }

  if (!(await hasMtJutsu(from.id))) {
    await tellSender(
      `${mentionHtml(from)}\n\n🔒 <b>JUTSU NOT UNLOCKED</b>\n\nYou need Mind Transmission Jutsu 🧠 to use /mt.\n\nUnlock it with /buy Mind Transmission Jutsu (or /shinobi_store → Jutsu).`,
    );
    return true;
  }

  const rt = message.reply_to_message;
  if (!rt?.from) {
    await tellSender(
      `${mentionHtml(from)}\n\n⚠️ <b>REPLY REQUIRED</b>\n\nReply to the intended receiver’s message to use /mt.`,
    );
    return true;
  }
  if (rt.from.is_bot) {
    await tellSender(
      `${mentionHtml(from)}\n\n⚠️ <b>INVALID TARGET</b>\n\nYou cannot transmit a message to a bot.`,
    );
    return true;
  }
  if (rt.from.id === from.id) {
    await tellSender(
      `${mentionHtml(from)}\n\n⚠️ <b>INVALID TARGET</b>\n\nYou cannot transmit a message to yourself.`,
    );
    return true;
  }
  if (!payload) {
    await tellSender(
      `${mentionHtml(from)}\n\n⚠️ <b>MESSAGE REQUIRED</b>\n\nAdd the text you want to transmit after /mt.`,
    );
    return true;
  }
  if (payload.length > MAX_LEN) {
    await tellSender(
      `${mentionHtml(from)}\n\n⚠️ Message too long (max ${MAX_LEN} characters).`,
    );
    return true;
  }

  const recipient = rt.from;
  const body =
    `${mentionHtml(recipient)}\n\n` +
    `🧠 <b>MIND TRANSMISSION</b>\n\n` +
    `Message from: ${mentionHtml(from)}\n\n` +
    `───────────────\n\n` +
    `${esc(payload)}`;

  // Deliver privately. The acknowledgement below is only a success when one of
  // these routes actually resolved — a rejected ephemeral send is not success.
  let route = null;
  let failure = null;
  if (canEphemeral) {
    try {
      await sendEphemeral(chat.id, recipient.id, body, trigger);
      route = 'ephemeral';
    } catch (e) {
      failure = describeError(e);
      console.error('[mt ephemeral]', failure);
    }
  }
  if (!route) {
    // Ephemeral delivery is never guaranteed (the receiver may be offline, or
    // the bot may not be an admin). The bot's DM is private as well, so the
    // jutsu still works instead of failing silently.
    try {
      await api.sendMessage({ chat_id: recipient.id, text: body, parse_mode: 'HTML' });
      route = 'dm';
    } catch (e) {
      failure = describeError(e);
      console.error('[mt dm]', failure);
    }
  }

  if (!route) {
    await tellSender(
      `${mentionHtml(from)}\n\n❌ <b>TRANSMISSION FAILED</b>\n\nThe message could not be delivered privately.\n\n<code>${esc(String(failure).slice(0, 200))}</code>`,
    );
    return true;
  }

  await tellSender(
    `${mentionHtml(from)}\n\n✅ <b>MIND TRANSMISSION SENT</b>\n\nTarget: ${mentionHtml(recipient)}\n\n` +
    (route === 'dm'
      ? 'Your message was delivered to their bot DM instead (ephemeral delivery was unavailable).'
      : 'Your ephemeral message was delivered inside the group.'),
  );
  return true;
}
