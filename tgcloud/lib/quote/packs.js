/**
 * Personal sticker packs for `/own`.
 *
 * `/own` copies an *existing* Telegram sticker into the caller's pack — the
 * sticker keeps its original format and appearance because Telegram stores it
 * as a reference to the original file (`file_id`), not as re-rendered pixels.
 *
 * Format rules (Bot API):
 *   - `sticker_format` is chosen once at creation: `static` | `animated` | `video`;
 *   - a set only accepts stickers of its own format, so a user who first saved a
 *     static sticker cannot also add a video one — that is rejected with a clear
 *     message rather than a confusing API error;
 *   - static sets hold ≤ 120 stickers (animated/video: 50);
 *   - `createNewStickerSet` / `addStickerToSet` may time out *after* succeeding,
 *     so every failure is classified and then reconciled with `getStickerSet`.
 *
 * The pack row is claimed (INSERT … ON CONFLICT DO NOTHING) before any remote
 * call, so two simultaneous first `/own` requests cannot create two sets.
 */

import { db, api, BotApiError, InputFile } from 'sdk';
import { sql } from 'sdk/db';

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
export function buildPackName(userId, botUsername, base = 'frozen_stickers') {
  const suffix = packSuffix(botUsername);
  if (!suffix) return null;
  const prefix = String(base).toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 20) || 'stickers';
  const name = `${prefix}${userId}${suffix}`.replace(/_+/g, '_');
  return name.length <= 64 ? name : `${prefix}${String(userId).slice(-12)}${suffix}`.slice(0, 64);
}

