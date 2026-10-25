/**
 * Personal sticker packs for `/own`.
 *
 * `/own` copies an *existing* Telegram sticker into the caller's pack — the
 * sticker keeps its original format and appearance because Telegram stores it
 * as a reference to the original file (`file_id`), not as re-rendered pixels.
 *
 * Format rules (Bot API):
 *   - `sticker_format` is chosen once at creation: `static` | `animated` | `video`;
 *   - a set only accepts stickers of its own format, so **each format gets its
 *     own pack** — a user who saved a static sticker also gets a separate video
 *     pack when they first save a video sticker;
 *   - static sets hold ≤ 120 stickers (animated/video: 50);
 *   - `createNewStickerSet` / `addStickerToSet` may time out *after* succeeding,
 *     so every failure is classified and then reconciled with `getStickerSet`.
 *
 * Rows are keyed `(telegram_id, sticker_format)`. The row is claimed
 * (INSERT … ON CONFLICT DO NOTHING) before any remote call, so two simultaneous
 * first `/own` requests for the same format cannot create two sets.
 */

import { db, api, BotApiError, InputFile } from 'sdk';
import { sql } from 'sdk/db';
import { ensureQuotePackSchema } from './schema.js';

export const STICKER_LIMITS = { static: 120, animated: 50, video: 50 };
export const MAX_STATIC_STICKERS = STICKER_LIMITS.static;

/** Telegram bot usernames are `[A-Za-z0-9_]{5,32}`; the suffix keeps sets unique. */
export function packSuffix(botUsername) {
  const handle = String(botUsername || '').replace(/^@/, '').toLowerCase();
  const safe = handle.replace(/[^a-z0-9_]/g, '');
  if (safe.length < 5) return null;
  return `_by_${safe}`;
}

/**
 * Build the set's short name: `<base><userId>_by_<bot>`, lower-case, ≤ 64 chars.
 * Telegram only accepts letters, digits and underscores.
 */
export function buildPackName(userId, botUsername, format = 'static', base = 'frozen') {
  const suffix = packSuffix(botUsername);
  if (!suffix) return null;
  const scope = String(base).toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 16) || 'frozen';
  const tag = String(format || 'static').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8) || 'static';
  // One distinct, valid, globally-unique short name per (user, format).
  const name = `${scope}_${tag}_${userId}${suffix}`.replace(/_+/g, '_');
  return name.length <= 64 ? name : `${scope}_${tag}_${String(userId).slice(-12)}${suffix}`.slice(0, 64);
}

/** Telegram rejects a title longer than 64 characters. */
export function buildPackTitle(displayName, format = 'static') {
  const base = String(displayName || 'Player').replace(/\s+/g, ' ').trim().slice(0, 40) || 'Player';
  const label = format === 'static' ? 'stickers' : `${format} stickers`;
  return `${base} ${label}`.slice(0, 64);
}

export function packUrl(name) {
  return name ? `https://t.me/addstickers/${name}` : '';
}

/**
 * Which pack format a replied sticker needs.
 * @returns {{ok:true, format:'static'|'animated'|'video'}|{ok:false, reason:string}}
 */
export function formatOfSticker(sticker) {
  if (!sticker || typeof sticker !== 'object') return { ok: false, reason: 'not_sticker' };
  const type = String(sticker.type || '');
  if (!sticker.file_id) return { ok: false, reason: 'not_sticker' };
  // mask / custom_emoji stickers cannot be saved into a regular pack.
  if (type === 'mask' || type === 'custom_emoji') return { ok: false, reason: `unsupported_${type}` };
  if (type && type !== 'regular' && !['static', 'animated', 'video'].includes(type)) {
    return { ok: false, reason: 'not_sticker' };
  }
  // `is_animated` / `is_video` are the authoritative flags; new clients also
  // send the derived `type`.
  if (sticker.is_animated || type === 'animated') return { ok: true, format: 'animated' };
  if (sticker.is_video || type === 'video') return { ok: true, format: 'video' };
  return { ok: true, format: 'static' };
}

const isTimeout = (error) => {
  const text = `${error?.description || ''} ${error?.message || ''}`.toLowerCase();
  return /timeout|timed out|etimedout|econnreset|gateway|502|504/.test(text) || error?.code === 429;
};
const isAlreadyExists = (error) => /already|occupied|exists/i
  .test(String(error?.description || error?.message || ''));
const isInvalidName = (error) => /short.?name|invalid|not valid|sticker set/i
  .test(String(error?.description ?? '')) && !isAlreadyExists(error);
const isWrongFormat = (error) => /format|sticker_type|animated|video/i
  .test(String(error?.description ?? ''));

/** Read one stored pack row (null when this user has no pack in that format). */
export async function getPackRow(userId, format = 'static') {
  await ensureQuotePackSchema();
  try {
    return await db.get(sql`
      SELECT telegram_id, set_name, title, sticker_count, status, sticker_format
      FROM sticker_pack_sets
      WHERE telegram_id = ${userId} AND sticker_format = ${format}
    `);
  } catch (error) {
    console.error('[sticker pack] lookup failed', error?.message || error);
    return null;
  }
}

