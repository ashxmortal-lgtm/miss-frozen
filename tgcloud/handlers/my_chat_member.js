import { notifyGroupAdded, notifyBlockedOrRemoved } from '../lib/ownernotice.js';
import { ensureMtEphemeralCommand } from '../lib/mt.js';

// Bot's own membership changes (added/removed from group, blocked in private, ...)
export default async function (update) {
  // Register /mt as an ephemeral group command as soon as the bot joins a group,
  // so the very first /mt is already delivered as an ephemeral message.
  try { await ensureMtEphemeralCommand(); } catch (e) { console.error('[mt menu]', e); }
  await notifyGroupAdded(update);
  await notifyBlockedOrRemoved(update);
}
