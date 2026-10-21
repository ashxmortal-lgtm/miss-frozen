import { BUTTON_LABELS, CALLBACKS } from './config.js';

// Inline keyboards only. Telegram buttons have no font-family setting; the
// supplied Unicode characters are preserved verbatim in the labels.
//
// `web_app` opens the Mini App directly in Telegram. Telegram only allows
// web_app buttons in private chats, which is the only place this bot answers.

/** One primary button, exactly as specified. */
export function welcomeKeyboard() {
  return {
    inline_keyboard: [
      [{ text: BUTTON_LABELS.menu, callback_data: CALLBACKS.menu }],
    ],
  };
}

/** Step 1: "choose" + the date. */
export function chooseKeyboard() {
  return {
    inline_keyboard: [
      [{ text: BUTTON_LABELS.date, callback_data: CALLBACKS.date }],
    ],
  };
}

/**
 * Step 2: one button that launches the Mini App at /gift. The URL contains only
 * the non-sensitive route; identity is re-verified by the platform and the
 * allowlist on every endpoint call.
 */
export function giftKeyboard(giftUrl) {
  return {
    inline_keyboard: [
      [{ text: BUTTON_LABELS.gift, web_app: { url: giftUrl } }],
    ],
  };
}

/** Fallback only when the owner has not configured the Mini App URL yet. */
export function pendingGiftKeyboard() {
  return {
    inline_keyboard: [
      [{ text: BUTTON_LABELS.gift, callback_data: CALLBACKS.pendingGift }],
    ],
  };
}
