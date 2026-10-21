import { api } from 'sdk';
import { access } from '../lib/access_production.js';
import { createSdkStore } from '../lib/store.js';
import { createBotSupport } from '../lib/bot/support.js';
import { routeMessage } from '../lib/bot/message_router.js';

const store = createSdkStore();
const support = createBotSupport(store);

/**
 * Telegram Message handler. The platform passes `update.message` as the first
 * argument and the full Update as ctx.update.
 */
export default async function (message, ctx) {
  try {
    return await routeMessage(message, ctx, { api, access, support, store });
  } catch (error) {
    // Never let an unexpected exception echo internal details to Telegram.
    console.error('[message] unhandled', error);
    return { handled: false, reason: 'internal-error' };
  }
}