/** Every pack a user owns, one row per format. */
export async function listPackRows(userId) {
  await ensureQuotePackSchema();
  try {
    return await db.all(sql`
      SELECT telegram_id, set_name, title, sticker_count, status, sticker_format
      FROM sticker_pack_sets WHERE telegram_id = ${userId}
    `);
  } catch (error) {
    console.error('[sticker pack] list failed', error?.message || error);
    return [];
  }
}

/**
 * Reserve the pack row for (user, format) before any remote call.
 * The composite primary key makes this the single point of serialisation.
 */
export async function claimPack(userId, format, name, title) {
  await ensureQuotePackSchema();
  const now = Math.floor(Date.now() / 1000);
  const inserted = await db.run(sql`
    INSERT INTO sticker_pack_sets
      (telegram_id, sticker_format, set_name, title, sticker_count, status, created_at, updated_at)
    VALUES (${userId}, ${format}, ${name}, ${title}, 0, 'creating', ${now}, ${now})
    ON CONFLICT(telegram_id, sticker_format) DO NOTHING
  `);
  const row = await getPackRow(userId, format);
  return { claimed: Number(inserted?.rowsAffected) > 0, row };
}

export async function markPack(userId, format, status, extra = {}) {
  await ensureQuotePackSchema();
  const count = Number(extra.count) || 0;
  const now = Math.floor(Date.now() / 1000);
  await db.run(sql`
    UPDATE sticker_pack_sets
    SET status = ${status},
        sticker_count = ${count},
        last_error = ${extra.error || null},
        updated_at = ${now}
    WHERE telegram_id = ${userId} AND sticker_format = ${format}
  `);
}

/** Drop a claim that never produced a remote set, so a retry can start over. */
export async function releasePackClaim(userId, format) {
  await ensureQuotePackSchema();
  await db.run(sql`
    DELETE FROM sticker_pack_sets
    WHERE telegram_id = ${userId} AND sticker_format = ${format}
      AND status = 'creating' AND sticker_count = 0
  `);
}

function stickerPayload(sticker, format) {
  const payload = {
    sticker: sticker.file_id, // copy by reference: original bytes, original format
    format,
    emoji_list: [sticker.emoji || '🍥'],
  };
  if (sticker.mask_position) payload.mask_position = sticker.mask_position;
  if (Array.isArray(sticker.keywords) && sticker.keywords.length) payload.keywords = sticker.keywords;
  return payload;
}

/** Create the set with the replied sticker as its first entry. */
export async function createPack({ userId, name, title, format, sticker }) {
  try {
    await api.createNewStickerSet({
      user_id: userId,
      name,
      title,
      sticker_format: format,
      sticker_type: 'regular',
      stickers: [stickerPayload(sticker, format)],
    });
    return { ok: true };
  } catch (error) {
    if (isAlreadyExists(error)) return { ok: 'exists' };
    if (isTimeout(error)) return { ok: 'unclear', error };
    if (isWrongFormat(error)) return { ok: false, code: 'format', error };
    if (isInvalidName(error)) return { ok: false, code: 'invalid_name', error };
    return { ok: false, code: 'api', error };
  }
}

/** Add one sticker to an existing set. */
export async function addStickerToPack({ userId, name, format, sticker }) {
  try {
    await api.addStickerToSet({
      user_id: userId,
      name,
      sticker: stickerPayload(sticker, format),
    });
    return { ok: true };
  } catch (error) {
    if (isTimeout(error)) return { ok: 'unclear', error };
    if (isWrongFormat(error)) return { ok: false, code: 'format', error };
    return { ok: false, code: 'api', error };
  }
}

/** Read a set's current contents (used to reconcile and to detect a full pack). */
export async function inspectPack(name) {
  try {
    const set = await api.getStickerSet({ name });
    return { ok: true, stickers: set?.stickers || [], set };
  } catch (error) {
    if (error instanceof BotApiError && error.code === 400) return { ok: false, missing: true, error };
    if (isTimeout(error)) return { ok: false, unclear: true, error };
    return { ok: false, error };
  }
}

/** Human-readable reason for a failed Telegram call. */
export function describePackError(error) {
  const text = String(error?.description || error?.message || 'unknown error');
  if (/STICKERS_TOO_MUCH|too many|limit/i.test(text)) return 'full';
  if (isWrongFormat(error)) return 'format';
  if (isInvalidName(error)) return 'invalid_name';
  if (/file|sticker/i.test(text) && /invalid|wrong|unsupported/i.test(text)) return 'bad_file';
  return 'api';
}

/** A sticker already in the set? Telegram keeps the file, so either id matches. */
const containsSticker = (stickers, sticker) => stickers.some((existing) => (
  (existing.file_unique_id && sticker.file_unique_id
    && existing.file_unique_id === sticker.file_unique_id)
  || (existing.file_id && sticker.file_id && existing.file_id === sticker.file_id)
));

