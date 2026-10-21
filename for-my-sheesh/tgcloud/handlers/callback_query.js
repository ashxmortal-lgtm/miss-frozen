import { api } from 'sdk';
import { access } from '../lib/access_production.js';
import { createSdkStore } from '../lib/store.js';
import { createBotSupport } from '../lib/bot/support.js';
import { routeCallback } from '../lib/bot/callback_router.js';

const store = createSdkStore();
const support = createBotSupport(store);

/**
 * Telegram CallbackQuery handler. Every tap is re-authorized on the server;
 * callback data itself is never evidence of identity.
 */
export default async function (query, ctx) {
  try {
    return await routeCallback(query, ctx, { api, access, support, store });
  } catch (error) {
    console.error('[callback] unhandled', error);
    return { handled: false, reason: 'internal-error' };
  }
}
