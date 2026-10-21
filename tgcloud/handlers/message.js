// MissFrozen (Gaming) message router. Study commands are not registered here:
// messages for ExFrozen-only commands fall through and are ignored silently.
import { api } from '../lib/message_api.js';
import { handleEconomyCommand } from '../lib/economy_handler.js';
import { handleGroupAdminCommand, economyLocked, ECO_LOCKED_TEXT } from '../lib/groupadmin.js';
import { notifyNewUser } from '../lib/ownernotice.js';
import { handleAnnounceCommand, handleAnnounceText } from '../lib/announce.js';
import { handleGroupReplyToBot, handleAdminDmReply } from '../lib/replybridge.js';
import { handleOwnerCommand } from '../lib/owner_cmds.js';
import { handleMtCommand } from '../lib/mt.js';
import { handleGiftCommand } from '../lib/gift.js';
import { handleSocialCommand } from '../lib/social.js';
import {
  handleXoxoCommand,
  handleRpsCommand,
  handleGamesCommand,
  handleCancelCommand,
  handleStatsCommand,
  handleCustomStakeText,
} from '../lib/games/handler.js';
import { handleMapCommand, mapSweep } from '../lib/map/handler.js';
import { handleSupportCommand, handleSupportMessage, handleSupportAdminReply } from '../lib/support_inbox.js';
import { handleCouponWizardText } from '../lib/coupons.js';
import { sweepClones } from '../lib/rpg/combat.js';

export default async function (message, ctx) {
  // Serverless has no setTimeout; resolve due Shadow Clone attacks on update.
  try { await sweepClones(); } catch (e) { console.error('[clone sweep]', e); }

  // Fixed, whitelisted deep-link payloads from the Mini App.
  if (message.chat?.type === 'private') {
    const start = String(message.text || '').trim().match(/^\/start(?:@\w+)?\s+(mini_map|mini_owner|owner)$/i);
    const key = start && start[1].toLowerCase();
    if (key === 'mini_owner' || key === 'owner') {
      await handleSupportCommand({ ...message, text: '/owner' });
      return;
    }
    if (key === 'mini_map') {
      await handleMapCommand({ ...message, text: '/map' });
      return;
    }
  }

  if (await handleSupportCommand(message)) return;
  if (await handleCouponWizardText(message)) return;
  if (await handleSupportAdminReply(message)) return;
  const supportMessageHandled = await handleSupportMessage(message);
  if (supportMessageHandled && message.chat?.type === 'private') return;

  await notifyNewUser(message);

  const gameCmd = (message.text || '')
    .trim()
    .split(/\s+/)[0]
    .split('@')[0]
    .replace(/^\/+/, '')
    .toLowerCase();

  if (gameCmd === 'xoxo_cancel' || gameCmd === 'cancel_xoxo' || gameCmd === 'rps_cancel' || gameCmd === 'cancel_rps') {
    return await handleCancelCommand(message);
  }

  if (await handleGroupReplyToBot(message)) return;
  if (await handleAdminDmReply(message)) return;
  if (await handleAnnounceText(message)) return;

  try {
    if (await handleCustomStakeText(message)) return;
  } catch (e) {
    console.error(e);
  }

  if (await handleAnnounceCommand(message)) return; // /ow_announce only
  if (await handleOwnerCommand(message)) return;
  if (await handleMtCommand(message)) return;

  // When /eco is off in a group, lock the extra economy-related commands.
  if (message.chat?.type !== 'private') {
    const ecoExtra = new Set([
      'map', 'gift', 'gift_store', 'hug', 'slap', 'punch', 'pat',
      'xoxo', 'rps', 'games', 'xoxo_stats', 'rps_stats',
    ]);
    if (ecoExtra.has(gameCmd)) {
      let locked = false;
      try { locked = await economyLocked(message.chat.id); } catch (_) {}
      if (locked) {
        try {
          await api.sendMessage({
            chat_id: message.chat.id,
            text: ECO_LOCKED_TEXT,
            reply_parameters: { message_id: message.message_id },
          });
        } catch (_) {}
        return;
      }
    }
  }

  if (await handleGiftCommand(message)) return;
  if (await handleSocialCommand(message)) return;

  if (gameCmd === 'xoxo') return await handleXoxoCommand(message);
  if (gameCmd === 'rps') return await handleRpsCommand(message);
  if (gameCmd === 'games') return await handleGamesCommand(message);
  if (gameCmd === 'xoxo_stats') return await handleStatsCommand(message, 'xoxo');
  if (gameCmd === 'rps_stats') return await handleStatsCommand(message, 'rps');

  const cmd = ((message.text || '').split(/[\s@]/)[0] || '').toLowerCase();
  if (cmd === '/map') {
    try { await mapSweep(message.from?.id); } catch (e) { console.error(e); }
    return await handleMapCommand(message);
  }

  if (await handleGroupAdminCommand(message)) return; // /eco
  await handleEconomyCommand(message, ctx);
}
