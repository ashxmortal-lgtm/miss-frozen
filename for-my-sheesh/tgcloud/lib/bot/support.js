import { MENU_TAP_COOLDOWN_SECONDS } from '../config.js';
import { resolveMiniAppBaseUrl } from '../mini_app_url.js';

/**
 * Non-security helpers around the durable store. Dedupe/cooldown store
 * failures deliberately fail OPEN: they must never hide the gift from an
 * authorized user. Authorization itself always fails CLOSED (see access.js).
 */
export function createBotSupport(store, options = {}) {
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const cooldown = options.menuTapCooldownSeconds ?? MENU_TAP_COOLDOWN_SECONDS;

  return {
    /** true when this Telegram update_id has not been handled before. */
    async claimUpdate(updateId) {
      if (!Number.isSafeInteger(updateId)) return true;
      try {
        return await store.claimUpdate(updateId, now());
      } catch (error) {
        console.error('[bot] update dedupe unavailable', error);
        return true;
      }
    },

    /** true when enough time has passed to send this menu step again. */
    async shouldSendStep(telegramId, step) {
      try {
        const previous = await store.getMenuTap(telegramId, step);
        if (!previous) return true;
        return now() - previous.sentAt >= cooldown;
      } catch (error) {
        console.error('[bot] menu cooldown unavailable', error);
        return true;
      }
    },

    async recordStep(telegramId, step, messageId) {
      try {
        await store.setMenuTap({ telegramId, step, now: now(), messageId });
      } catch (error) {
        console.error('[bot] menu cooldown write failed', error);
      }
    },

    async getMiniAppBaseUrl() {
      return await resolveMiniAppBaseUrl(store);
    },
  };
}
