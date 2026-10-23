/* Miss Frozen — native colour emoji icon system.
   Every UI glyph is a Unicode emoji rendered by the phone's own emoji font
   (Noto Color Emoji on Android, Apple Color Emoji on iOS). There are no SVG
   paths, icon fonts or external assets here, so nothing can render as a black
   monochrome silhouette. Names are stable keys used by app.js / profile.js. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FBIcons = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  // ---- UI icons ---------------------------------------------------------------
  const ICONS = {
    // brand & winter
    logo: '❄️', snow: '❄️', snowfall: '🌨️',
    // navigation & sections
    home: '🏠', inventory: '🎒', store: '🏪', ability: '✨', abilities: '✨',
    profile: '👤', gift: '🎁', gifts: '🎁', map: '🗺️', more: '📱',
    feedback: '💬', channel: '📢', settings: '⚙️',
    // stats & rewards
    coin: '🪙', chakra: '🔮', streak: '🔥', trophy: '🏆', star: '⭐',
    reward: '🎉', claim: '🎉', spark: '✨',
    // actions & states
    check: '✅', lock: '🔒', unlock: '🔓', plus: '➕', minus: '➖',
    close: '✖️', refresh: '🔄', external: '🔗', info: 'ℹ️', alert: '⚠️',
    clock: '🕒', play: '▶️', dot: '🔵',
    'chevron-right': '➡️', 'chevron-left': '⬅️',
    // shinobi world
    paw: '🐾', pet: '🐾', mission: '🎯', shinobi: '🥷', jutsu: '🌀',
    shield: '🛡️', swords: '⚔️', kunai: '🗡️', users: '👥', game: '🎮',
    // Konoha map locations
    hokage: '🏯', ramen: '🍜', bbq: '🍖', training: '🥋', hotsprings: '♨️', gate: '🛡️',
  };

  // ---- 48x48 artwork slots (inventory / store / roster) -----------------------
  // Mirrors the emojis the bot itself uses for shinobi, jutsu and gifts.
  const ART = {
    mask: '🥷', starter: '🥷',
    sasuke: '⚔️', sakura: '🌸', naruto: '🍥', itachi: '👁️', hinata: '👁️', jiraiya: '🐸',
    jutsu: '🧠', chakra: '🔮',
    rose: '🌹', ramen: '🍜', peanuts: '🥜', puppy: '🐕', butterfly: '🦋', hat: '👒',
    rasengan: '🌀', chidori: '⚡', ring: '💍', sharingan: '👁️', star: '⭐', swords: '⚔️',
    crate: '🎁', village: '🏘️', coin: '🪙', rank: '🏆',
  };

  // Longest key first so "starter shinobi" wins over "shinobi".
  const SHINOBI = {
    'starter shinobi': 'mask',
    sasuke: 'sasuke',
    sakura: 'sakura',
    naruto: 'naruto',
    itachi: 'itachi',
    hinata: 'hinata',
    jiraiya: 'jiraiya',
  };

  const GIFTS = {
    'konan\'s rose': 'rose',
    'ichiraku ramen': 'ramen',
    'anya\'s peanuts': 'peanuts',
    "akamaru (kiba's puppy)": 'puppy',
    'konan\'s paper butterfly': 'butterfly',
    'straw hat': 'hat',
    rasengan: 'rasengan',
    chidori: 'chidori',
    'akatsuki ring': 'ring',
    sharingan: 'sharingan',
    'starlight anya': 'star',
    'zoro\'s swords': 'swords',
  };

  function clean(value) {
    return String(value == null ? '' : value).trim().toLowerCase();
  }

  /** Escape text so a bot-provided emoji label can never inject markup. */
  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  /** Map an item name/type from the bot payload to an artwork key.
      Names may arrive with a bot emoji prefix, so the match is a substring. */
  function artName(name, type) {
    const key = clean(name);
    if (key) {
      const shinobi = Object.keys(SHINOBI).sort((a, b) => b.length - a.length)
        .find((n) => key.indexOf(n) >= 0);
      if (shinobi) return SHINOBI[shinobi];
      const gift = Object.keys(GIFTS).find((n) => key.indexOf(n) >= 0);
      if (gift) return GIFTS[gift];
      if (key.indexOf('chakra') >= 0) return 'chakra';
      if (key.indexOf('mind transmission') >= 0) return 'jutsu';
      if (key === 'rank' || key.indexOf('rank ') === 0) return 'rank';
      if (key.indexOf('rose') >= 0) return 'rose';
    }
    const t = clean(type);
    if (t === 'shinobi' || t === 'character') return 'mask';
    if (t === 'gift') return 'crate';
    if (t === 'jutsu') return 'jutsu';
    if (t === 'chakra') return 'chakra';
    return 'crate';
  }

  function glyph(name) {
    return Object.prototype.hasOwnProperty.call(ICONS, name) ? ICONS[name] : ICONS.spark;
  }

  function artwork(name) {
    return Object.prototype.hasOwnProperty.call(ART, name) ? ART[name] : ART.crate;
  }

  /** Markup for a named UI icon (always a colour emoji). */
  function icon(name, cls) {
    return '<span class="ico emoji-icon' + (cls ? ' ' + cls : '') + '" aria-hidden="true">'
      + glyph(name) + '</span>';
  }

  /** Markup for a named artwork slot (always a colour emoji). */
  function art(name, cls) {
    return '<span class="art emoji-art' + (cls ? ' ' + cls : '') + '" aria-hidden="true">'
      + artwork(name) + '</span>';
  }

  /** Markup for an emoji supplied by the bot (store, gifts, roster). */
  function emoji(value, cls) {
    const text = String(value == null ? '' : value).trim();
    if (!text) return '';
    return '<span class="ico emoji-icon' + (cls ? ' ' + cls : '') + '" aria-hidden="true">'
      + escapeHtml(text) + '</span>';
  }

  function span(cls, text) {
    const doc = typeof document !== 'undefined' ? document : null;
    if (!doc || typeof doc.createElement !== 'function') return null;
    const node = doc.createElement('span');
    node.className = cls;
    node.textContent = text;
    if (typeof node.setAttribute === 'function') node.setAttribute('aria-hidden', 'true');
    return node;
  }

  /** DOM-safe icon builder for screens that render without innerHTML. */
  function iconNode(name, cls) {
    return span('ico emoji-icon' + (cls ? ' ' + cls : ''), glyph(name));
  }

  /** DOM-safe builder for a bot-provided emoji. */
  function emojiNode(value, cls) {
    const text = String(value == null ? '' : value).trim();
    if (!text) return null;
    return span('ico emoji-icon' + (cls ? ' ' + cls : ''), text);
  }

  function artEmoji(name) {
    return artwork(name);
  }

  function has(name) {
    return Object.prototype.hasOwnProperty.call(ICONS, name);
  }

  return {
    ICONS, ART, icon, art, emoji, emojiNode, iconNode, artName, artEmoji, has,
    iconNames: Object.keys(ICONS),
  };
});
