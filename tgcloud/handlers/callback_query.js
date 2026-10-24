// MissFrozen (Gaming) callbacks only. Unknown/study callbacks fail safely.
import { api } from '../lib/message_api.js';
import { handleEconomyCallback } from '../lib/economy_handler.js';
import { handleGroupAdminCallback } from '../lib/groupadmin.js';
import { handleAnnounceCallback } from '../lib/announce.js';
import { handleReactionCallback } from '../lib/replybridge.js';
import { handleOwnerCallback } from '../lib/owner_cmds.js';
import { handleWelcomeCallback } from '../lib/welcome_ui.js';
import { handleGiftCallback } from '../lib/gift.js';
import { handleInventoryCallback } from '../lib/inventory.js';
import {
  handleCloneCallback, isCloneCallback, handleByakuganCallback, isByakuganCallback,
} from '../lib/rpg/combat.js';
import { handleGamesCallback, isGamesCallback } from '../lib/games/handler.js';
import { handleMapCallback, isMapCallback } from '../lib/map/handler.js';
import { handleSupportCallback } from '../lib/support_inbox.js';
import { handlePetCallback } from '../lib/pet/ui.js';
import { restorePetsOnFirstInteraction } from '../lib/pet/migration.js';

export default async function (cq) {
  // First interaction can be a button tap: restore legacy pets before routing.
  if (cq?.from && !cq.from.is_bot) {
    try {
      await restorePetsOnFirstInteraction(cq.from.id, {
        notify: { user: cq.from, chatId: cq.message?.chat?.id },
      });
    } catch (e) {
      console.error('[pet migration hook]', e);
    }
  }
  // A button that never acknowledges leaves a spinner on the user's screen, and
  // a throw before the ack made taps look completely dead (pet Play was hit by
  // exactly that). Every path below therefore answers, no matter what happens.
  const ack = async (text, alert = false) => {
    try {
      await api.answerCallbackQuery({
        callback_query_id: cq.id, ...(text ? { text, show_alert: alert } : {}),
      });
    } catch (_) { /* stale callback ids are harmless */ }
  };

  try {
    if (await handleSupportCallback(cq)) return;
    // Combat callbacks first so no other handler can claim or delay them.
    if (isCloneCallback(cq.data)) return handleCloneCallback(cq);
    if (isByakuganCallback(cq.data)) return handleByakuganCallback(cq);
    if (await handlePetCallback(cq)) return;
    if (isMapCallback(cq.data)) {
      const handled = await handleMapCallback(cq);
      if (handled) return;
    }
    if (isGamesCallback(cq.data)) {
      const handled = await handleGamesCallback(cq);
      if (handled) return;
    }
    if (await handleGroupAdminCallback(cq)) return;
    if (await handleAnnounceCallback(cq)) return;
    if (await handleReactionCallback(cq)) return;
    if (await handleOwnerCallback(cq)) return;
    if (await handleWelcomeCallback(cq)) return;
    if (await handleGiftCallback(cq)) return;
    if (await handleInventoryCallback(cq)) return;
    if (await handleEconomyCallback(cq)) return;
    // Unsupported callback (e.g. a study button): acknowledge, never crash.
    await ack();
  } catch (e) {
    console.error('[callback_query]', e);
    await ack('⚠️ Something went wrong — please try again.', true);
  }
}
