/**
 * `/q` and `/own`.
 *
 *   /q    reply to a message → a Classic QuotLy-style sticker: the author's
 *         profile photo, their display name, and the quoted text inside a dark
 *         rounded bubble with a transparent background. Sent to this chat only;
 *         never creates a pack.
 *   /own  reply to a *sticker* → save that sticker, unchanged, into the caller's
 *         personal sticker pack (created on first use, reused afterwards).
 *
 * Both commands only ever look at the replied-to message, never at the command.
 */

import { api, InputFile } from 'sdk';
import { BOT_USERNAME } from './config.js';
import { escapeHtml } from './texts.js';
import { replyParametersFor } from './reply_target.js';
import { extractQuote, quoteSourceOf } from './quote/extract.js';
import { renderQuotePng } from './quote/render.js';
import { resolveAvatar } from './quote/avatar.js';
import { formatOfSticker, ownSticker, STICKER_LIMITS } from './quote/packs.js';
import { emojiCodepointOf, resolveNameEmoji } from './quote/emoji.js';

export const QUOTE_COMMANDS = new Set(['q', 'own']);

/**
 * Parse `/q`, `/q@missfrozen_bot`, `/q r`, `/own`.
 * Returns { command, atBot, mode } or null for any other text.
 *
 * `mode: 'reply'` for `/q r` — quote the message that the replied-to message was
 * itself replying to, shown nested inside the card.
 */
export function parseQuoteCommand(text) {
  const raw = String(text || '').trim();
  if (!raw.startsWith('/')) return null;
  const parts = raw.split(/\s+/);
  const [name, atBot] = parts[0].slice(1).split('@');
  const command = name.toLowerCase();
  if (!QUOTE_COMMANDS.has(command)) return null;
  // `/q r` (and the long form `/q reply`); ignored for /own.
  const flag = String(parts[1] || '').toLowerCase();
  const mode = command === 'q' && (flag === 'r' || flag === 'reply') ? 'reply' : null;
  return { command, atBot: atBot || null, mode };
}

/** The `@bot` suffix must name this bot, otherwise the update is not ours. */
export function addressedToUs(atBot) {
  if (!atBot) return true;
  return String(atBot).toLowerCase() === String(BOT_USERNAME).toLowerCase();
}

const MESSAGES = {
  reply_required: '↩️ Reply to a message with <code>/q</code> to quote it.',
  own_reply_required: '↩️ Reply to a <b>sticker</b> with <code>/own</code> to save it to your pack.',
  not_sticker: '↩️ <code>/own</code> only saves stickers. Reply to a sticker with <code>/own</code>.',
  no_author: '🚫 That message has no author to quote.',
  nothing_to_quote: '🚫 That message has nothing to quote — it needs text or a caption.',
  render: '⚠️ Could not build that quote sticker. Try a shorter message.',
  full: '📦 Your sticker pack is full. Remove a sticker in Telegram to add another.',
  full_static: `📦 Your static sticker pack is full (${STICKER_LIMITS.static} stickers). Remove one in Telegram to add another.`,
  full_animated: `📦 Your animated sticker pack is full (${STICKER_LIMITS.animated} stickers). Remove one in Telegram to add another.`,
  full_video: `📦 Your video sticker pack is full (${STICKER_LIMITS.video} stickers). Remove one in Telegram to add another.`,
  format_unsupported: '🚫 That sticker format cannot be saved by this bot.',
  unsupported_static: '🚫 Sticker format not supported by this bot.',
  pending: '⏳ Your pack is still being created — try again in a moment.',
  unclear: '⚠️ Telegram did not confirm the upload. Check your pack before retrying.',
  api: '⚠️ Telegram refused the request. Try again later.',
  bad_file: '⚠️ Telegram rejected that sticker.',
  invalid_name: '⚠️ That pack name is not valid for this bot.',
  bad_bot_username: '⚠️ Sticker packs are not configured for this bot.',
  format: '⚠️ Telegram rejected that sticker format for your pack. Nothing was saved.',
  unsupported_mask: '🚫 Mask stickers cannot be saved to a personal pack.',
  unsupported_custom_emoji: '🚫 Custom emoji cannot be saved to a personal pack.',
  not_sticker_format: '↩️ <code>/own</code> only saves regular stickers.',
};

async function reply(message, html) {
  try {
    await api.sendMessage({
      chat_id: message.chat.id,
      text: html,
      parse_mode: 'HTML',
      reply_parameters: replyParametersFor(message.chat.id),
    });
  } catch (e) {
    console.error('[quote reply]', e?.description || e?.message || e);
  }
}

const usageReply = (message, key) => reply(message, MESSAGES[key] || MESSAGES.reply_required);

/**
 * Build the sticker for an extracted quote. Pure: no API calls, no persistence,
 * so tests can assert exactly what the card will say and show.
 *
 * @param {object} quote  result of `extractQuote`
 * @param {object|null} avatar  decoded profile photo, or null for the lettered disc
 * @param {{name:string,text:string,userId:number}|null} [nested]  the parent
 *        message, for `/q r`
 * @param {string} [avatarSource]  where the avatar came from (`user`, `emoji`, …)
 * @param {Map<string, object>|null} [nameEmoji]  artwork for the emoji in the
 *        display name, keyed by cluster ("❄️")
 */
