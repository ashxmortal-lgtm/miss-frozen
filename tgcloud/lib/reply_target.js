/**
 * Reply threading: every command reply is sent as a reply to the message that
 * triggered it.
 *
 * The inbound command is remembered per chat; outgoing sendMessage /
 * sendRichMessage calls without an explicit reply_parameters reply to it while
 * the entry is fresh. Background sends (e.g. finished-activity reminders) opt
 * out by passing `disable_reply_target: true` in the payload.
 *
 * The platform isolates have no request context, so this is a small per-chat
 * registry instead of AsyncLocalStorage.
 */
const TTL_MS = 60_000;
const targets = new Map();

/** Remember an incoming command message for the next 60s. */
export function rememberInbound(message) {
  const chatId = message?.chat?.id;
  const messageId = message?.message_id;
  if (chatId == null || !messageId) return;
  const now = Date.now();
  targets.set(String(chatId), { messageId, at: now });
  if (targets.size > 500) {
    const cutoff = now - TTL_MS;
    for (const [key, entry] of targets) if (entry.at < cutoff) targets.delete(key);
  }
}

/** reply_parameters for a send to this chat (null when nothing is fresh). */
export function replyParametersFor(chatId, now = Date.now()) {
  if (chatId == null) return null;
  const entry = targets.get(String(chatId));
  if (!entry || now - entry.at > TTL_MS) return null;
  return { message_id: entry.messageId, allow_sending_without_reply: true };
}

/** Test/reset hook. */
export function forgetReplyTargets() {
  targets.clear();
}
