import { MAX_INIT_DATA_AGE_SECONDS } from './config.js';
import { InitDataError, INIT_DATA_ERROR_CODES } from './errors.js';
import { tryParseTelegramUserId } from './ids.js';

/**
 * Validate the Mini App init data that TGCloud has ALREADY verified.
 *
 * Contract (documented for endpoints): `ctx.initData` is the platform-verified
 * init data, the same shape as `Telegram.WebApp.initDataUnsafe`; a call whose
 * initData signature is missing or invalid receives 401 and the endpoint never
 * runs. Because the isolate has no bot token and no secrets store, our code must
 * not and cannot re-run the HMAC itself — but it independently enforces the
 * rest: required fields, user shape, future timestamps and a freshness window.
 *
 * The raw client object `Telegram.WebApp.initDataUnsafe` is never accepted as
 * evidence; only this server-provided, signature-verified object is.
 */

const MAX_FUTURE_SKEW_SECONDS = 60;

function parseAuthDate(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === 'string' && /^[0-9]{1,12}$/.test(value.trim())) {
    const parsed = Number(value.trim());
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

/**
 * @param {unknown} initData platform-verified init data
 * @param {{now?: number, maxAgeSeconds?: number}} [options] `now` in unix seconds
 * @returns {{userId: number, authDate: number, user: object}}
 */
export function validateInitData(initData, options = {}) {
  if (!initData || typeof initData !== 'object' || Array.isArray(initData)) {
    throw new InitDataError(
      INIT_DATA_ERROR_CODES.MISSING,
      'Open this app from Telegram so I can verify who you are. 🎀',
    );
  }

  const now = options.now ?? Math.floor(Date.now() / 1000);
  const maxAge = options.maxAgeSeconds ?? MAX_INIT_DATA_AGE_SECONDS;

  const authDate = parseAuthDate(initData.auth_date);
  if (authDate === null || authDate <= 0) {
    throw new InitDataError(
      INIT_DATA_ERROR_CODES.MALFORMED,
      'Your Telegram session could not be verified. Reopen the app from the bot.',
    );
  }

  if (authDate > now + MAX_FUTURE_SKEW_SECONDS) {
    throw new InitDataError(
      INIT_DATA_ERROR_CODES.MALFORMED,
      'Your Telegram session could not be verified. Reopen the app from the bot.',
    );
  }

  if (now - authDate > maxAge) {
    throw new InitDataError(
      INIT_DATA_ERROR_CODES.EXPIRED,
      'Your Telegram session expired. Reopen the app from the bot. 🎀',
    );
  }

  const user = initData.user;
  if (!user || typeof user !== 'object' || Array.isArray(user) || user.is_bot === true) {
    throw new InitDataError(
      INIT_DATA_ERROR_CODES.MALFORMED,
      'Open this app from your own Telegram account to continue. 🎀',
    );
  }

  const userId = tryParseTelegramUserId(user.id);
  if (userId === null) {
    throw new InitDataError(
      INIT_DATA_ERROR_CODES.MALFORMED,
      'Your Telegram identity could not be read. Reopen the app from the bot.',
    );
  }

  return { userId, authDate, user };
}
