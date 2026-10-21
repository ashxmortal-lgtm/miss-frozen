// Safe HTML for Telegram's `parse_mode: 'HTML'`. Telegram accepts a limited
// tag set; untrusted names are escaped and only the numeric sender ID is used
// to build the mention link. Message text is never interpreted as HTML.

const HTML_ESCAPES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);
}

/**
 * Build `<a href="tg://user?id=...">Name</a>` for a verified Telegram user.
 * Falls back to a neutral mention when no display name exists.
 *
 * @param {{id?: unknown, first_name?: unknown, username?: unknown}} from
 * @param {{fallback?: string}} [options]
 */
export function mentionHtml(from, options = {}) {
  const fallback = options.fallback ?? 'you';
  const id = from && typeof from === 'object' ? from.id : null;

  let name = '';
  if (from && typeof from.first_name === 'string') name = from.first_name.trim();
  if (!name && from && typeof from.username === 'string') name = from.username.trim();
  if (!name) name = fallback;

  // Cap length so a pathological display name cannot bloat a message.
  if (name.length > 64) name = `${name.slice(0, 63)}…`;

  if (typeof id === 'number' && Number.isSafeInteger(id) && id > 0) {
    return `<a href="tg://user?id=${id}">${escapeHtml(name)}</a>`;
  }
  return escapeHtml(name);
}

/** Substitute the single {mention} placeholder without touching other braces. */
export function fillMention(template, mention) {
  return template.replace('{mention}', mention);
}
