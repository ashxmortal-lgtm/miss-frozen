/* Frozen Blooded Mini App. Identity comes from verified Telegram init data. */
(function () {
  const C = window.FBContract;
  if (!C) return;

  const tg = window.Telegram && window.Telegram.WebApp;
  if (tg) {
    tg.ready();
    try { tg.expand(); } catch (_) {}
    try {
      tg.setHeaderColor('#122033');
      tg.setBackgroundColor('#0b1622');
    } catch (_) {}
  }

  const tgUser = tg && tg.initDataUnsafe && tg.initDataUnsafe.user;
  const state = {
    page: 'home',
    stack: [],
    data: null,
    profile: null,
    profileBusy: false,
    profileError: null,
    error: null,
    busy: false,
    classKey: '11',
    lastClaim: null,
    flash: '',
    confirm: null,
    drafts: {},
  };

  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
  const fmt = (v) => {
    if (v == null || v === '') return '—';
    const number = Number(v);
    return Number.isFinite(number) ? number.toLocaleString('en-US') : '—';
  };

  function serverlessAvailable() {
    const api = window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.Serverless;
    return !!(api && typeof api.call === 'function');
  }

  function serverlessCall(input, endpointName) {
    return new Promise((resolve, reject) => {
      const api = window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.Serverless;
      if (!api || typeof api.call !== 'function') {
        const error = new Error('Open this Mini App from the bot inside Telegram.');
        error.type = 'UNAVAILABLE';
        error.status = 0;
        reject(error);
        return;
      }
      api.call(endpointName || 'miniapp', input || { action: 'bootstrap' }, (err, result) => {
        if (err) {
          const error = new Error(err.message || 'The Mini App could not reach the bot.');
          error.type = err.type || '';
          error.status = Number(err.status || 0);
          error.parameters = err.parameters || null;
          reject(error);
          return;
        }
        resolve(C.unwrapPayload(result));
      });
    });
  }

  function takeDashboard(payload) {
    const data = C.unwrapPayload(payload);
    const dashboard = data && data.dashboard ? data.dashboard : data;
    if (!C.isDashboard(dashboard)) {
      const error = new Error('The bot returned an unexpected account payload.');
      error.type = 'BAD_PAYLOAD';
      throw error;
    }
    return { envelope: data, dashboard };
  }

  function displayName() {
    const fromAccount = state.data && state.data.profile && state.data.profile.displayName;
    if (fromAccount) return fromAccount;
    if (tgUser) return [tgUser.first_name, tgUser.last_name].filter(Boolean).join(' ');
    return '';
  }

  function initial() {
    const name = displayName() || 'F';
    return name.trim().charAt(0).toUpperCase() || 'F';
  }

  function errorHtml() {
    if (!state.error) return '';
    const code = state.error.parameters && state.error.parameters.code;
    let hint = 'Open the Mini App from the bot, then retry.';
    if (state.error.status === 401 || state.error.type === 'UNAUTHORIZED') {
      hint = 'Telegram did not verify this session.';
    } else if (state.error.type === 'ENDPOINT_ERROR' && code) {
      hint = 'The bot rejected this action (' + code + ').';
    }
    return '<div class="notice error"><strong>' + esc(state.error.message) + '</strong><div>' + esc(hint) + '</div><button class="secondary" data-action="retry">Retry</button></div>';
  }

  function loadingHtml(label) {
    return '<div class="loading"><span class="spinner"></span>' + esc(label || 'Syncing with the bot…') + '</div>';
  }

  function backBar(label) {
    return '<button class="back" data-action="back">← ' + esc(label || 'Back') + '</button>';
  }

  function pageHead(titleText, desc, back) {
    return backBar(back || 'Home')
      + '<h1>' + esc(titleText) + '</h1>'
      + (desc ? '<p class="lead">' + esc(desc) + '</p>' : '')
      + (state.busy ? '<div class="sync">Syncing with the bot…</div>' : '')
      + (state.flash ? '<div class="notice">' + esc(state.flash) + '</div>' : '');
  }

  function card(icon, name, desc, attrs) {
    return '<button class="item" ' + attrs + '><span class="item-icon">' + icon + '</span><span class="item-body"><strong>' + esc(name) + '</strong><small>' + esc(desc) + '</small></span><span class="arrow">›</span></button>';
  }

  function footer() {
    return '<p class="credit">created by <a href="https://t.me/frozenblooded" data-url="https://t.me/frozenblooded">𝑭𝒓❄️𝒛𝒆𝒏 𝑩𝒍𝒐𝒐𝒅𝒆𝒅</a></p>';
  }

  function shell(inner) {
    const isHome = state.page === 'home';
    return '<div class="shell' + (isHome ? ' shell-home' : '') + '">'
      + '<header class="top">' + botHeaderAvatarHtml()
      + '<div><div class="brand">Miss Fr❄️zen</div><div class="sub">synced with the bot</div></div></header>'
      + inner
      + footer()
      + '</div>';
  }

  function currentProfile() {
    return state.profile || (state.data && state.data.profile) || null;
  }

  // 🔴 Header: bot profile picture (always in sync via botAvatar data URI).
  function botHeaderAvatarHtml() {
    const p = currentProfile();
    const src = p && typeof p.botAvatar === 'string' && p.botAvatar.indexOf('data:image/') === 0 ? p.botAvatar : '';
    const img = src
      ? '<img src="' + esc(src) + '" alt="" width="40" height="40" decoding="async" onerror="this.style.display=\'none\'">'
      : '';
    return '<div class="bot-avatar snow" role="img" aria-label="Miss Frozen">' + img + '<span class="avatar-fallback">❄️</span></div>';
  }

  // 🟡 Identity: user's Telegram profile photo (initData or API).
  function userAvatarHtml() {
    let src = '';
    try {
      const u = tg && tg.initDataUnsafe && tg.initDataUnsafe.user;
      if (u && u.photo_url) src = u.photo_url;
    } catch (_) {}
    const p = currentProfile();
    if (!src && p && typeof p.userPhoto === 'string' && p.userPhoto) src = p.userPhoto;
    const img = src
      ? '<img src="' + esc(src) + '" alt="" width="76" height="76" decoding="async" onerror="this.style.display=\'none\'">'
      : '';
    const letter = (displayName() || 'S').charAt(0).toUpperCase();
    return '<div class="avatar user-avatar" role="img" aria-label="You">' + img + '<span class="avatar-fallback">' + esc(letter) + '</span></div>';
  }

  // 🟢 Under name: Status · XP · GLOBAL RANK
  function statusBlockHtml() {
    const p = currentProfile();
    const life = p && p.life;
    const statusLine = !life
      ? 'Status: —'
      : (life.alive
        ? 'Status: Alive'
        : 'Status: Dead' + (life.label && life.label.indexOf('revives') >= 0 ? ' · ' + life.label.replace(/^Dead · /, '') : ''));
    const xp = p && p.xp != null ? Number(p.xp).toLocaleString('en-US') : '—';
    const gr = p && p.globalRank != null ? '#' + p.globalRank : '—';
    return '<p class="life ' + (life && !life.alive ? 'dead' : 'alive') + '">' + esc(statusLine) + '</p>'
      + '<p class="id-line">XP: ' + esc(String(xp)) + ' · GLOBAL RANK: ' + esc(String(gr)) + '</p>';
  }

  function pageHome() {
    const name = displayName() || 'Shinobi';
    return '<section class="hero-card"><div class="identity">'
      + userAvatarHtml()
      + '<div><h1 class="who">' + esc(name) + '</h1>' + statusBlockHtml() + '</div>'
      + '</div></section>'
      + pageGame()
      + '<section class="feedback-card">'
      + '<p class="fb-title">💬 Have feedback? We’re listening!</p>'
      + '<p class="fb-body">🐛 Report bugs, 💡 suggest new features, or ⭐ share your review to help us improve.</p>'
      + '<p class="fb-body">👇 Tap “Send Feedback” to share your thoughts with us!</p>'
      + '<a class="fb-btn primary" href="https://t.me/' + esc(C.BOT_USERNAME) + '?start=owner">Send ❄️ Feedback</a>'
      + '<p class="fb-body" style="margin-top:12px">📢 Join our official updates channel for the latest news, announcements, and new features.</p>'
      + '<a class="fb-btn channel" href="https://t.me/frozenblooded" target="_blank" rel="noopener">Join 𝑭𝒓❄️𝒛𝒆𝒏 𝑩𝒍𝒐𝒐𝒅𝒆𝒅 channel</a>'
      + '</section>';
  }

  function claimedToday() {
    const profile = state.data && state.data.profile;
    const today = state.data && state.data.today;
    return !!(profile && today && profile.lastClaim === today);
  }

  function streakDots(streak) {
    const n = Math.max(0, Math.min(7, Number(streak) || 0));
    let html = '';
    for (let i = 0; i < 7; i += 1) html += '<span class="dot' + (i < n ? ' on' : '') + '"></span>';
    return html;
  }

  function pageGame() {
    const head = state.page === 'home'
      ? '<h1>Game hub</h1><p class="lead">Same coins, chakra and claim as the bot.</p>'
        + (state.busy ? '<div class="sync">Syncing with the bot…</div>' : '')
        + (state.flash ? '<div class="notice">' + esc(state.flash) + '</div>' : '')
      : pageHead('Game hub', 'Same coins, chakra and claim as the bot.', 'Home');
    if (!state.data) {
      return '<section>' + head + (errorHtml() || loadingHtml('Loading your economy…')) + '</section>';
    }
    const p = state.data.profile;
    const b = state.data.balance;
    const already = claimedToday() || (state.lastClaim && state.lastClaim.claim && !state.lastClaim.claim.claimed);
    const claimLabel = state.busy ? 'Claiming…' : (already ? 'Claimed' : 'Claim');
    const claimNote = state.lastClaim && state.lastClaim.claim && state.lastClaim.claim.claimed
      ? '<div class="success-text">+' + esc(fmt(state.lastClaim.claim.coins)) + ' coins · +' + esc(fmt(state.lastClaim.claim.chakra)) + ' chakra</div>'
      : '';
    return '<section>' + head + errorHtml()
      + '<div class="streak"><div><small>Streak</small><strong>' + esc(fmt(p.streak)) + '<span style="font-size:16px;color:#6a879c"> / 7</span></strong><div class="dots">' + streakDots(p.streak) + '</div></div>'
      + '<button class="claim" data-action="claim" ' + (already || state.busy ? 'disabled' : '') + '>' + esc(claimLabel) + '</button></div>'
      + claimNote
      + '<div class="pair"><div class="stat-tile"><small>Balance</small><strong>' + esc(fmt(b.coins)) + ' 🍥</strong></div><div class="stat-tile"><small>Chakra</small><strong>' + esc(fmt(b.chakra)) + ' ⚡</strong></div></div>'
      + '<div class="list">'
      + card('🥷', 'Profile', 'Rank, XP, roster and streak', 'data-page="profile"')
      + card('🎒', 'Inventory', 'Shinobi, jutsu, gifts and chakra', 'data-page="inventory"')
      + card('🏯', 'Shinobi store', 'Buy directly. Same catalogue as /buy', 'data-page="store"')
      + card('✨', 'Ability', 'All abilities, with Lvl Up', 'data-page="abilities"')
      + card('🎁', 'Gift store', 'List and prices. Group only', 'data-page="gifts"')
      + '</div>'
      + '<div class="map-teaser">'
      + '<div style="font-size:42px;line-height:1;margin-bottom:6px">🗺️</div>'
      + '<div style="font-weight:800;margin-bottom:4px">Konoha Map</div>'
      + '<div class="muted" style="font-size:12px;margin-bottom:10px">Explore Hokage Office, Gate, BBQ and more</div>'
      + '<button class="primary" data-start="mini_map" style="width:100%">Open Konoha Map</button>'
      + '</div></section>';
  }


  function pageProfile() {
    if (state.profileBusy && !state.profile) {
      return '<section>' + pageHead('Profile', 'Same record as /profile.', 'Game hub') + loadingHtml('Loading profile…') + '</section>';
    }
    if (state.profileError && !state.profile) {
      state.error = state.profileError;
      return '<section>' + pageHead('Profile', 'Same record as /profile.', 'Game hub') + errorHtml() + '</section>';
    }
    const d = state.profile || (state.data && state.data.profile);
    if (!d) {
      return '<section>' + pageHead('Profile', 'Same record as /profile.', 'Game hub') + (errorHtml() || loadingHtml()) + '</section>';
    }
    const roster = (d.roster || []).map((x) => (typeof x === 'string' ? x : (x.name || x.item_name || ''))).filter(Boolean);
    const jutsu = (d.jutsu || []).map((x) => (typeof x === 'string' ? x : (x.name || x.item_name || ''))).filter(Boolean);
    const eqList = d.equippedList || (d.life && d.life.equipped ? [d.life.equipped] : []);
    return '<section>' + pageHead('Profile', 'Same record as /profile.', 'Game hub') + errorHtml()
      + '<div class="hero-card"><div class="identity">' + userAvatarHtml()
      + '<div><h1 class="who">' + esc(d.displayName || displayName() || 'Shinobi') + '</h1>'
      + statusBlockHtml()
      + '<p class="id-line">' + (d.username ? '@' + esc(d.username) : 'No public username') + '</p></div></div></div>'
      + '<div class="stats-grid">'
      + stat('Rank', d.rank) + stat('Global', d.globalRank != null ? '#' + d.globalRank : '—')
      + stat('XP', d.xpText) + stat('Coins', fmt(d.balance)) + stat('Chakra', fmt(d.chakra))
      + stat('Kills', fmt(d.kills)) + stat('Streak', fmt(d.streak) + '/7') + stat('Last claim', d.lastClaim) + stat('Patrols', fmt(d.narutoPatrols))
      + '</div>'
      + '<div class="section">Equipped (' + eqList.length + '/3)</div><div class="chip-row">'
      + (eqList.length ? eqList.map((n) => '<span class="chip">👤 ' + esc(n) + '</span>').join('') : '<span class="muted">None — use /equip</span>')
      + '</div>'
      + '<div class="section">Roster</div><div class="chip-row">'
      + (roster.length ? roster.map((n) => '<span class="chip">🥷 ' + esc(n) + '</span>').join('') : '<span class="muted">Empty</span>')
      + '</div>'
      + '<div class="section">Jutsu</div><div class="chip-row">'
      + (jutsu.length ? jutsu.map((n) => '<span class="chip">✨ ' + esc(n) + '</span>').join('') : '<span class="muted">None yet</span>')
      + '</div>'
      + '<button class="secondary" data-action="retry" style="margin-top:14px">Refresh</button></section>';
  }

  function stat(label, value) {
    return '<div class="stat"><small>' + esc(label) + '</small><strong>' + esc(value == null || value === '' ? '—' : value) + '</strong></div>';
  }

  function pageInventory() {
    if (!state.data) return '<section>' + pageHead('Inventory', 'Owned items from the bot.', 'Game hub') + (errorHtml() || loadingHtml()) + '</section>';
    const inv = state.data.inventory || [];
    const typeOf = (x) => String(x.type || '').toLowerCase();
    const sections = [
      ['Shinobi', '🥷', inv.filter((x) => typeOf(x) === 'shinobi' || typeOf(x) === 'character')],
      ['Jutsu', '✨', inv.filter((x) => typeOf(x) === 'jutsu')],
      ['Gifts', '🎁', inv.filter((x) => typeOf(x) === 'gift')],
      ['Chakra', '⚡', inv.filter((x) => typeOf(x) === 'chakra')],
      ['Other', '📦', inv.filter((x) => !['shinobi', 'character', 'jutsu', 'gift', 'chakra'].includes(typeOf(x)))],
    ];
    return '<section>' + pageHead('Inventory', 'Owned items from the bot.', 'Game hub') + errorHtml()
      + sections.map(([label, emoji, items]) => {
          if (!items.length && label === 'Other') return '';
          return '<div class="section">' + esc(label) + '</div><div class="chip-row">'
            + (items.length
              ? items.map((x) => '<span class="chip">' + emoji + ' ' + esc(x.name) + (x.qty > 1 ? ' <span class="qty">×' + fmt(x.qty) + '</span>' : '') + '</span>').join('')
              : '<span class="muted">— empty —</span>')
            + '</div>';
        }).join('')
      + '<button class="secondary" data-action="retry" style="margin-top:14px">Refresh</button></section>';
  }

  function pageStore() {
    if (!state.data) return '<section>' + pageHead('Shinobi store', 'Buy here. The bot checks the price.', 'Game hub') + (errorHtml() || loadingHtml()) + '</section>';
    const items = state.data.store || [];
    const confirm = state.confirm && items.find((i) => i.name === state.confirm);
    const sheet = confirm
      ? '<div class="card"><div class="card-title">Buy ' + esc(confirm.emoji || '') + ' ' + esc(confirm.name)
        + (confirm.type === 'chakra' ? ' × ' + fmt(confirm.qty || 100) : '')
        + '?</div><p class="muted">' + fmt(confirm.price) + ' coins'
        + (confirm.type === 'chakra' ? '. You can buy again anytime.' : '. Unique items cannot be bought twice.')
        + '</p><div class="button-row"><button class="primary" data-action="confirm-purchase" ' + (state.busy ? 'disabled' : '') + '>Buy</button><button class="secondary" data-action="cancel-purchase">Cancel</button></div></div>'
      : '';
    const rows = items.map((item) => {
      const isChakra = item.type === 'chakra';
      const owned = !isChakra && item.owned;
      const label = isChakra
        ? (esc(item.emoji || '⚡') + ' Chakra × ' + fmt(item.qty || 100))
        : (esc(item.emoji || '') + ' ' + esc(item.name));
      const priceLine = fmt(item.price) + ' coins' + (isChakra ? ' · multi-buy' : '');
      const btn = owned
        ? '<button class="buy-btn owned" disabled>Owned</button>'
        : '<button class="buy-btn" data-confirm-buy="' + esc(item.name) + '" ' + (state.busy ? 'disabled' : '') + '>Buy</button>';
      return '<div class="store-row"><div class="store-meta"><strong>' + label + '</strong><small>' + priceLine + '</small></div>' + btn + '</div>';
    }).join('');
    return '<section>' + pageHead('Shinobi store', 'Shinobi & jutsu are one-time. Chakra can be bought again.', 'Game hub')
      + errorHtml() + sheet
      + '<div class="card">' + (rows || '<div class="muted">Store is empty.</div>') + '</div></section>';
  }

  function pageAbilities() {
    if (!state.data) return '<section>' + pageHead('Ability', 'Same list as /ability.', 'Game hub') + (errorHtml() || loadingHtml()) + '</section>';
    const rows = state.data.abilities || [];
    return '<section>' + pageHead('Ability', 'Using an ability still happens in chat.', 'Game hub') + errorHtml()
      + '<div class="list">' + (rows.length ? rows.map((a) => '<div class="card"><div class="card-title">' + esc(a.name) + '</div><div class="muted">' + esc(a.description) + '</div></div>').join('') : '<div class="notice">No ability list was returned.</div>') + '</div>'
      + '<button class="primary" data-page="levels" style="margin-top:12px">Lvl Up</button></section>';
  }

  function pageLevels() {
    if (!state.data || !state.data.levels) return '<section>' + pageHead('Lvl Up', 'Same screen as the ability menu.', 'Ability') + (errorHtml() || loadingHtml()) + '</section>';
    const d = state.data.levels;
    const miles = d.itachiMilestones || [];
    return '<section>' + pageHead('Lvl Up', 'Itachi milestones and Sakura status from the bot.', 'Ability') + errorHtml()
      + '<div class="card"><div class="card-title">Itachi</div><div class="stats">' + stat('Kills', fmt(d.kills)) + stat('Current', d.current) + '</div><div class="notice">' + esc(d.next || '') + '</div></div>'
      + miles.map((m) => '<div class="card"><div class="row-between"><strong>Lv. ' + esc(m.level) + ' · ' + esc(m.title) + '</strong><span class="tag">' + esc(m.robGain) + '% rob</span></div><div class="muted">' + fmt(m.kills) + ' kills</div></div>').join('')
      + '<div class="card"><div class="card-title">Sakura training</div><div class="muted">' + esc(d.sakura || '—') + '</div><div class="notice">Only shinobi with a level system are listed. This does not spend coins.</div></div></section>';
  }

  function pageGifts() {
    if (!state.data) return '<section>' + pageHead('Gift store', 'Prices from the bot catalogue.', 'Game hub') + (errorHtml() || loadingHtml()) + '</section>';
    const gifts = state.data.gifts || [];
    return '<section>' + pageHead('Gift store', "Ino's catalogue. Sending stays in the group.", 'Game hub') + errorHtml()
      + '<div class="list">' + (gifts.length ? gifts.map((g) => '<div class="item"><span class="item-icon">' + esc(g.emoji || '🎁') + '</span><span class="item-body"><strong>' + esc(g.id) + '. ' + esc(g.name) + '</strong><small>Catalog number ' + esc(g.id) + '</small></span><span class="tag">' + fmt(g.price) + ' 🍥</span></div>').join('') : '<div class="notice">The gift catalogue was not returned.</div>') + '</div>'
      + '<div class="notice"><strong>How to use — group only.</strong><br>Reply to someone in a group where @' + esc(C.BOT_USERNAME) + ' is present, then send /gift and the catalog number. Example: /gift 3. You cannot send a gift from this Mini App, and you cannot gift yourself.</div></section>';
  }





  const pages = {
    home: pageHome,
    game: pageGame,
    profile: pageProfile,
    inventory: pageInventory,
    store: pageStore,
    abilities: pageAbilities,
    levels: pageLevels,
    gifts: pageGifts,
  };

  let root;

  function render() {
    if (!root) return;
    const view = pages[state.page] || pageHome;
    try {
      root.innerHTML = shell(view());
    } catch (e) {
      state.error = e;
      root.innerHTML = shell('<section>' + pageHead('This screen could not be drawn', '', 'Home') + errorHtml() + '</section>');
    }
  }

  function navigate(page) {
    if (page === state.page) return;
    state.stack.push(state.page);
    state.page = page;
    state.flash = '';
    state.confirm = null;
    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
    if (page === 'profile') refreshProfile();
  }

  function goNav(page) {
    state.stack = [];
    state.page = page;
    state.flash = '';
    state.confirm = null;
    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function back() {
    state.page = state.stack.pop() || 'home';
    state.flash = '';
    state.confirm = null;
    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function openExternal(url) {
    if (tg && /^https:\/\/t\.me\//i.test(url) && typeof tg.openTelegramLink === 'function') tg.openTelegramLink(url);
    else if (tg && typeof tg.openLink === 'function') tg.openLink(url);
    else window.open(url, '_blank', 'noopener,noreferrer');
  }

  function launchStart(payload) {
    if (!C.BOT_STARTS[payload]) return;
    openExternal('https://t.me/' + C.BOT_USERNAME + '?start=' + encodeURIComponent(payload));
  }

  async function refresh() {
    if (state.busy) return;
    state.busy = true;
    state.error = null;
    render();
    try {
      const { dashboard } = takeDashboard(await serverlessCall({ action: 'bootstrap' }));
      state.data = dashboard;
    } catch (e) {
      state.error = e;
    } finally {
      state.busy = false;
      render();
    }
  }

  async function refreshProfile() {
    if (state.profileBusy) return;
    state.profileBusy = true;
    state.profileError = null;
    render();
    try {
      const profile = C.unwrapPayload(await serverlessCall({}, 'getProfile'));
      if (!profile || typeof profile !== 'object' || !Array.isArray(profile.roster) || typeof profile.rank !== 'string') {
        throw Object.assign(new Error('Profile came back in an unexpected shape.'), { type: 'BAD_PAYLOAD' });
      }
      state.profile = profile;
    } catch (e) {
      state.profileError = e;
    } finally {
      state.profileBusy = false;
      render();
    }
  }

  async function claim() {
    if (state.busy || claimedToday()) return;
    state.busy = true;
    state.error = null;
    render();
    try {
      const payload = C.unwrapPayload(await serverlessCall({ action: 'claim' }));
      if (!payload || !payload.claim || !C.isDashboard(payload.dashboard)) {
        throw Object.assign(new Error('Claim returned an unexpected payload. Check the bot before claiming again.'), { type: 'BAD_PAYLOAD' });
      }
      state.lastClaim = payload;
      state.data = payload.dashboard;
      state.flash = payload.claim.claimed
        ? 'Daily reward added. Streak ' + fmt(payload.claim.streak) + '/7.'
        : 'Already claimed today. Come back after 12:00 AM IST.';
    } catch (e) {
      state.error = e;
    } finally {
      state.busy = false;
      render();
    }
  }

  async function buy(name) {
    if (state.busy || !name) return;
    state.busy = true;
    state.error = null;
    state.confirm = null;
    render();
    try {
      const payload = C.unwrapPayload(await serverlessCall({ action: 'purchase', itemName: name }));
      if (!payload || !payload.purchase || !C.isDashboard(payload.dashboard)) {
        throw Object.assign(new Error('Purchase returned an unexpected payload. Check your balance in the bot.'), { type: 'BAD_PAYLOAD' });
      }
      state.data = payload.dashboard;
      const r = payload.purchase;
      if (r.status === 'ok') state.flash = 'Purchased ' + name + '. Balance: ' + fmt(r.balance) + '.';
      else if (r.status === 'owned') state.flash = 'You already own this. No coins were taken.';
      else if (r.status === 'insufficient') state.flash = 'Not enough coins. Balance: ' + fmt(r.balance) + '.';
      else if (r.status === 'duplicate') state.flash = 'That purchase was already recorded.';
      else if (r.status === 'failed' && !r.safe) state.flash = 'Uncertain result. Do not retry yet. Check the bot balance.';
      else state.flash = 'Purchase was not completed. No coins were taken.';
    } catch (e) {
      state.error = e;
    } finally {
      state.busy = false;
      render();
    }
  }


  document.addEventListener('click', async (event) => {
    const link = event.target.closest('a[data-url]');
    if (link && root && root.contains(link)) {
      event.preventDefault();
      openExternal(link.dataset.url);
      return;
    }
    const button = event.target.closest('button');
    if (!button || !root || !root.contains(button)) return;
    if (button.dataset.action === 'back') { back(); return; }
    if (button.dataset.nav) { goNav(button.dataset.nav); return; }
    if (button.dataset.action === 'retry') {
      if (state.page === 'profile') await refreshProfile();
      else await refresh();
      return;
    }
    if (button.dataset.page) { navigate(button.dataset.page); return; }
    if (button.dataset.start) { launchStart(button.dataset.start); return; }
    if (button.dataset.action === 'claim') { await claim(); return; }
    if (button.dataset.confirmBuy) { state.confirm = button.dataset.confirmBuy; state.flash = ''; render(); return; }
    if (button.dataset.action === 'cancel-purchase') { state.confirm = null; render(); return; }
    if (button.dataset.action === 'confirm-purchase') { await buy(state.confirm); return; }
  });

  // ?page=store lands straight on the store, with Home behind it.
  function openDeepLink() {
    let want = '';
    try { want = new URLSearchParams(window.location.search).get('page') || ''; } catch (_) {}
    if (!want && tg && tg.initDataUnsafe && tg.initDataUnsafe.start_param) want = String(tg.initDataUnsafe.start_param);
    if (want === 'store') {
      state.stack = ['home'];
      state.page = 'store';
    }
  }

  function boot() {
    root = document.getElementById('app');
    if (!root || root.dataset.booted === '1') return;
    root.dataset.booted = '1';
    openDeepLink();
    render();
    if (serverlessAvailable()) refresh();
    else state.error = Object.assign(new Error('Open this Mini App from the bot inside Telegram.'), { type: 'UNAVAILABLE', status: 0 });
    render();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
