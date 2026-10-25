/**
 * Quote extraction — turns the replied-to Telegram message into the plain data
 * the renderer needs. No rendering and no API calls here.
 *
 * The source is ALWAYS `reply_to_message`; the command message itself is never
 * quoted (see `isSelfReply`).
 *
 * Sender resolution, in order — never invented:
 *   1. `message.from`            → a normal user. The name shown is `first_name`,
 *                                  exactly what a `{mention}` renders as
 *   2. `message.sender_chat`     → a channel post / anonymous admin posting as
 *                                  the channel; the channel title is the name
 *   3. anonymous group admin     → Telegram's GroupAnonymousBot placeholder;
 *                                  the *group* is the poster, not a fake user
 *   4. nothing usable            → the generic "Unknown" label, still rendered
 *
 * Supported inputs:
 *   - text messages (entities are flattened to plain text)
 *   - photo / video / animation / document / audio / voice with a caption
 *   - stickers (their emoji, else a "Sticker" label)
 * Everything else produces a labelled placeholder ("Voice message", …) rather
 * than pretending it can be turned into pixels.
 */

export const MAX_QUOTE_CHARS = 900;

/** Telegram caps a sticker's author name/username display reasonably. */
const MAX_NAME = 40;

/** Telegram timestamps are unix seconds; the sticker shows a short local time. */
export function formatMessageTime(date) {
  const seconds = Number(date);
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  const iso = new Date(seconds * 1000).toISOString(); // UTC, isolate-safe
  const hours = Number(iso.slice(11, 13));
  const minutes = iso.slice(14, 16);
  const suffix = hours >= 12 ? 'PM' : 'AM';
  const hour12 = hours % 12 === 0 ? 12 : hours % 12;
  return `${hour12}:${minutes} ${suffix}`;
}

/** Telegram's built-in placeholders for anonymous group admins. */
const ANONYMOUS_ADMIN_IDS = new Set([1087968824, 136817688]);
const GENERIC_AUTHOR = 'Unknown';

/**
 * Resolve who wrote the replied-to message.
 * Returns `{ id, name, username, isChannel, anonymous }` — `id` is null when
 * there is nobody to fetch a profile photo for.
 */
export function resolveSender(message, chat = null) {
  const from = message?.from;
  const senderChat = message?.sender_chat;

  // A channel post, or an admin posting "as the channel".
  if (senderChat) {
    const title = String(senderChat.title || senderChat.username || '').trim();
    return {
      id: null, // channel photos come from getChat, not getUserProfilePhotos
      chatId: senderChat.id ?? null,
      name: (title || 'Channel').slice(0, MAX_NAME),
      username: senderChat.username ? `@${senderChat.username}` : '',
      isChannel: true,
      anonymous: false,
    };
  }

  // A real user (never the bot itself — handled by the caller).
  //
  // The display name is `first_name` alone — the same string a `{mention}`
  // renders (`<a href="tg://user?id=…">First</a>`), so the card matches what
  // members see in chat. The @username is kept for diagnostics only and is
  // never drawn.
  if (from && !ANONYMOUS_ADMIN_IDS.has(from.id)) {
    const first = String(from.first_name || '').trim();
    return {
      id: from.id ?? null,
      chatId: null,
      name: (first || String(from.username || '').trim() || GENERIC_AUTHOR).slice(0, MAX_NAME),
      username: from.username ? `@${from.username}` : '',
      isChannel: false,
      anonymous: false,
    };
  }

  // Anonymous admin: the group posted it. Name the group, not a fake person.
  if (from && ANONYMOUS_ADMIN_IDS.has(from.id)) {
    const title = String(chat?.title || '').trim();
    return {
      id: null,
      chatId: chat?.id ?? null,
      name: (title || 'Anonymous admin').slice(0, MAX_NAME),
      username: '',
      isChannel: false,
      anonymous: true,
    };
  }

  return { id: null, chatId: null, name: GENERIC_AUTHOR, username: '', isChannel: false, anonymous: false };
}

const MEDIA_LABELS = {
  photo: 'Photo',
  video: 'Video',
  animation: 'GIF',
  video_note: 'Video message',
  voice: 'Voice message',
  audio: 'Audio',
  document: 'Document',
  sticker: 'Sticker',
  location: 'Location',
  venue: 'Venue',
  contact: 'Contact',
  poll: 'Poll',
  dice: 'Dice',
  game: 'Game',
  invoice: 'Invoice',
  successful_payment: 'Payment',
  story: 'Story',
};

/**
 * Strip Telegram HTML entities down to plain text without re-parsing markup.
 * `parse_mode` is never used on user content — this only flattens the *types*
 * Telegram already resolved, so nothing is executed or interpreted.
 */
