// Trusted server-side configuration for For My Sheesh.
//
// TGCloud 0.2.0 does not document runtime environment variables or a secrets
// store. The deployed V8 isolate can import only `sdk` and project modules, so
// this file is the trusted server configuration. It is never sent to the Mini
// App and it contains no secrets: the platform's `api` proxy calls the Bot API
// without a bot token, and TGCloud manages the webhook itself.
//
// The owner identity lives here, in server code — NOT in the database, a query
// string, a browser variable, or a Telegram username. A database row can never
// promote anyone to owner while this constant disagrees.

/** @type {number} Verified Telegram numeric user ID of the only owner. */
export const OWNER_TELEGRAM_ID = 8716863150;

/** Telegram user IDs are positive integers below 2^52. */
export const MAX_TELEGRAM_USER_ID = 4503599627370495;

/**
 * How long a verified Mini App `auth_date` stays usable. The platform verifies
 * the initData signature before an endpoint runs; this is our own freshness
 * bound, checked again in the endpoint.
 */
export const MAX_INIT_DATA_AGE_SECONDS = 12 * 60 * 60;

/**
 * Mini App base URL. Leave empty and set it after the first deploy with the
 * owner-only command `/setapp https://app<app_id>.tgcloud.ai/` — no redeploy
 * needed. Only the documented TGCloud host pattern is accepted.
 */
export const MINI_APP_URL = '';

/** Route inside the Mini App that opens the anniversary gift cover. */
export const GIFT_ROUTE = '/gift';

/** Callback data (Telegram limit: 64 bytes). */
export const CALLBACKS = Object.freeze({
  menu: 'fms:m',
  date: 'fms:d',
  pendingGift: 'fms:p',
});

/** A rapid double-tap inside this window reuses the previous menu message. */
export const MENU_TAP_COOLDOWN_SECONDS = 5;

/** Button labels are part of the product copy — keep them exact. */
export const BUTTON_LABELS = Object.freeze({
  menu: 'mini 🎁 surprises',
  date: '8 oct 2026',
  gift: 'hehe 🤌',
});

/** Roles stored in the durable allowlist. */
export const ROLES = Object.freeze({
  OWNER: 'owner',
  MEMBER: 'member',
});

/** Setting keys in the bot_settings table. */
export const SETTING_KEYS = Object.freeze({
  MINI_APP_URL: 'mini_app_url',
});

/**
 * Fail fast at module load if the trusted configuration is obviously broken.
 * This runs in the isolate and in tests; it never exposes values to clients.
 */
export function assertServerConfig(config = {}) {
  const ownerId = config.ownerTelegramId ?? OWNER_TELEGRAM_ID;
  const maxAge = config.maxInitDataAgeSeconds ?? MAX_INIT_DATA_AGE_SECONDS;
  if (!Number.isSafeInteger(ownerId) || ownerId <= 0 || ownerId > MAX_TELEGRAM_USER_ID) {
    throw new Error('OWNER_TELEGRAM_ID must be a positive numeric Telegram user ID.');
  }
  if (!Number.isSafeInteger(maxAge) || maxAge < 60 || maxAge > 7 * 24 * 60 * 60) {
    throw new Error('MAX_INIT_DATA_AGE_SECONDS must be between 60 and 604800.');
  }
  return { ownerTelegramId: ownerId, maxInitDataAgeSeconds: maxAge };
}

assertServerConfig();
