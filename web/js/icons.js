/* Frozen Blooded — original SVG icon system.
   Every glyph is hand-drawn here (no emoji, no icon fonts, no external assets).
   Stroke icons inherit currentColor; artwork is framed by CSS. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FBIcons = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  // ---- 24x24 line icons -------------------------------------------------------
  const ICONS = {
    logo: '<path d="M12 2.4v19.2M3.7 7.2l16.6 9.6M20.3 7.2 3.7 16.8"/><circle cx="12" cy="12" r="3.2"/><circle cx="12" cy="12" r="1.1" fill="currentColor" stroke="none"/>',
    home: '<path d="M3.4 11.2 12 3.8l8.6 7.4"/><path d="M5.9 10.6V20h12.2v-9.4"/><path d="M9.8 20v-5.1h4.4V20"/>',
    coin: '<circle cx="12" cy="12" r="8.6"/><path d="M12 7.4c2.9 1.5 2.9 4.4 0 5.9-2.9-1.5-2.9-4.4 0-5.9z"/><path d="M12 13.3V17"/>',
    chakra: '<path d="M12 21.2a9.2 9.2 0 1 0-9.2-9.2 6.7 6.7 0 0 0 6.7 6.7 4.4 4.4 0 0 0 4.4-4.4 2.2 2.2 0 0 0-2.2-2.2"/>',
    streak: '<path d="M12.6 2.6c1.2 3.4-.4 5.2-1.1 7.2-.7-1.1-1.5-2.4-1.4-4.2-1.5 1.7-3.6 4.2-3.6 7.6A6.5 6.5 0 0 0 19 13.2c0-2.4-1.4-4.3-2.8-5.9.2 1.7-.3 2.7-1.1 3.3 1.1-3.3-.6-6-2.5-8z"/>',
    profile: '<path d="M12 3.4c3.7 0 5.6 2.7 5.6 6.4v2.4l1.8 4.6H4.6l1.8-4.6V9.8c0-3.7 1.9-6.4 5.6-6.4z"/><path d="M6.8 13.6h10.4"/><circle cx="9.8" cy="11.2" r=".9" fill="currentColor" stroke="none"/><circle cx="14.2" cy="11.2" r=".9" fill="currentColor" stroke="none"/>',
    inventory: '<path d="M6.2 8.2h11.6L16.7 20.4H7.3z"/><path d="M9.2 8.2V6.4a2.8 2.8 0 0 1 5.6 0v1.8"/><path d="M10.4 12.6h3.2"/>',
    store: '<path d="M3.2 6.2h17.6M5.6 6.2V20M18.4 6.2V20M4.4 3.6h15.2M7.2 10.8h9.6"/>',
    ability: '<path d="M2.6 12S6.2 6.4 12 6.4 21.4 12 21.4 12 17.8 17.6 12 17.6 2.6 12 2.6 12z"/><circle cx="12" cy="12" r="2.6"/><circle cx="12" cy="8.4" r=".8" fill="currentColor" stroke="none"/><circle cx="9.1" cy="13.9" r=".8" fill="currentColor" stroke="none"/><circle cx="14.9" cy="13.9" r=".8" fill="currentColor" stroke="none"/>',
    gift: '<path d="M4.4 9.4h15.2v10.2H4.4zM3.4 9.4h17.2M12 9.4v10.2"/><path d="M8.6 9.2c-1.7-1.2-2.9-3-1.7-3.9 1-.8 2.7.6 5.1 3.9M15.4 9.2c1.7-1.2 2.9-3 1.7-3.9-1-.8-2.7.6-5.1 3.9"/>',
    map: '<path d="M3.2 6.6 9 4.4l6 2.2 5.8-2.2v13l-5.8 2.2-6-2.2-5.8 2.2z"/><path d="M9 4.4v13M15 6.6v13"/>',
    more: '<path d="M4.4 4.4h5.2v5.2H4.4zM14.4 4.4h5.2v5.2h-5.2zM4.4 14.4h5.2v5.2H4.4zM14.4 14.4h5.2v5.2h-5.2z"/>',
    feedback: '<path d="M4 5.2h16v10.4h-8.4L7.2 19v-3.4H4z"/><path d="M8.6 9.6h6.8M8.6 12.4h4.2"/>',
    channel: '<path d="M4 9.6h3.2L12 6v12L7.2 14.4H4z"/><path d="M15.4 8.6a5.2 5.2 0 0 1 0 6.8M18.4 6a9 9 0 0 1 0 12"/>',
    claim: '<path d="M6.4 10.4h11.2V20H6.4zM5.2 10.4h13.6M12 10.4V20"/><path d="M12 10.4C10.7 7.6 9.2 6.2 8 7c-1.1.8-.1 2.7 4 3.4-4.1.7-5.1 2.6-4 3.4M12 10.4c1.3-2.8 2.8-4.2 4-3.4 1.1.8.1 2.7-4 3.4"/>',
    check: '<path d="M5 12.4 10 17.4 19.4 7"/>',
    lock: '<path d="M6.2 10.8h11.6V20H6.2zM8.8 10.8V8a3.2 3.2 0 0 1 6.4 0v2.8"/>',
    'chevron-right': '<path d="M9.2 4.8 16.4 12l-7.2 7.2"/>',
    'chevron-left': '<path d="M14.8 4.8 7.6 12l7.2 7.2"/>',
    refresh: '<path d="M19.6 12a7.6 7.6 0 1 1-2.2-5.4"/><path d="M19.6 3.8v4.8h-4.8"/>',
    spark: '<path d="M12 3.2 13.9 9l5.8 1.9-5.8 1.9L12 18.6l-1.9-5.8L4.3 10.9 10.1 9z"/>',
    shield: '<path d="M12 3 19 6v6.2c0 4-3 7-7 8.8-4-1.8-7-4.8-7-8.8V6z"/><path d="M9 11.8l2.2 2.2 4-4.2"/>',
    kunai: '<path d="M12 2.8 15 9l-3 2.2L9 9z"/><path d="M12 11.2v6.6M10.4 20.4h3.2M12 17.8v2.6"/>',
    trophy: '<path d="M8 4.8h8v4.4a4 4 0 0 1-8 0z"/><path d="M8 6.2H5v1.6a3 3 0 0 0 3 3M16 6.2h3v1.6a3 3 0 0 1-3 3M12 13.2v4M9 20h6"/>',
    paw: '<circle cx="7.6" cy="9" r="1.8"/><circle cx="12" cy="7.2" r="1.8"/><circle cx="16.4" cy="9" r="1.8"/><path d="M12 12.2c2.6 0 4.4 1.8 4.4 3.8S14.6 19 12 19s-4.4-1-4.4-3 1.8-3.8 4.4-3.8z"/>',
    info: '<circle cx="12" cy="12" r="8.6"/><path d="M12 11v6"/><circle cx="12" cy="8" r=".9" fill="currentColor" stroke="none"/>',
    external: '<path d="M13.6 4.4h6v6"/><path d="M19.6 4.4 11 13"/><path d="M10 5.2H5.2v13.6h13.6V14"/>',
    alert: '<path d="M12 3.6 21 19.6H3z"/><path d="M12 9v5"/><circle cx="12" cy="17" r=".9" fill="currentColor" stroke="none"/>',
    users: '<circle cx="9.2" cy="9" r="3"/><path d="M3.6 19.4c0-2.8 2.5-4.6 5.6-4.6s5.6 1.8 5.6 4.6"/><path d="M15.6 6.4a3 3 0 0 1 0 5.8M17.4 14.2c2 .5 3.4 2 3.4 4"/>',
    clock: '<circle cx="12" cy="12" r="8.6"/><path d="M12 7.4V12l3.2 2"/>',
    swords: '<path d="M4.4 4.4 16 16M16 16l-1.6 3.2-2.4-2.4 3.2-1.6zM19.6 4.4 8 16M8 16l1.6 3.2 2.4-2.4-3.2-1.6z"/>',
    close: '<path d="M6 6l12 12M18 6 6 18"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    minus: '<path d="M5 12h14"/>',
    play: '<path d="M7.4 4.8 19 12 7.4 19.2z"/>',
    dot: '<circle cx="12" cy="12" r="3.4" fill="currentColor" stroke="none"/>',
    star: '<path d="M12 3.4l2.6 5.6 6.1.8-4.5 4.2 1.2 6-5.4-3-5.4 3 1.2-6L3.3 9.8l6.1-.8z"/>',
  };

  // ---- 48x48 artwork ----------------------------------------------------------
  const stroke = 'fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"';
  const fill = 'fill="currentColor" ';
  const soft = 'fill="currentColor" opacity=".16"';

  const ART = {
    mask: `<path d="M24 6c9 0 14 6 14 14v6l4 12H6l4-12v-6C10 12 15 6 24 6z" ${soft}/><path d="M24 6c9 0 14 6 14 14v6l4 12H6l4-12v-6C10 12 15 6 24 6z" ${stroke}/><path d="M11 27h26" ${stroke}/><circle cx="19" cy="21.5" r="2.2" ${fill}/><circle cx="29" cy="21.5" r="2.2" ${fill}/>`,
    sasuke: `<path d="M8 8 24 40 40 8 30 18 24 10 18 18z" ${soft}/><path d="M8 8 24 40 40 8 30 18 24 10 18 18z" ${stroke}/><path d="M24 18v22" ${stroke}/><circle cx="24" cy="13" r="2" ${fill}/>`,
    sakura: `<circle cx="24" cy="24" r="5.4" ${soft}/><circle cx="24" cy="24" r="5.4" ${stroke}/><path d="M24 8c4 5 4 8 0 10-4-2-4-5 0-10zM40 24c-5 4-8 4-10 0 2-4 5-4 10 0zM24 40c-4-5-4-8 0-10 4 2 4 5 0 10zM8 24c5-4 8-4 10 0-2 4-5 4-10 0z" ${stroke}/>`,
    naruto: `<circle cx="24" cy="24" r="16" ${soft}/><circle cx="24" cy="24" r="16" ${stroke}/><path d="M24 24c0-6 5-9 9-7-2 5-5 9-9 9" ${stroke}/><path d="M24 24c6 0 9 5 7 9-5-2-9-5-9-9" ${stroke}/><circle cx="24" cy="24" r="2.6" ${fill}/>`,
    itachi: `<path d="M5 24s7.5-10 19-10 19 10 19 10-7.5 10-19 10S5 24 5 24z" ${soft}/><path d="M5 24s7.5-10 19-10 19 10 19 10-7.5 10-19 10S5 24 5 24z" ${stroke}/><circle cx="24" cy="24" r="6" ${stroke}/><circle cx="24" cy="24" r="2" ${fill}/><circle cx="24" cy="15.4" r="1.8" ${fill}/><circle cx="17" cy="28.4" r="1.8" ${fill}/><circle cx="31" cy="28.4" r="1.8" ${fill}/>`,
    hinata: `<circle cx="24" cy="24" r="18" ${soft}/><circle cx="24" cy="24" r="18" ${stroke}/><circle cx="24" cy="24" r="11" ${stroke}/><circle cx="24" cy="24" r="4.4" ${stroke}/><path d="M9 9 39 39M39 9 9 39" ${stroke} opacity=".35"/>`,
    jiraiya: `<path d="M12 18c0-6 5-10 12-10s12 4 12 10-5 10-12 10-12-4-12-10z" ${soft}/><path d="M12 18c0-6 5-10 12-10s12 4 12 10-5 10-12 10-12-4-12-10z" ${stroke}/><circle cx="19" cy="17" r="2.2" ${fill}/><circle cx="29" cy="17" r="2.2" ${fill}/><path d="M18 26c3 2 9 2 12 0M8 38c6-4 26-4 32 0" ${stroke}/>`,
    jutsu: `<circle cx="24" cy="24" r="6" ${soft}/><circle cx="24" cy="24" r="6" ${stroke}/><path d="M24 12a12 12 0 0 1 0 24M24 6a18 18 0 0 1 0 36M24 2a22 22 0 0 1 0 44" ${stroke} opacity=".7"/><path d="M12 24h-6M18 24h12" ${stroke} opacity=".4"/>`,
    chakra: `<path d="M24 5c6 8 10 13 10 19a10 10 0 0 1-20 0c0-5 3-8 5-10 0 5 2 7 4 8 2-6-2-11 1-17z" ${soft}/><path d="M24 5c6 8 10 13 10 19a10 10 0 0 1-20 0c0-5 3-8 5-10 0 5 2 7 4 8 2-6-2-11 1-17z" ${stroke}/><path d="M24 42v3" ${stroke}/>`,
    rose: `<path d="M24 26c-6 0-9-4-9-8s4-8 9-8 9 4 9 8-3 8-9 8z" ${soft}/><path d="M24 26c-6 0-9-4-9-8s4-8 9-8 9 4 9 8-3 8-9 8z" ${stroke}/><path d="M24 18c-2.4 0-4 1.4-4 3.2s1.6 3.2 4 3.2 4-1.4 4-3.2S26.4 18 24 18z" ${stroke}/><path d="M24 26v16M24 34c-4-3-6-4-9-3M24 31c4-3 6-3 9-2" ${stroke}/>`,
    ramen: `<path d="M10 24h28a14 14 0 0 1-28 0z" ${soft}/><path d="M10 24h28a14 14 0 0 1-28 0z" ${stroke}/><path d="M16 24c0-6 3-9 8-9s8 3 8 9" ${stroke}/><path d="M14 38h20" ${stroke}/><path d="M30 14 36 6M34 16 40 10" ${stroke}/>`,
    peanuts: `<ellipse cx="18" cy="20" rx="7" ry="9" ${soft}/><ellipse cx="18" cy="20" rx="7" ry="9" ${stroke}/><ellipse cx="30" cy="30" rx="7" ry="9" ${soft}/><ellipse cx="30" cy="30" rx="7" ry="9" ${stroke}/><path d="M14 15c2 2 6 2 8 0M26 25c2 2 6 2 8 0" ${stroke} opacity=".6"/>`,
    puppy: `<path d="M12 16c-3 2-4 8-2 14 3 5 9 8 14 8s11-3 14-8c2-6 1-12-2-14" ${soft}/><path d="M12 16c-3 2-4 8-2 14 3 5 9 8 14 8s11-3 14-8c2-6 1-12-2-14" ${stroke}/><circle cx="19" cy="28" r="2" ${fill}/><circle cx="29" cy="28" r="2" ${fill}/><path d="M24 32v3M21 36c2 2 4 2 6 0" ${stroke}/><path d="M14 16l-3-6 6 2M34 16l3-6-6 2" ${stroke}/>`,
    butterfly: `<path d="M24 24c-5-9-12-12-15-8-3 5 3 12 11 12-8 0-13 5-11 9 2 5 10 2 15-9" ${soft}/><path d="M24 24c5-9 12-12 15-8 3 5-3 12-11 12 8 0 13 5 11 9-2 5-10 2-15-9" ${soft}/><path d="M24 24c-5-9-12-12-15-8-3 5 3 12 11 12-8 0-13 5-11 9 2 5 10 2 15-9zM24 24c5-9 12-12 15-8 3 5-3 12-11 12 8 0 13 5 11 9-2 5-10 2-15-9z" ${stroke}/><path d="M24 16v18" ${stroke}/>`,
    hat: `<path d="M10 26h28c0-8-6-14-14-14S10 18 10 26z" ${soft}/><path d="M10 26h28c0-8-6-14-14-14S10 18 10 26z" ${stroke}/><path d="M6 30c8 4 28 4 36 0" ${stroke}/><path d="M12 26h24" ${stroke} opacity=".6"/>`,
    rasengan: `<circle cx="24" cy="24" r="16" ${soft}/><circle cx="24" cy="24" r="16" ${stroke}/><path d="M24 24c-6 0-9-4-8-8 5 0 8 3 8 8zM24 24c0-6 4-9 8-8 0 5-3 8-8 8zM24 24c6 0 9 4 8 8-5 0-8-3-8-8zM24 24c0 6-4 9-8 8 0-5 3-8 8-8z" ${stroke}/>`,
    chidori: `<path d="M28 4 14 26h9l-3 18 16-24h-9z" ${soft}/><path d="M28 4 14 26h9l-3 18 16-24h-9z" ${stroke}/><path d="M6 12l6 3M38 36l5 3M8 36l5-3" ${stroke} opacity=".6"/>`,
    ring: `<circle cx="24" cy="28" r="12" ${soft}/><circle cx="24" cy="28" r="12" ${stroke}/><circle cx="24" cy="28" r="4" ${stroke}/><path d="M17 12h14l-3-6H20z" ${stroke}/>`,
    sharingan: `<circle cx="24" cy="24" r="17" ${soft}/><circle cx="24" cy="24" r="17" ${stroke}/><circle cx="24" cy="24" r="11" ${stroke}/><circle cx="24" cy="24" r="3" ${fill}/><circle cx="24" cy="14" r="2.4" ${fill}/><circle cx="15.4" cy="29" r="2.4" ${fill}/><circle cx="32.6" cy="29" r="2.4" ${fill}/>`,
    star: `<path d="M24 5l5.6 12.4L43 19l-9.8 9 2.4 13L24 34.8 12.4 41l2.4-13L5 19l13.4-1.6z" ${soft}/><path d="M24 5l5.6 12.4L43 19l-9.8 9 2.4 13L24 34.8 12.4 41l2.4-13L5 19l13.4-1.6z" ${stroke}/>`,
    swords: `<path d="M10 6 34 38M34 38l-8 1 1-8M38 6 14 38M14 38l8 1-1-8" ${stroke}/><path d="M8 34l6 6M40 34l-6 6" ${stroke} opacity=".6"/>`,
    crate: `<path d="M8 14h32v26H8z" ${soft}/><path d="M8 14h32v26H8z" ${stroke}/><path d="M8 22h32M24 14v26" ${stroke} opacity=".6"/>`,
    village: `<path d="M4 42h40" ${stroke}/><path d="M8 42V26l6-5 6 5v16M26 42V22l7-6 7 6v20" ${stroke}/><path d="M20 42v-9h4v9M33 42v-8h4v8" ${stroke}/><path d="M24 4v8M20 7h8" ${stroke} opacity=".5"/>`,
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

  const SHINOBI = {
    'starter shinobi': 'mask',
    sasuke: 'sasuke',
    sakura: 'sakura',
    naruto: 'naruto',
    itachi: 'itachi',
    hinata: 'hinata',
    jiraiya: 'jiraiya',
  };

  function clean(value) {
    return String(value == null ? '' : value).trim().toLowerCase();
  }

  /** Map an item name/type from the bot payload to an artwork key. */
  function artName(name, type) {
    const key = clean(name);
    if (SHINOBI[key]) return SHINOBI[key];
    if (GIFTS[key]) return GIFTS[key];
    if (key.indexOf('chakra') === 0) return 'chakra';
    if (key.indexOf('mind transmission') === 0) return 'jutsu';
    if (key.indexOf('rose') >= 0) return 'rose';
    const t = clean(type);
    if (t === 'shinobi' || t === 'character') return 'mask';
    if (t === 'gift') return 'crate';
    if (t === 'jutsu') return 'jutsu';
    if (t === 'chakra') return 'chakra';
    return 'crate';
  }

  // Use native, full-colour emoji across the Mini App instead of monochrome SVG logos.
  const EMOJI = {
    logo: '❄️', home: '🏠', coin: '🪙', chakra: '🔮', streak: '🔥',
    profile: '👤', inventory: '🎒', store: '🏪', ability: '✨', gift: '🎁',
    map: '🗺️', more: '📱', feedback: '💬', channel: '📢', claim: '🎁',
    check: '✅', lock: '🔒', 'chevron-right': '›', 'chevron-left': '‹',
    refresh: '🔄', spark: '✨', shield: '🛡️', kunai: '🗡️', trophy: '🏆',
    paw: '🐾', info: 'ℹ️', external: '🔗', alert: '⚠️', users: '👥',
    clock: '🕒', swords: '⚔️', close: '✖️', plus: '➕', minus: '➖',
    play: '▶️', dot: '⚫', star: '⭐'
  };
  const ART_EMOJI = {
    mask: '👻', sasuke: '⚡', sakura: '🌸', naruto: '🍥', itachi: '👁️',
    hinata: '👀', jiraiya: '🐸', jutsu: '🌀', chakra: '🔮', rose: '🌹',
    ramen: '🍜', peanuts: '🥜', puppy: '🐶', butterfly: '🦋', hat: '👒',
    rasengan: '🔵', chidori: '⚡', ring: '💍', sharingan: '👁️',
    star: '⭐', swords: '⚔️', crate: '🎁', village: '🏘️'
  };

  function icon(name, cls) {
    const emoji = EMOJI[name] || '✨';
    return '<span class="ico emoji-icon' + (cls ? ' ' + cls : '') + '" aria-hidden="true">' + emoji + '</span>';
  }

  function art(name, cls) {
    const emoji = ART_EMOJI[name] || '🎁';
    return '<span class="art emoji-art' + (cls ? ' ' + cls : '') + '" aria-hidden="true">' + emoji + '</span>';
  }

  /** DOM-safe emoji builder for screens that may not use innerHTML. */
  function svgNode(name, cls) {
    const doc = typeof document !== 'undefined' ? document : null;
    if (!doc || typeof doc.createElement !== 'function') return null;
    const node = doc.createElement('span');
    node.setAttribute('aria-hidden', 'true');
    node.setAttribute('class', 'ico emoji-icon' + (cls ? ' ' + cls : ''));
    node.textContent = EMOJI[name] || '✨';
    return node;
  }

  function has(name) {
    return Object.prototype.hasOwnProperty.call(ICONS, name);
  }

  /** DOM-safe SVG builder for screens that may not use innerHTML. */
  function svgNode(name, cls) {
    const doc = typeof document !== 'undefined' ? document : null;
    if (!doc || typeof doc.createElementNS !== 'function') {
      const fallback = doc && typeof doc.createElement === 'function' ? doc.createElement('span') : null;
      if (fallback) fallback.className = 'ico-fallback' + (cls ? ' ' + cls : '');
      return fallback;
    }
    const NS = 'http://www.w3.org/2000/svg';
    const node = doc.createElementNS(NS, 'svg');
    node.setAttribute('viewBox', '0 0 24 24');
    node.setAttribute('aria-hidden', 'true');
    node.setAttribute('focusable', 'false');
    if (cls) node.setAttribute('class', 'ico ' + cls);
    else node.setAttribute('class', 'ico');
    // Paths are authored in this file only — never user input.
    node.innerHTML = ICONS[name] || ICONS.spark;
    return node;
  }

  return { ICONS, ART, icon, art, artName, has, svgNode, iconNames: Object.keys(EMOJI) };
});
