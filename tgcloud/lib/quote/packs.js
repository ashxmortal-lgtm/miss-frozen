/**
 * Personal quote-sticker packs for `/own`.
 *
 * Telegram constraints handled here:
 *   - a set created by a bot is owned by the *invoking user* (`user_id`);
 *   - its short name is `<something>_by_<bot_username>` and is globally unique;
 *   - a static set holds at most 120 stickers;
 *   - `createNewStickerSet` / `addStickerToSet` may time out *after* the remote
 *     call succeeded, so every failure is classified instead of assumed.
 *
 * The pack row is written to the database *before* the API call (a claim row),
 * so two simultaneous `/own` requests cannot both try to create a set: the
 * unique index on `telegram_id` lets exactly one of them win.
 */

import { db, api, BotApiError, InputFile } from 'sdk';
import { sql } from 'sdk/db';

export const MAX_STATIC_STICKERS = 120;
export const STICKER_EMOJI = ['🐸', '🍥', '❄️', '🥀', '🍜', '👁️', '🌸', '⚔️'];

/** Telegram bot usernames are `[A-Za-z0-9_]{5,32}`; the suffix keeps sets unique. */
export function packSuffix(botUsername) {
  const handle = String(botUsername || '').replace(/^@/, '').toLowerCase();
  const safe = handle.replace(/[^a-z0-9_]/g, '');
  if (safe.length < 5) return null;
  return `_by_${safe}`;
}

/**
 * Build the set's short name: `<base>_by_<bot>`, lower-case, ≤ 64 characters.
 * Telegram only accepts letters, digits and underscores.
 */
export function buildPackName(userId, botUsername, base = 'frozen_quotes') {
  const suffix = packSuffix(botUsername);
  if (!suffix) return null;
  const prefix = String(base).toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 20) || 'quotes';
  const name = `${prefix}${userId}${suffix}`.replace(/_+/g, '_');
  return name.length <= 64 ? name : `${prefix}${String(userId).slice(-12)}${suffix}`.slice(0, 64);
}

/** Telegram rejects a title longer than 64 characters. */
export function buildPackTitle(displayName) {
  const base = String(displayName || 'Player').replace(/\s+/g, ' ').trim().slice(0, 40) || 'Player';
  return `${base} quotes`.slice(0, 64);
}

export function packUrl(name) {
  return name ? `https://t.me/addstickers/${name}` : '';
}

const isTimeout = (error) => {
  const text = `${error?.description || ''} ${error?.message || ''}`.toLowerCase();
  return /timeout|timed out|etimedout|econnreset|gateway|502|504/.test(text)
    || error?.code === 429;
};

const isAlreadyExists = (error) => /already|occupied|exists/i.test(String(error?.description || error?.message || ''));
const isInvalidName = (error) => /short.?name|invalid|not valid|sticker set/i.test(String(error?.description || ''))
  && !isAlreadyExists(error);

/**
 * Read the stored pack for a user. Returns null when the user has none.
 */
export async function getPackRow(userId) {
  try {
    return await db.get(sql`
      SELECT telegram_id, set_name, title, sticker_count, status
      FROM quote_sticker_packs WHERE telegram_id = ${userId}
    `);
  } catch (e) {
    // The table appears on the next migration; treat a missing table as "none".
    console.error('[quote pack] lookup failed', e?.message || e);
    return null;
  }
}

/**
 * Reserve the (single) pack row for a user before any remote call.
 * Returns { claimed: true, row } for the winner, { claimed: false } if another
 * request already owns it.
 */
export async function claimPack(userId, name, title) {
  const inserted = await db.run(sql`
    INSERT INTO quote_sticker_packs (telegram_id, set_name, title, status, created_at, updated_at)
    VALUES (${userId}, ${name}, ${title}, 'creating', ${Math.floor(Date.now() / 1000)}, ${Math.floor(Date.now() / 1000)})
    ON CONFLICT(telegram_id) DO NOTHING
  `);
  const row = await getPackRow(userId);
  return { claimed: Number(inserted?.rowsAffected) > 0, row };
}

export async function markPack(userId, status, extra = {}) {
  const count = Number(extra.count) || 0;
  await db.run(sql`
    UPDATE quote_sticker_packs
    SET status = ${status},
        sticker_count = ${count},
        last_error = ${extra.error || null},
        updated_at = ${Math.floor(Date.now() / 1000)}
    WHERE telegram_id = ${userId}
  `);
}

/** Drop a claim that never produced a remote set, so a retry can start fresh. */
export async function releasePackClaim(userId) {
  await db.run(sql`
    DELETE FROM quote_sticker_packs
    WHERE telegram_id = ${userId} AND status = 'creating'
  `);
}

/**
 * Create the set with its first sticker. Returns
 * { ok: true } | { ok: 'exists' } | { ok: false, error }.
 */
export async function createPack({ userId, name, title, pngBytes }) {
  try {
    await api.createNewStickerSet({
      user_id: userId,
      name,
      title,
      stickers: [{
        sticker: new InputFile(pngBytes, 'quote.png', { type: 'image/png' }),
        format: 'static',
        emoji_list: [STICKER_EMOJI[0]],
      }],
    });
    return { ok: true };
  } catch (error) {
    if (isAlreadyExists(error)) return { ok: 'exists' };
    // A timeout may still have created the set — the caller reconciles.
    if (isTimeout(error)) return { ok: 'unclear', error };
    return { ok: false, error };
  }
}