export function textOf(entityHolder) {
  const utext = typeof entityHolder?.text === 'string' ? entityHolder.text : '';
  const entities = entityHolder?.entities;
  if (!utext) return '';
  if (!Array.isArray(entities) || !entities.length) return utext;
  let out = '';
  let cursor = 0;
  for (const entity of entities) {
    const start = entity.offset;
    const end = entity.offset + entity.length;
    if (start < cursor || end > utext.length) continue;
    out += utext.slice(cursor, start);
    const inner = utext.slice(start, end);
    if (entity.type === 'text_link' && entity.url) out += inner;
    else if (entity.type === 'mention' || entity.type === 'text_mention') out += inner;
    else if (entity.type === 'custom_emoji') out += '';
    else if (entity.type === 'pre' || entity.type === 'code') out += inner;
    else out += inner;
    cursor = end;
  }
  return out + utext.slice(cursor);
}

/** Which media type (if any) the message carries. */
export function mediaKindOf(message) {
  if (!message) return null;
  for (const key of Object.keys(MEDIA_LABELS)) {
    if (message[key]) return key;
  }
  return null;
}

/**
 * Extract a quote from a replied-to message.
 *
 * @param {object} message  the replied-to message
 * @param {object} [options]
 * @param {object} [options.chat]  the chat the message lives in (anonymous admins)
 * @returns {{
 *   ok: boolean, reason?: string, text: string, name: string, handle: string,
 *   time: string, kind: string, hasMedia: boolean, mediaKind: string|null,
 *   truncated: boolean, senderId: number|null, senderChatId: number|null,
 *   isChannel: boolean, anonymous: boolean
 * }}
 */
export function extractQuote(message, options = {}) {
  if (!message) return { ok: false, reason: 'reply_required' };

  const mediaKind = mediaKindOf(message);
  const raw = mediaKind
    ? textOf({ text: message.caption, entities: message.caption_entities })
    : textOf(message);

  let body = String(raw || '').replace(/\r\n?/g, '\n').trim();
  let kind = '';
  if (!body) {
    if (mediaKind === 'sticker') {
      kind = message.sticker?.emoji ? `${message.sticker.emoji} Sticker` : 'Sticker';
    } else if (mediaKind) {
      kind = MEDIA_LABELS[mediaKind];
    } else {
      // Nothing quotable: no text, no caption, no media (service message, …).
      return { ok: false, reason: 'nothing_to_quote' };
    }
  }

  // Someone must have written it — but a channel, an anonymous admin or a
  // sender-less message is still quotable with an honest label.
  const sender = resolveSender(message, options.chat || message.chat || null);
  if (sender.anonymous === false && !sender.isChannel && sender.name === GENERIC_AUTHOR
    && !message.from && !message.sender_chat) {
    return { ok: false, reason: 'no_author' };
  }

  // Collapse runs of blank lines (a quote card cannot show 400 empty rows).
  body = body.replace(/\n{3,}/g, '\n\n');
  let truncated = false;
  if (body.length > MAX_QUOTE_CHARS) {
    body = `${body.slice(0, MAX_QUOTE_CHARS - 1).trimEnd()}…`;
    truncated = true;
  }

  return {
    ok: true,
    text: body,
    name: sender.name.slice(0, MAX_NAME),
    handle: sender.username.slice(0, MAX_NAME),
    time: formatMessageTime(message.date),
    kind,
    hasMedia: Boolean(mediaKind),
    mediaKind,
    truncated,
    senderId: sender.id,
    senderChatId: sender.chatId,
    isChannel: sender.isChannel,
    anonymous: sender.anonymous,
  };
}

/**
 * Copy the reply target out of a command message, without keeping a reference
 * to the whole update (the caller only needs these fields).
 */
export function quoteSourceOf(message) {
  const target = message?.reply_to_message;
  // A reply always points at a *different* message; never quote the command.
  if (target && message?.message_id != null && target.message_id === message.message_id) return null;
  if (!target) return null;
  return {
    message_id: target.message_id,
    from: target.from,
    sender_chat: target.sender_chat,
    date: target.date,
    chat: target.chat || message.chat, // anonymous admins are named by the group
    text: target.text,
    entities: target.entities,
    caption: target.caption,
    caption_entities: target.caption_entities,
    photo: target.photo,
    video: target.video,
    animation: target.animation,
    document: target.document,
    audio: target.audio,
    voice: target.voice,
    video_note: target.video_note,
    sticker: target.sticker,
    location: target.location,
    venue: target.venue,
    contact: target.contact,
    poll: target.poll,
    dice: target.dice,
    game: target.game,
  };
}
