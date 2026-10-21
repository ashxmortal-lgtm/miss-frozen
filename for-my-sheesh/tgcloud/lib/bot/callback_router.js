import { CALLBACKS } from '../config.js';
import { ANNIVERSARY_INTRO, MENU_STEP_ONE, TEXTS } from '../content.js';
import { chooseKeyboard, giftKeyboard, pendingGiftKeyboard } from '../keyboards.js';
import { giftUrl } from '../mini_app_url.js';
import { answerCallback, baseMessage, sendMessage } from './send.js';

const STEP_ONE = 'menu-1';
const STEP_TWO = 'menu-2';

/**
 * Callback handling. Callback data is a route hint, never proof of identity:
 * every tap re-checks the verified sender against the durable allowlist.
 *
 * @param {object} query Telegram CallbackQuery (update.callback_query)
 * @param {{update?: object}} ctx
 * @param {{api: object, access: object, support: object}} deps
 */
export async function routeCallback(query, ctx, deps) {
  const { api, access, support } = deps;

  if (!query || !query.id || !query.from || query.from.is_bot === true) {
    return { handled: false, reason: 'malformed' };
  }

  if (query.message?.chat?.type !== 'private') {
    await answerCallback(api, { callback_query_id: query.id });
    return { handled: true, reason: 'not-private' };
  }

  // Telegram can redeliver the same update. Claim it first so a duplicate does
  // not send a second menu message. Dedupe failure fails open; auth never does.
  const updateId = ctx?.update?.update_id;
  const fresh = await support.claimUpdate(updateId);
  if (!fresh) {
    await answerCallback(api, { callback_query_id: query.id });
    return { handled: true, reason: 'duplicate-update' };
  }

  let auth;
  try {
    auth = await access.authorize(query.from.id);
  } catch {
    await answerCallback(api, {
      callback_query_id: query.id,
      text: TEXTS.storageUnavailable,
      show_alert: false,
    });
    return { handled: true, reason: 'storage-error', allowed: false };
  }

  if (!auth.allowed) {
    // The callback is denied here, on the server. A forged or replayed payload
    // gets no message, no gift URL and no hint about what lives behind it.
    await answerCallback(api, {
      callback_query_id: query.id,
      text: TEXTS.callbackNotAllowed,
      show_alert: false,
    });
    return { handled: true, reason: 'unauthorized', allowed: false };
  }

  const chatId = query.message.chat.id;
  const data = typeof query.data === 'string' ? query.data : '';

  switch (data) {
    case CALLBACKS.menu: {
      const shouldSend = await support.shouldSendStep(query.from.id, STEP_ONE);
      await answerCallback(api, { callback_query_id: query.id });
      if (!shouldSend) return { handled: true, allowed: true, action: 'menu-cooldown' };

      const sent = await sendMessage(
        api,
        baseMessage(chatId, MENU_STEP_ONE, { reply_markup: chooseKeyboard() }),
      );
      if (sent) await support.recordStep(query.from.id, STEP_ONE, sent.message_id);
      return { handled: true, allowed: true, action: 'menu-1', sent: Boolean(sent) };
    }

    case CALLBACKS.date: {
      const shouldSend = await support.shouldSendStep(query.from.id, STEP_TWO);
      await answerCallback(api, { callback_query_id: query.id });
      if (!shouldSend) return { handled: true, allowed: true, action: 'date-cooldown' };

      let keyboard = pendingGiftKeyboard();
      let url = null;
      try {
        const base = await support.getMiniAppBaseUrl();
        if (base) {
          url = giftUrl(base);
          keyboard = giftKeyboard(url);
        }
      } catch (error) {
        console.error('[bot] Mini App URL lookup failed', error);
      }

      const sent = await sendMessage(
        api,
        baseMessage(chatId, ANNIVERSARY_INTRO, { reply_markup: keyboard }),
      );
      if (sent) await support.recordStep(query.from.id, STEP_TWO, sent.message_id);
      return {
        handled: true,
        allowed: true,
        action: 'menu-2',
        sent: Boolean(sent),
        hasGiftUrl: Boolean(url),
      };
    }

    case CALLBACKS.pendingGift: {
      await answerCallback(api, {
        callback_query_id: query.id,
        text: TEXTS.pendingGift,
        show_alert: true,
      });
      return { handled: true, allowed: true, action: 'gift-pending' };
    }

    default: {
      await answerCallback(api, {
        callback_query_id: query.id,
        text: TEXTS.wrongDoor,
        show_alert: false,
      });
      return { handled: true, allowed: true, action: 'unknown' };
    }
  }
}
