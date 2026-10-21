/**
 * Parse only the first command token of a private message.
 * `/grant@SomeBot 123` -> { name: 'grant', args: ['123'] }
 * Plain text -> null.
 */
export function parseCommand(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return null;

  const firstBreak = trimmed.search(/\s/);
  const token = firstBreak === -1 ? trimmed : trimmed.slice(0, firstBreak);
  const rest = firstBreak === -1 ? '' : trimmed.slice(firstBreak + 1);

  const name = token.slice(1).split('@')[0].toLowerCase();
  if (!/^[a-z0-9_]{1,32}$/.test(name)) return null;

  return {
    name,
    args: rest.trim() ? rest.trim().split(/\s+/) : [],
  };
}

/** Date-only display for /access; timestamps are unix seconds. */
export function formatGrantDate(seconds) {
  if (!Number.isFinite(seconds)) return 'unknown';
  const date = new Date(seconds * 1000);
  if (Number.isNaN(date.getTime())) return 'unknown';
  return date.toISOString().slice(0, 10);
}
