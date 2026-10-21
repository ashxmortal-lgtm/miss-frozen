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

export default async function (cq) {
  if (await handleSupportCallback(cq)) return;
  // Combat callbacks first so no other handler can claim or delay them.
  if (isCloneCallback(cq.data)) return handleCloneCallback(cq);
  if (isByakuganCallback(cq.data)) return handleByakuganCallback(cq);
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
  try { await api.answerCallbackQuery({ callback_query_id: cq.id }); } catch (_) {}
}
