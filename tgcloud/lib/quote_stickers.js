/**
 * `/q` and `/own` — Classic QuotLy-style quote stickers.
 *
 *   /q     reply to a message → render a 512×512 PNG quote and send it here.
 *   /own   the same, then save it to the caller's personal sticker pack
 *          (created on first use, reused afterwards) and return the pack link.
 *
 * Pipeline: extract (quote/extract.js) → render (quote/render.js, pure JS) →
 * send or upload (quote/packs.js). The isolate has no canvas, no npm packages
 * and no `node:zlib`, which is why the renderer and PNG encoder are hand-written.
 *
 * Nothing about the quoted message is persisted: only the pack metadata.
 */

import { api, InputFile } from 'sdk';
import { BOT_USERNAME } from './config.js';
import { escapeHtml } from './texts.js';
import { replyParametersFor } from './reply_target.js';
import { extractQuote, quoteSourceOf } from './quote/extract.js';
import { renderQuotePng } from './quote/render.js';
import { ownQuote, MAX_STATIC_STICKERS } from './quote/packs.js';

export const QUOTE_COMMANDS = new Set(['q', 'own']);

/**
 * Parse `/q`, `/q@missfrozen_bot`, `/own foo`.
 * Returns { command, atBot } or null for any other text.
 */
export function parseQuoteCommand(text) {
  const raw = String(text || '').trim();
  if (!raw.startsWith('/')) return null;
  const head = raw.split(/\s+/)[0].slice(1);
  const [name, atBot] = head.split('@');
  const command = name.toLowerCase();
  if (!QUOTE_COMMANDS.has(command)) return null;
  return { command, atBot: atBot || null };
}

/** The `@bot` suffix must name this bot, otherwise the update is not ours. */
export function addressedToUs(atBot) {
  if (!atBot) return true;
  return String(atBot).toLowerCase() === String(BOT_USERNAME).toLowerCase();
}

const MESSAGES = {
  reply_required: '↩️ Reply to a message with <code>/q</code> to quote it.',
  own_reply_required: '↩️ Reply to a message with <code>/own</code> to save it to your pack.',
  no_author: '🚫 That message has no author to quote.',
  nothing_to_quote: '🚫 That message has nothing to quote — it needs text or a caption.',
  render: '⚠️ Could not build that quote sticker. Try a shorter message.',
  full: `📦 Your pack is full (${MAX_STATIC_STICKERS} stickers). Remove one in Telegram to add another.`,
  pending: '⏳ Your pack is still being created — try again in a moment.',
  unclear: '⚠️ Telegram did not confirm the upload. Check your pack before retrying.',
  api: '⚠️ Telegram refused the upload. Try again later.',
  bad_file: '⚠️ Telegram rejected the sticker image.',
  invalid_name: '⚠️ That pack name is not valid for this bot.',
  bad_bot_username: '⚠️ Sticker packs are not configured for this bot.',
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

/**
 * Handle `/q` or `/own`. Returns true when the update was consumed.
 * Text is only ever sent as escaped HTML; quoted content never becomes markup.
 */
export async function handleQuoteCommand(message, parsed = null) {
  const command = parsed || parseQuoteCommand(message?.text);
  if (!command) return false;
  if (!addressedToUs(command.atBot)) return false;
  const isOwn = command.command === 'own';

  if (!message.reply_to_message) {
    await reply(message, isOwn ? MESSAGES.own_reply_required : MESSAGES.reply_required);
    return true;
  }

  const quote = extractQuote(quoteSourceOf(message));
  if (!quote.ok) {
    const key = quote.reason === 'reply_required'
      ? (isOwn ? 'own_reply_required' : 'reply_required')
      : quote.reason;
    await reply(message, MESSAGES[key] || MESSAGES.nothing_to_quote);
    return true;
  }

  let rendered;
  try {
    rendered = renderQuotePng({ text: quote.text, name: quote.name, handle: quote.handle, kind: quote.kind });
  } catch (e) {
    console.error('[quote render]', e?.message || e);
    await reply(message, MESSAGES.render);
    return true;
  }

  if (!isOwn) {
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

  // /own — create or reuse the caller's pack, then report the link.
  let result;
  try {
    result = await ownQuote({
      userId: message.from.id,
      displayName: message.from.first_name || message.from.username,
      botUsername: BOT_USERNAME,
      pngBytes: rendered.bytes,
    });
  } catch (e) {
    console.error('[quote own]', e?.description || e?.message || e);
    await reply(message, MESSAGES.api);
    return true;
  }

  if (!result.ok) {
    const text = MESSAGES[result.code] || MESSAGES.api;
    const suffix = result.url ? `\n\n🔗 ${escapeHtml(result.url)}` : '';
    await reply(message, text + suffix);
    return true;
  }

  const lines = result.created
    ? ['📦 <b>STICKER PACK CREATED</b>', '', `Your quote was saved to a new pack (${result.count} sticker).`]
    : ['✅ <b>SAVED TO YOUR PACK</b>', '', `Stickers in your pack: ${result.count}.`];
  lines.push('', `🔗 <a href="${escapeHtml(result.url)}">Open your quote pack</a>`);
  await reply(message, lines.join('\n'));
  return true;
}