export function buildQuoteSticker(quote, avatar = null, nested = null, avatarSource = '',
  nameEmoji = null) {
  const emojiAvatar = avatarSource === 'emoji' || avatarSource === 'emoji-fetched';
  return renderQuotePng({
    text: quote.text,
    name: quote.name,
    userId: quote.senderId || quote.senderChatId || 0,
    avatar,
    kind: quote.kind,
    nested,
    // Emoji artwork is painted as a single-tone glyph on a tinted disc.
    emojiAvatar,
    emojiCodepoint: emojiAvatar ? emojiCodepointOf(quote.name) : 0,
    // The ❄️ in "𝑭𝒓❄️𝒛𝒆𝒏" is part of the name; draw it, do not drop it.
    nameEmoji,
  });
}

/**
 * The message the replied-to message was itself replying to — the parent shown
 * inside the card for `/q r`. Returns an extractable shape, or null when the
 * replied-to message is not itself a reply.
 */
function nestedSourceOf(message) {
  const target = message?.reply_to_message;
  const parent = target?.reply_to_message;
  if (!parent) return null;
  // Never nest the command message itself.
  if (message?.message_id != null && parent.message_id === message.message_id) return null;
  const flat = quoteSourceOf({ reply_to_message: parent, message_id: message?.message_id });
  if (!flat) return null;
  return flat;
}

/** `/q` — render and send the quote sticker (never creates a pack). */
async function handleQuote(message, mode = null) {
  const source = quoteSourceOf(message);
  const quote = extractQuote(source);
  if (!quote.ok) {
    await usageReply(message, quote.reason === 'reply_required' ? 'reply_required' : quote.reason);
    return true;
  }

  // The avatar belongs to the author of the *replied-to* message — never the
  // person who invoked /q. When Telegram will not hand over that photo, the
  // bot's own photo stands in; the lettered disc is the last resort.
  const photo = await resolveAvatar(quote);

  // `/q r`: show the parent message nested inside the card. If the replied-to
  // message is not itself a reply there is nothing to nest, so the card is
  // rendered normally rather than failing.
  let nested = null;
  if (mode === 'reply') {
    const parentSource = nestedSourceOf(message);
    const parent = parentSource ? extractQuote(parentSource) : null;
    if (parent?.ok) nested = { name: parent.name, text: parent.text || parent.kind, userId: parent.senderId || 0 };
  }

  // Emoji inside the name need their artwork before the (synchronous) render:
  // baked core first, CDN second, and nothing drawn when neither has it.
  const nameEmoji = await resolveNameEmoji(`${quote.name} ${nested?.name || ''}`);

  let rendered;
  try {
    rendered = buildQuoteSticker(quote, photo.image, nested, photo.source, nameEmoji);
  } catch (e) {
    console.error('[quote render]', e?.message || e);
    await reply(message, MESSAGES.render);
    return true;
  }

  try {
    await api.sendSticker({
      chat_id: message.chat.id,
      sticker: new InputFile(rendered.bytes, 'quote.png', { type: 'image/png' }),
    });
  } catch (e) {
    console.error('[quote send sticker]', e?.description || e?.message || e);
    await reply(message, MESSAGES.api);
  }
  return true;
}

/** `/own` — copy the replied sticker into the caller's personal pack. */
async function handleOwn(message) {
  const target = message.reply_to_message;
  if (!target) {
    await usageReply(message, 'own_reply_required');
    return true;
  }

  const sticker = target.sticker;
  if (!sticker) {
    await usageReply(message, 'not_sticker');
    return true;
  }

  const format = formatOfSticker(sticker);
  if (!format.ok) {
    await usageReply(message, MESSAGES[format.reason] ? format.reason : 'not_sticker_format');
    return true;
  }

  let result;
  try {
    result = await ownSticker({
      userId: message.from.id,
      displayName: message.from.first_name || message.from.username,
      botUsername: BOT_USERNAME,
      sticker,
    });
  } catch (e) {
    console.error('[sticker own]', e?.description || e?.message || e);
    await reply(message, MESSAGES.api);
    return true;
  }

  if (!result.ok) {
    let text = MESSAGES[result.code] || MESSAGES.api;
    if (result.code === 'full') {
      text = MESSAGES[`full_${result.format || 'static'}`] || MESSAGES.full;
    }
    const suffix = result.url ? `\n\n🔗 ${escapeHtml(result.url)}` : '';
    await reply(message, text + suffix);
    return true;
  }

  const packLabel = result.format === 'static' ? 'static pack' : `${result.format} pack`;
  let headline;
  if (result.duplicate) headline = '📦 <b>ALREADY IN YOUR PACK</b>';
  else if (result.created) headline = `📦 <b>${result.format.toUpperCase()} STICKER PACK CREATED</b>`;
  else headline = '✅ <b>SAVED TO YOUR PACK</b>';

  const detail = result.duplicate
    ? `That sticker is already saved (${result.count} in your ${packLabel}).`
    : `Stickers in your ${packLabel}: ${result.count}.`;
  await reply(message, [
    headline, '', detail, '',
    `🔗 <a href="${escapeHtml(result.url)}">Open your sticker pack</a>`,
  ].join('\n'));
  return true;
}

/**
 * Handle `/q` or `/own`. Returns true when the update was consumed.
 * Text is only ever sent as escaped HTML; quoted content never becomes markup.
 */
export async function handleQuoteCommand(message, parsed = null) {
  const command = parsed || parseQuoteCommand(message?.text);
  if (!command) return false;
  if (!addressedToUs(command.atBot)) return false;
  if (!message.from || message.from.is_bot) return false;

  if (!message.reply_to_message) {
    await usageReply(message, command.command === 'own' ? 'own_reply_required' : 'reply_required');
    return true;
  }

  return command.command === 'own' ? handleOwn(message) : handleQuote(message, command.mode);
}