/** Add one sticker to an existing set. */
export async function addSticker({ userId, name, pngBytes, emoji = STICKER_EMOJI[0] }) {
  try {
    await api.addStickerToSet({
      user_id: userId,
      name,
      sticker: {
        sticker: new InputFile(pngBytes, 'quote.png', { type: 'image/png' }),
        format: 'static',
        emoji_list: [emoji],
      },
    });
    return { ok: true };
  } catch (error) {
    if (isTimeout(error)) return { ok: 'unclear', error };
    return { ok: false, error };
  }
}

/** Read a set's current size (used to reconcile and to detect a full pack). */
export async function inspectPack(name) {
  try {
    const set = await api.getStickerSet({ name });
    return { ok: true, count: Number(set?.stickers?.length) || 0, set };
  } catch (error) {
    if (error instanceof BotApiError && error.code === 400) return { ok: false, missing: true, error };
    if (isTimeout(error)) return { ok: false, unclear: true, error };
    return { ok: false, error };
  }
}

/** Human-readable reason for a failed Telegram call. */
export function describePackError(error) {
  const text = String(error?.description || error?.message || 'unknown error');
  if (/STICKERS_TOO_MUCH|too many/i.test(text)) return 'full';
  if (isInvalidName(error)) return 'invalid_name';
  if (/file|image|sticker/i.test(text) && /invalid|wrong|unsupported/i.test(text)) return 'bad_file';
  return 'api';
}

/**
 * Guarantee a usable set for the user and add `pngBytes` to it.
 *
 * Flow:
 *   1. stored & ready        → add the sticker (reconcile a full set)
 *   2. no row                → claim, create, store
 *   3. stored as 'creating'  → someone else is mid-flight: inspect, then
 *                              reconcile instead of creating a second set
 *
 * Returns { ok, url, created, count, code }.
 */
export async function ownQuote({ userId, displayName, botUsername, pngBytes }) {
  const name = buildPackName(userId, botUsername);
  if (!name) return { ok: false, code: 'bad_bot_username' };
  const title = buildPackTitle(displayName);

  let row = await getPackRow(userId);
  if (!row) {
    const claim = await claimPack(userId, name, title);
    if (!claim.claimed) {
      // Lost the race: reuse the winner's row (it is 'creating' right now).
      row = claim.row;
    } else {
      const created = await createPack({ userId, name, title, pngBytes });
      if (created.ok === true) {
        await markPack(userId, 'ready', { count: 1 });
        return { ok: true, url: packUrl(name), created: true, count: 1 };
      }
      if (created.ok === 'exists') {
        // The name is taken — most likely this very pack from an earlier run
        // whose response was lost. Keep the row and fall through to adding.
        await markPack(userId, 'ready', { count: 0 });
        row = await getPackRow(userId);
      } else if (created.ok === 'unclear') {
        const inspected = await inspectPack(name);
        if (inspected.ok) {
          await markPack(userId, 'ready', { count: inspected.count });
          return { ok: true, url: packUrl(name), created: true, count: inspected.count };
        }
        await releasePackClaim(userId);
        return { ok: false, code: 'unclear', error: created.error };
      } else {
        await releasePackClaim(userId);
        return { ok: false, code: describePackError(created.error), error: created.error };
      }
    }
  }

  row = row || await getPackRow(userId);
  if (!row) return { ok: false, code: 'api' };

  if (row.status === 'creating') {
    // Another request is still creating it. Touch the remote set; if it exists
    // we adopt it (reconciliation) instead of trying to create a duplicate.
    const inspected = await inspectPack(row.set_name);
    if (!inspected.ok && !inspected.missing) return { ok: false, code: 'unclear', error: inspected.error };
    if (!inspected.ok) return { ok: false, code: 'pending' };
    await markPack(userId, 'ready', { count: inspected.count });
    row = await getPackRow(userId);
  }

  const setName = row.set_name;
  if (Number(row.sticker_count) >= MAX_STATIC_STICKERS) {
    return { ok: false, code: 'full', count: Number(row.sticker_count), url: packUrl(setName) };
  }

  const added = await addSticker({ userId, name: setName, pngBytes });
  if (added.ok === true) {
    const count = Number(row.sticker_count || 0) + 1;
    await markPack(userId, 'ready', { count });
    return { ok: true, url: packUrl(setName), created: false, count };
  }
  // Reconcile: the sticker may have landed despite the error, or the set is full.
  const inspected = await inspectPack(setName);
  if (inspected.ok) {
    if (inspected.count >= MAX_STATIC_STICKERS) {
      await markPack(userId, 'full', { count: inspected.count });
      return { ok: false, code: 'full', count: inspected.count, url: packUrl(setName) };
    }
    if (added.ok === 'unclear' && inspected.count > Number(row.sticker_count || 0)) {
      await markPack(userId, 'ready', { count: inspected.count });
      return { ok: true, url: packUrl(setName), created: false, count: inspected.count };
    }
    await markPack(userId, 'ready', { count: inspected.count });
    return { ok: false, code: describePackError(added.error), error: added.error, url: packUrl(setName) };
  }
  return { ok: false, code: added.ok === 'unclear' ? 'unclear' : describePackError(added.error), error: added.error };
}