const withUrl = (result, name) => ({ ...result, url: name ? packUrl(name) : '' });

/**
 * Save `sticker` into the caller's pack *for that sticker's format*,
 * creating the pack on first use of that format.
 *
 * Static, animated and video stickers each get their own independent pack.
 *
 * @returns {Promise<{ok:true, url:string, created:boolean, count:number,
 *   duplicate?:boolean, format:string}
 *   | {ok:false, code:string, url?:string, count?:number, format?:string}>}
 */
export async function ownSticker({ userId, displayName, botUsername, sticker }) {
  const resolved = formatOfSticker(sticker);
  if (!resolved.ok) return { ok: false, code: resolved.reason };
  const format = resolved.format;

  // Reject unsupported formats *before* any database write or API call.
  if (!STICKER_LIMITS[format]) return { ok: false, code: 'format_unsupported', format };

  const name = buildPackName(userId, botUsername, format);
  if (!name) return { ok: false, code: 'bad_bot_username', format };
  const title = buildPackTitle(displayName, format);
  const limit = STICKER_LIMITS[format];

  await ensureQuotePackSchema();
  let row = await getPackRow(userId, format);

  // ---- first use of this format: create the set with this sticker ----------
  if (!row) {
    const claim = await claimPack(userId, format, name, title);
    if (!claim.claimed) {
      row = claim.row; // lost the race; fall through to the existing-pack path
    } else {
      const created = await createPack({ userId, name, title, format, sticker });
      if (created.ok === true) {
        await markPack(userId, format, 'ready', { count: 1 });
        return withUrl({ ok: true, created: true, count: 1, format }, name);
      }
      if (created.ok === 'exists') {
        // The set already exists remotely — usually this very pack from an
        // earlier call whose response was lost. Adopt it, never duplicate it.
        await markPack(userId, format, 'ready', { count: 0 });
        row = await getPackRow(userId, format);
      } else if (created.ok === 'unclear') {
        const inspected = await inspectPack(name);
        if (inspected.ok) {
          await markPack(userId, format, 'ready', { count: inspected.stickers.length });
          return withUrl({
            ok: true, created: true, count: inspected.stickers.length, format,
            duplicate: containsSticker(inspected.stickers, sticker),
          }, name);
        }
        await releasePackClaim(userId, format);
        return { ok: false, code: 'unclear', format };
      } else {
        // Never leave an empty pack behind (Telegram may have rejected the
        // format outright): drop the claim so a retry starts clean.
        await releasePackClaim(userId, format);
        return { ok: false, code: created.code || 'api', format };
      }
    }
  }

  row = row || await getPackRow(userId, format);
  if (!row) return { ok: false, code: 'api', format };

  // ---- another request is still creating this format's set ----------------
  if (row.status === 'creating') {
    const inspected = await inspectPack(row.set_name);
    if (!inspected.ok && inspected.missing) return { ok: false, code: 'pending', format };
    if (!inspected.ok) return { ok: false, code: 'unclear', format };
    await markPack(userId, format, 'ready', { count: inspected.stickers.length });
    row = await getPackRow(userId, format);
  }

  const setName = row.set_name;

  // ---- duplicates are a success, not an error ----------------------------
  const current = await inspectPack(setName);
  if (current.ok && containsSticker(current.stickers, sticker)) {
    await markPack(userId, format, 'ready', { count: current.stickers.length });
    return withUrl({
      ok: true, created: false, count: current.stickers.length, format, duplicate: true,
    }, setName);
  }
  const currentCount = current.ok ? current.stickers.length : Number(row.sticker_count || 0);
  if (currentCount >= limit) {
    await markPack(userId, format, 'full', { count: currentCount });
    return { ok: false, code: 'full', count: currentCount, format, url: packUrl(setName) };
  }

  const added = await addStickerToPack({ userId, name: setName, format, sticker });
  if (added.ok === true) {
    const count = currentCount + 1;
    await markPack(userId, format, 'ready', { count });
    return withUrl({ ok: true, created: false, count, format }, setName);
  }

  // ---- failure: reconcile before reporting -------------------------------
  const after = await inspectPack(setName);
  if (after.ok) {
    const duplicate = containsSticker(after.stickers, sticker);
    if (duplicate || after.stickers.length > currentCount) {
      await markPack(userId, format, 'ready', { count: after.stickers.length });
      return withUrl({
        ok: true, created: false, count: after.stickers.length, format, duplicate,
      }, setName);
    }
    if (after.stickers.length >= limit) {
      await markPack(userId, format, 'full', { count: after.stickers.length });
      return { ok: false, code: 'full', count: after.stickers.length, format, url: packUrl(setName) };
    }
    await markPack(userId, format, 'ready', { count: after.stickers.length });
    return {
      ok: false, code: added.code || describePackError(added.error),
      format, url: packUrl(setName),
    };
  }
  return {
    ok: false,
    code: added.ok === 'unclear' ? 'unclear' : (added.code || 'api'),
    format,
  };
}

export { InputFile };
