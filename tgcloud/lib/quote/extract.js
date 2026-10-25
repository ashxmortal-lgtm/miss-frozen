/**
 * Quote extraction — turns the replied-to Telegram message into the plain data
 * the renderer needs. No rendering and no API calls here.
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
 * @returns {{
 *   ok: boolean, reason?: string, text: string, name: string, handle: string,
 *   kind: string, hasMedia: boolean, mediaKind: string|null, truncated: boolean
 * }}
 */
export function extractQuote(message) {
  if (!message) return { ok: false, reason: 'reply_required' };
  const author = message.from;
  if (!author || author.is_bot) {
    return { ok: false, reason: 'no_author' };
  }
  const name = String(author.first_name || author.title || 'Unknown').trim() || 'Unknown';
  const handle = author.username ? `@${author.username}` : '';
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
      return { ok: false, reason: 'nothing_to_quote' };
    }
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
    name: name.slice(0, MAX_NAME),
    handle: handle.slice(0, MAX_NAME),
    time: formatMessageTime(message.date),
    kind,
    hasMedia: Boolean(mediaKind),
    mediaKind,
    truncated,
  };
}

/**
 * Copy the reply target out of a command message, without keeping a reference
 * to the whole update (the caller only needs these fields).
 */
export function quoteSourceOf(message) {
  const target = message?.reply_to_message;
  if (!target) return null;
  return {
    message_id: target.message_id,
    from: target.from,
    date: target.date,
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
