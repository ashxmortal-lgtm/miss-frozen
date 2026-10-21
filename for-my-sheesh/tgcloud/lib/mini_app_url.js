import { MINI_APP_URL, GIFT_ROUTE, SETTING_KEYS } from './config.js';
import { MiniAppUrlError } from './errors.js';

// The only host TGCloud documents for a hosted Mini App is
// https://app<app_id>.tgcloud.ai/. Restricting to it prevents an owner typo (or
// a compromised owner chat) from pointing the gift button at a phishing site.
const TGCLOUD_HOST = /^app[0-9]{6,}\.tgcloud\.ai$/i;

/**
 * Normalize a Mini App base URL to an origin with no trailing slash.
 * Accepts a URL with or without a trailing slash; rejects paths, queries,
 * fragments, credentials, ports and non-TGCloud hosts.
 *
 * @param {string} raw
 * @returns {string} e.g. "https://app123456789.tgcloud.ai"
 */
export function normalizeMiniAppUrl(raw) {
  if (typeof raw !== 'string') throw new MiniAppUrlError('Mini App URL must be text.');
  const value = raw.trim();
  const match = /^https:\/\/([^/?#@:]+)\/?$/.exec(value);
  if (!match) {
    throw new MiniAppUrlError(
      'Use the exact TGCloud URL shown by `tgcloud push`, e.g. https://app123456789.tgcloud.ai/',
    );
  }
  const host = match[1].toLowerCase();
  if (!TGCLOUD_HOST.test(host)) {
    throw new MiniAppUrlError('That is not a TGCloud Mini App host (app<id>.tgcloud.ai).');
  }
  return `https://${host}`;
}

/** Build the direct gift URL. The route carries no identity or secret. */
export function giftUrl(baseUrl) {
  return `${normalizeMiniAppUrl(baseUrl)}${GIFT_ROUTE}`;
}

/**
 * Resolve the configured base URL: the durable setting wins (so `/setapp`
 * works without a redeploy), then the trusted config constant.
 *
 * @param {{getSetting: Function}} store
 * @returns {Promise<string|null>}
 */
export async function resolveMiniAppBaseUrl(store) {
  const stored = await store.getSetting(SETTING_KEYS.MINI_APP_URL);
  if (stored) {
    try {
      return normalizeMiniAppUrl(stored);
    } catch {
      // A malformed stored value falls through to config; never build a URL
      // from an unvalidated string.
      console.error('[mini-app] stored Mini App URL is invalid');
    }
  }
  if (MINI_APP_URL) {
    try {
      return normalizeMiniAppUrl(MINI_APP_URL);
    } catch {
      console.error('[mini-app] config Mini App URL is invalid');
    }
  }
  return null;
}

/** Owner action: persist a validated base URL. */
export async function saveMiniAppBaseUrl(store, rawUrl, actorId, now) {
  const normalized = normalizeMiniAppUrl(rawUrl);
  const timestamp = Number.isFinite(now) ? now : Math.floor(Date.now() / 1000);
  await store.setSetting(SETTING_KEYS.MINI_APP_URL, normalized, timestamp);
  try {
    await store.audit({
      actorId,
      action: 'set_mini_app_url',
      targetId: 0,
      now: timestamp,
    });
  } catch (error) {
    console.error('[mini-app] audit write failed', error);
  }
  return normalized;
}
