import { MAX_TELEGRAM_USER_ID } from './config.js';
import { AccessError, ACCESS_ERROR_CODES } from './errors.js';

/**
 * Accept only a real numeric Telegram user ID.
 *
 * Telegram user IDs are positive integers below 2^52. Usernames, @handles,
 * chat IDs (which may be negative, e.g. -100...), zero, floats, leading zeros,
 * `+` prefixes and anything containing whitespace are rejected. Accepting a
 * string here is convenient for bot commands; nothing else about it is trusted.
 *
 * @param {unknown} raw
 * @returns {number}
 */
export function parseTelegramUserId(raw) {
  if (typeof raw === 'number') {
    if (!Number.isSafeInteger(raw) || raw <= 0 || raw > MAX_TELEGRAM_USER_ID) {
      throw invalidId();
    }
    return raw;
  }

  if (typeof raw === 'string') {
    const value = raw.trim();
    // Digits only, no sign, no leading zero, no separators.
    if (!/^[1-9][0-9]{0,15}$/.test(value)) throw invalidId();
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > MAX_TELEGRAM_USER_ID) {
      throw invalidId();
    }
    return parsed;
  }

  throw invalidId();
}

/** Same validation, but returns null instead of throwing. */
export function tryParseTelegramUserId(raw) {
  try {
    return parseTelegramUserId(raw);
  } catch {
    return null;
  }
}

function invalidId() {
  return new AccessError(
    ACCESS_ERROR_CODES.INVALID_ID,
    'That is not a valid numeric Telegram user ID.',
  );
}

/** True only for the configured owner ID. Strict numeric comparison. */
export function isOwnerId(userId, ownerTelegramId) {
  return Number.isSafeInteger(userId) && userId === ownerTelegramId;
}
