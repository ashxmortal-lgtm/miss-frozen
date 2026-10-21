import { notifyGroupAdded, notifyBlockedOrRemoved } from '../lib/ownernotice.js';

// Bot's own membership changes (added/removed from group, blocked in private, ...)
export default async function (update) {
  await notifyGroupAdded(update);
  await notifyBlockedOrRemoved(update);
}
