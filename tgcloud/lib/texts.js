export function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Our currency. Always use this instead of typing "coins".
export const COIN = 'Konoha coins 🍥';

const SC = {
  a: 'ᴀ', b: 'ʙ', c: 'ᴄ', d: 'ᴅ', e: 'ᴇ', f: 'ꜰ', g: 'ɢ', h: 'ʜ',
  i: 'ɪ', j: 'ᴊ', k: 'ᴋ', l: 'ʟ', m: 'ᴍ', n: 'ɴ', o: 'ᴏ', p: 'ᴘ',
  q: 'ǫ', r: 'ʀ', s: 'ꜱ', t: 'ᴛ', u: 'ᴜ', v: 'ᴠ', w: 'ᴡ', x: 'x',
  y: 'ʏ', z: 'ᴢ',
};

// Keep embedded links, code, HTML, entities, URLs, @usernames, and /commands.
const KEEP = /<a\b[^>]*>[\s\S]*?<\/a>|<code>[\s\S]*?<\/code>|\[[^\]\n]*\]\((?:\\.|[^)\n])+\)|<[^>]+>|&[a-z#0-9]+;|\b(?:https?|ftp|tg):\/\/[^\s<>]+|\bmailto:[^\s<>]+|\b(?:www\.|t\.me\/|telegram\.me\/)[^\s<>]+|\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s<>]*)?|@\w+|\/\w+/gi;

function convert(s) {
  return s.replace(/[a-z]/gi, (c) => SC[c.toLowerCase()] ?? c);
}

export function style(html) {
  let out = '';
  let last = 0;
  for (const m of html.matchAll(KEEP)) {
    out += convert(html.slice(last, m.index)) + m[0];
    last = m.index + m[0].length;
  }
  return out + convert(html.slice(last));
}

export function mention(user) {
  const name = escapeHtml(user.first_name || 'User');
  return `<a href="tg://user?id=${user.id}">${name}</a>`;
}


// Mention on the first line, blank line, then the content, in the bot font.
export function render(user, body) {
  return style(`${mention(user)}\n\n${body}`);
}