/** Telegram rejects a title longer than 64 characters. */
export function buildPackTitle(displayName) {
  const base = String(displayName || 'Player').replace(/\s+/g, ' ').trim().slice(0, 40) || 'Player';
  return `${base} stickers`.slice(0, 64);
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

/** Read the stored pack row for a user (null when they have none). */
export async function getPackRow(userId) {
  try {
    return await db.get(sql`
      SELECT telegram_id, set_name, title, sticker_count, status, sticker_format
      FROM quote_sticker_packs WHERE telegram_id = ${userId}
    `);
  } catch (error) {
    console.error('[sticker pack] lookup failed', error?.message || error);
    return null;
  }
}

/** Reserve the single pack row for a user before any remote call. */
export async function claimPack(userId, name, format, title) {
  const now = Math.floor(Date.now() / 1000);
  const inserted = await db.run(sql`
    INSERT INTO quote_sticker_packs
      (telegram_id, set_name, title, sticker_count, status, sticker_format, created_at, updated_at)
    VALUES (${userId}, ${name}, ${title}, 0, 'creating', ${format}, ${now}, ${now})
    ON CONFLICT(telegram_id) DO NOTHING
  `);
  const row = await getPackRow(userId);
  return { claimed: Number(inserted?.rowsAffected) > 0, row };
}

export async function markPack(userId, status, extra = {}) {
  const count = Number(extra.count) || 0;
  const now = Math.floor(Date.now() / 1000);
  await db.run(sql`
    UPDATE quote_sticker_packs
    SET status = ${status},
        sticker_count = ${count},
        last_error = ${extra.error || null},
        updated_at = ${now}
    WHERE telegram_id = ${userId}
  `);
}

/** Drop a claim that never produced a remote set, so a retry can start over. */
export async function releasePackClaim(userId) {
  await db.run(sql`
    DELETE FROM quote_sticker_packs
    WHERE telegram_id = ${userId} AND status = 'creating' AND sticker_count = 0
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

/**
 * Save `sticker` into the user's pack, creating the pack on first use.
 *
 * @returns {Promise<{ok:true, url:string, created:boolean, count:number, duplicate?:boolean}
 *   | {ok:false, code:string, url?:string, count?:number}>}
 */
export async function ownSticker({ userId, displayName, botUsername, sticker }) {
  const format = formatOfSticker(sticker);
  if (!format.ok) return { ok: false, code: format.reason };

  const name = buildPackName(userId, botUsername);
  if (!name) return { ok: false, code: 'bad_bot_username' };
  const title = buildPackTitle(displayName);
  const packFormat = format.format;
  const limit = STICKER_LIMITS[packFormat];

  let row = await getPackRow(userId);

  // ---- first use: create the set with this sticker -------------------------
  if (!row) {
    const claim = await claimPack(userId, name, packFormat, title);
    if (!claim.claimed) {
      row = claim.row; // lost the race; fall through to the "existing pack" path
    } else {
      const created = await createPack({ userId, name, title, format: packFormat, sticker });
      if (created.ok === true) {
        await markPack(userId, 'ready', { count: 1 });
        return { ok: true, url: packUrl(name), created: true, count: 1 };
      }
      if (created.ok === 'exists') {
        // The set already exists remotely — usually this very pack from an
        // earlier call whose response was lost. Adopt it instead of failing.
        await markPack(userId, 'ready', { count: 0 });
        row = await getPackRow(userId);
      } else if (created.ok === 'unclear') {
        // Ambiguous: never create a second set. Reconcile with getStickerSet.
        const inspected = await inspectPack(name);
        if (inspected.ok) {
          await markPack(userId, 'ready', { count: inspected.stickers.length });
          const duplicate = containsSticker(inspected.stickers, sticker);
          return { ok: true, url: packUrl(name), created: true, count: inspected.stickers.length, duplicate };
        }
        await releasePackClaim(userId);
        return { ok: false, code: 'unclear' };
      } else {
        await releasePackClaim(userId);
        return { ok: false, code: created.code || 'api' };
      }
    }
  }

  row = row || await getPackRow(userId);
  if (!row) return { ok: false, code: 'api' };

  // ---- a concurrent request is still creating the set ----------------------
  if (row.status === 'creating') {
    const inspected = await inspectPack(row.set_name);
    if (!inspected.ok && inspected.missing) return { ok: false, code: 'pending' };
    if (!inspected.ok) return { ok: false, code: 'unclear' };
    await markPack(userId, 'ready', { count: inspected.stickers.length });
    row = await getPackRow(userId);
  }

  const setName = row.set_name;
  const setFormat = row.sticker_format || packFormat;

  // ---- format mismatch: a set only holds one sticker format ---------------
  if (setFormat !== packFormat) {
    return { ok: false, code: 'format_mismatch', url: packUrl(setName), setFormat };
  }

  // ---- duplicates are a success, not an error ----------------------------
  const current = await inspectPack(setName);
  if (current.ok && containsSticker(current.stickers, sticker)) {
    await markPack(userId, 'ready', { count: current.stickers.length });
    return {
      ok: true, url: packUrl(setName), created: false,
      count: current.stickers.length, duplicate: true,
    };
  }
  const currentCount = current.ok ? current.stickers.length : Number(row.sticker_count || 0);
  if (currentCount >= limit) {
    await markPack(userId, 'full', { count: currentCount });
    return { ok: false, code: 'full', count: currentCount, url: packUrl(setName) };
  }

  const added = await addStickerToPack({ userId, name: setName, format: packFormat, sticker });
  if (added.ok === true) {
    const count = currentCount + 1;
    await markPack(userId, 'ready', { count });
    return { ok: true, url: packUrl(setName), created: false, count };
  }

  // ---- failure: reconcile before reporting -------------------------------
  const after = await inspectPack(setName);
  if (after.ok) {
    const duplicate = containsSticker(after.stickers, sticker);
    if (duplicate || after.stickers.length > currentCount) {
      await markPack(userId, 'ready', { count: after.stickers.length });
      return {
        ok: true, url: packUrl(setName), created: false,
        count: after.stickers.length, duplicate,
      };
    }
    if (after.stickers.length >= limit) {
      await markPack(userId, 'full', { count: after.stickers.length });
      return { ok: false, code: 'full', count: after.stickers.length, url: packUrl(setName) };
    }
    await markPack(userId, 'ready', { count: after.stickers.length });
    return { ok: false, code: added.code || describePackError(added.error), url: packUrl(setName) };
  }
  return { ok: false, code: added.ok === 'unclear' ? 'unclear' : (added.code || 'api') };
}

export { InputFile };
