/* Frozen Blooded — Konoha Mini App.
   Identity comes from Telegram's signed init data; every number on screen comes
   from the bot endpoints (bootstrap · claim · purchase). No mock data. */
(function () {
  const C = window.FBContract;
  if (!C) return;

  const I = window.FBIcons || {
    icon: () => '',
    art: () => '',
    emoji: () => '',
    artName: () => 'crate',
    has: () => false,
  };
  const G = window.FBGame || {
    fmt: (v) => (v == null || v === '' ? '—' : String(v)),
    rankProgress: () => ({ tier: 1, tiers: 6, rank: 'Academy Student', pct: 0, maxed: false, label: '—' }),
    matches: (a, b) => String(a).toLowerCase().indexOf(String(b).toLowerCase()) >= 0,
    commandsIn: () => [],
    abilityKind: () => 'passive',
    cooldownIn: () => '',
    initial: (v) => String(v || 'S').charAt(0).toUpperCase(),
  };
  const S = window.FBStreak || null;

  const VERSION = '2.0';

  const tg = window.Telegram && window.Telegram.WebApp;
  if (tg) {
    try { tg.ready(); } catch (_) {}
    try { tg.expand(); } catch (_) {}
    try {
      tg.setHeaderColor('#eef8ff');
      tg.setBackgroundColor('#eef8ff');
    } catch (_) {}
  }

  const tgUser = (() => {
    try { return (tg && tg.initDataUnsafe && tg.initDataUnsafe.user) || null; } catch (_) { return null; }
  })();

  const state = {
    page: 'home',
    stack: [],
    data: null,
    error: null,
    flash: null,
    flashKind: 'info',
    claiming: false,
    buying: false,
    confirm: null,
    detail: null,
    lastClaim: null,
  };

  // ---------------------------------------------------------------- helpers --
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
  const fmt = G.fmt;
  const ico = (name, cls) => I.icon(name, cls);
  const art = (name, cls) => I.art(name, cls);
  const emo = (value, cls) => (typeof I.emoji === 'function' ? I.emoji(value, cls) : '');

  /** Emoji stored by the bot for a roster member (matches "/profile" output). */
  function rosterEmoji(name) {
    if (!name) return '';
    const hit = roster().find((r) => G.matches(name, r.name));
    return hit && hit.emoji ? String(hit.emoji) : '';
  }

  /** Artwork slot for an item: the bot's own emoji first, then the shared map.
      Chakra always uses the crystal ball so every screen matches the stat card. */
  function artFor(item, name, type) {
    const label = name || (item && item.name) || '';
    const kind = type || (item && item.type) || '';
    if (kind === 'chakra' || /^chakra\b/i.test(String(label))) return art('chakra');
    const fromBot = item && item.emoji ? String(item.emoji) : '';
    if (fromBot) return emo(fromBot);
    const known = rosterEmoji(label);
    if (known) return emo(known);
    return art(I.artName(label, kind));
  }

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

  function currentProfile() {
    return (state.data && state.data.profile) || null;
  }

  function displayName() {
    const p = currentProfile();
    if (p && p.displayName) return p.displayName;
    if (tgUser) return [tgUser.first_name, tgUser.last_name].filter(Boolean).join(' ');
    return '';
  }

  function userPhoto() {
    const p = currentProfile();
    try {
      if (tgUser && tgUser.photo_url) return String(tgUser.photo_url);
    } catch (_) {}
    if (p && typeof p.userPhoto === 'string' && p.userPhoto) return p.userPhoto;
    return '';
  }

  function roster() {
    const p = currentProfile();
    return ((p && p.roster) || []).map((x) => (typeof x === 'string' ? { name: x, qty: 1 } : x)).filter((x) => x && x.name);
  }

  function jutsu() {
    const p = currentProfile();
    return ((p && p.jutsu) || []).map((x) => (typeof x === 'string' ? x : x && x.name)).filter(Boolean);
  }

  function equipped() {
    const p = currentProfile();
    const list = (p && p.equippedList) || [];
    return Array.isArray(list) ? list.filter(Boolean) : [];
  }

  function ownsSakura() {
    return roster().some((r) => String(r.name).toLowerCase() === 'sakura');
  }

  function ownsItachi() {
    return roster().some((r) => String(r.name).toLowerCase() === 'itachi');
  }

  function firstName() {
    const name = displayName();
    return (name.split(' ')[0] || 'Shinobi').trim();
  }

  function today() {
    return (state.data && state.data.today) || '';
  }

  function streakView() {
    const p = currentProfile();
    if (!S) return null;
    return S.view({ streak: p ? p.streak : 0, lastClaim: p ? p.lastClaim : '', today: today() });
  }

  function claimedToday() {
    const p = currentProfile();
    return !!(p && today() && p.lastClaim === today());
  }

  // ----------------------------------------------------------------- chrome --
  function avatarHtml(size) {
    const src = userPhoto();
    const img = src ? '<img src="' + esc(src) + '" alt="" decoding="async">' : '';
    const cls = size === 'lg' ? 'avatar ring' : 'avatar';
    return '<div class="' + cls + '" role="img" aria-label="Your profile picture">' + img
      + '<span class="avatar-fallback">' + esc(G.initial(displayName())) + '</span></div>';
  }

  function headerHtml() {
    const sync = state.data
      ? '<span class="sync-pill">' + ico('check') + 'Synced</span>'
      : '<span class="sync-pill">' + ico('refresh') + 'Connecting</span>';
    return '<header class="app-header">'
      + '<div class="brand-mark">' + ico('logo') + '</div>'
      + '<div><div class="brand-name">Miss Frozen</div><div class="brand-sub">Konoha · Mini App</div></div>'
      + '<span class="header-spacer"></span>' + sync
      + '</header>';
  }

  const NAV = [
    { page: 'home', icon: 'home', label: 'Home' },
    { page: 'inventory', icon: 'inventory', label: 'Inventory' },
    { page: 'store', icon: 'store', label: 'Store' },
    { page: 'abilities', icon: 'ability', label: 'Abilities' },
    { page: 'map', icon: 'map', label: 'Map' },
    { page: 'more', icon: 'more', label: 'More' },
  ];

  function navKey(page) {
    if (NAV.some((n) => n.page === page)) return page;
    if (page === 'levels') return 'abilities';
    return 'more';
  }

  function navHtml() {
    const active = navKey(state.page);
    return '<nav class="bottom-nav" aria-label="Main navigation">'
      + NAV.map((n) => '<button class="nav-item" type="button" data-nav="' + n.page + '"'
        + (n.page === active ? ' aria-current="page"' : '')
        + ' aria-label="' + esc(n.label) + '">' + ico(n.icon) + '<span>' + esc(n.label) + '</span></button>').join('')
      + '</nav>';
  }

  function footerHtml() {
    return '<footer class="app-footer">'
      + '<p class="credit">created by <a href="https://t.me/frozenblooded" data-url="https://t.me/frozenblooded">'
      + '𝑭𝒓<span class="credit-snowflake" aria-hidden="true">❄️</span>𝒛𝒆𝒏 𝑩𝒍𝒐𝒐𝒅𝒆𝒅</a></p>'
      + '<p class="version-line">MINI APP V' + VERSION + ' · SYNCED WITH @' + esc(C.BOT_USERNAME).toUpperCase() + '</p>'
      + '</footer>';
  }

  function shell(content) {
    return '<div class="shell">' + headerHtml() + '<main class="page" id="page">' + content + '</main>'
      + footerHtml() + '</div>' + navHtml() + sheetHtml();
  }

  function pageBar(title, backTo) {
    return '<div class="page-bar"><button class="back" type="button" data-action="back" aria-label="Back to ' + esc(backTo || 'Home') + '">'
      + ico('chevron-left') + esc(backTo || 'Back') + '</button></div><h1>' + esc(title) + '</h1>';
  }

  function sectionTitle(label, iconName, hint) {
    return '<div class="section-title">' + (iconName ? ico(iconName) : '') + esc(label) + '</div>'
      + (hint ? '<p class="section-hint">' + esc(hint) + '</p>' : '');
  }

  function errorCard() {
    if (!state.error) return '';
    const code = state.error.parameters && state.error.parameters.code;
    let hint = 'Open the Mini App from the bot inside Telegram, then try again.';
    if (state.error.status === 401 || state.error.type === 'UNAUTHORIZED') {
      hint = 'Telegram did not verify this session. Reopen the Mini App from the bot.';
    } else if (state.error.type === 'BAD_PAYLOAD') {
      hint = 'Nothing was changed. Check your balance in the bot before retrying.';
    } else if (state.error.type === 'ENDPOINT_ERROR' && code) {
      hint = 'The bot rejected this action (' + code + '). Try again from the bot.';
    } else if (state.error.type === 'UNAVAILABLE') {
      hint = 'This screen needs the Telegram bot client. Open @' + C.BOT_USERNAME + ' and launch it again.';
    }
    return '<div class="notice error" role="alert">' + ico('alert')
      + '<div><strong>' + esc(state.error.message) + '</strong><div>' + esc(hint) + '</div>'
      + '<div class="notice-actions"><button class="btn btn-ghost btn-sm" type="button" data-action="retry">' + ico('refresh') + 'Retry</button></div>'
      + '</div></div>';
  }

  function flashCard() {
    if (!state.flash) return '';
    const kind = state.flashKind === 'error' ? 'error' : state.flashKind === 'good' ? 'good' : '';
    return '<div class="notice ' + kind + '" role="status">' + ico(kind === 'error' ? 'alert' : 'check')
      + '<div>' + esc(state.flash) + '</div></div>';
  }

  function skeletonRows(n) {
    return '<div class="skeleton">' + '<div class="sk hero"></div>'
      + '<div class="sk grid"><div class="sk"></div><div class="sk"></div><div class="sk"></div></div>'
      + Array.from({ length: n || 3 }, () => '<div class="sk row"></div>').join('')
      + '</div>';
  }

  function loadingPage(title, label) {
    return pageBar(title, 'Home') + skeletonRows(3)
      + '<div class="loading"><span class="spinner on-dark"></span>' + esc(label || 'Syncing with the bot…') + '</div>';
  }

  // ------------------------------------------------------------------- home --
  function claimPreview(view) {
    if (!S) return '';
    const day = view.claimedToday ? view.claimedDay : view.nextDay;
    const reward = S.rewardFor(day);
    return 'Day ' + day + ' · ' + fmt(reward.coins) + ' coins + ' + fmt(reward.chakra) + ' chakra'
      + (ownsSakura() ? ' · Sakura bonus' : '');
  }

  function claimBlock() {
    if (!serverlessAvailable()) {
      return '<button class="btn btn-primary claim" type="button" disabled aria-disabled="true">' + ico('lock') + 'Claim needs Telegram</button>'
        + '<p class="streak-note">' + ico('info') + '<span>Daily rewards are verified by Telegram. Open this Mini App from @' + esc(C.BOT_USERNAME) + '.</span></p>';
    }
    if (state.claiming) {
      return '<button class="btn btn-primary claim" type="button" disabled aria-busy="true">'
        + '<span class="spinner"></span>Claiming reward…</button>';
    }
    if (claimedToday()) {
      const view = streakView();
      const done = view && view.cycleComplete;
      return '<button class="btn btn-primary claim" type="button" disabled aria-disabled="true">'
        + ico('check') + (done ? 'Cycle complete' : 'Claimed today') + '</button>'
        + '<p class="streak-note">' + ico('clock') + '<span>' + esc(done ? 'Day 1 starts tomorrow after 12:00 AM IST.' : 'Next claim unlocks after 12:00 AM IST.') + '</span></p>';
    }
    const view = streakView();
    return '<button class="btn btn-primary claim" type="button" data-action="claim" aria-label="Claim today\'s daily reward">'
      + ico('claim') + 'Claim daily reward</button>'
      + '<p class="streak-note">' + ico('spark') + '<span>' + esc(view ? claimPreview(view) : 'Rewards are paid by the bot.') + '</span></p>';
  }

  function claimResultCard() {
    const payload = state.lastClaim;
    if (!payload || !payload.claim) return '';
    const c = payload.claim;
    if (!c.claimed) {
      return '<div class="notice warn" role="status">' + ico('clock')
        + '<div><strong>Already claimed today</strong><div>Come back after 12:00 AM IST. Nothing was paid twice.</div></div></div>';
    }
    const rewards = payload.rewards || {};
    const bonusCoins = rewards.bonusCoins != null ? rewards.bonusCoins : (S ? S.BONUS_COINS : null);
    const bonusChakra = rewards.bonusChakra != null ? rewards.bonusChakra : (S ? S.BONUS_CHAKRA : null);
    const lines = [
      ['Coins paid', '+' + fmt(c.coins), 'gold'],
      ['Chakra paid', '+' + fmt(c.chakra), 'violet'],
      ['XP', '+' + fmt(c.xp), 'ice'],
      ['Streak', 'Day ' + fmt(c.streak) + ' / 7', 'ice'],
    ];
    if (c.bonus && bonusCoins != null) {
      lines.push(['Includes day 7 bonus', '+' + fmt(bonusCoins) + ' coins · +' + fmt(bonusChakra) + ' chakra', 'gold']);
    }
    if (c.sakura && Number(c.sakuraCoins) > 0) lines.push(['Includes Sakura boost', '+' + fmt(c.sakuraCoins) + ' coins · +' + fmt(c.sakuraChakra) + ' chakra', 'violet']);
    if (Number(c.petBonus) > 0) lines.push(['Includes Axofly fortune', '+' + fmt(c.petBonus) + ' coins', 'ice']);
    return '<section class="card glow" role="status" aria-label="Claim result">'
      + '<div class="row-between"><div class="section-title">' + ico('check') + 'Claim complete</div>'
      + '<span class="chip good">' + ico('check') + 'Paid by the bot</span></div>'
      + '<div class="reward-list">'
      + lines.map(([label, value, tone]) => '<div class="reward-line"><span>' + esc(label) + '</span><b class="' + tone + '">' + esc(value) + '</b></div>').join('')
      + '</div></section>';
  }

  function streakPanel() {
    const view = streakView();
    if (!view) return '';
    const dayIcon = { done: 'check', claimed: 'check', ready: 'spark', upcoming: 'lock' };
    const stateLabel = { done: 'claimed', claimed: 'claimed today', ready: 'ready to claim', upcoming: 'upcoming' };
    const cells = view.days.map((d) => {
      const cls = 'day ' + d.state + (d.reward.bonus ? ' cycle' : '');
      const reward = d.reward.bonus
        ? 'day ' + d.day + ': ' + stateLabel[d.state] + ', ' + fmt(d.reward.coins) + ' coins, day seven bonus'
        : 'day ' + d.day + ': ' + stateLabel[d.state] + ', ' + fmt(d.reward.coins) + ' coins and ' + fmt(d.reward.chakra) + ' chakra';
      return '<div class="' + cls + '" role="listitem" aria-label="' + esc(reward) + '">'
        + '<span class="day-num">' + d.day + '</span>'
        + ico(dayIcon[d.state] || 'lock', 'day-ico')
        + '<span class="day-coin" aria-hidden="true">' + fmt(d.reward.coins) + '</span>'
        + '</div>';
    }).join('');
    return '<section class="card glow streak-panel" aria-labelledby="streak-title">'
      + '<div class="streak-head"><h2 id="streak-title">' + ico('streak') + 'Seven-day streak</h2>'
      + '<div class="streak-count"><b>' + fmt(view.completed) + '</b> / 7 days</div></div>'
      + '<div class="streak-days" role="list" aria-label="Seven day claim tracker">' + cells + '</div>'
      + '<div class="streak-progress"><progress class="xp" max="7" value="' + view.completed + '" aria-label="' + esc(view.completed + ' of 7 days claimed') + '"></progress></div>'
      + '<p class="streak-headline">' + esc(view.headline) + '</p>'
      + '<p class="streak-note">' + ico('info') + '<span>' + esc(view.note) + '</span></p>'
      + '</section>';
  }

  function pendingCard() {
    const b = state.data && state.data.balance;
    const pending = b ? Number(b.pendingRewards) || 0 : 0;
    if (pending <= 0) return '';
    return '<button class="row" type="button" data-page="map" aria-label="Pending rewards, open the Konoha map">'
      + '<span class="row-art gold">' + art('coin') + '</span>'
      + '<span class="row-body"><strong>Pending rewards</strong><small>Claim at the Hokage Office</small></span>'
      + '<span class="row-end"><span class="row-value">' + fmt(pending) + ' ' + ico('coin') + '</span>' + ico('chevron-right') + '</span>'
      + '</button>';
  }

  function tilesGrid() {
    const tiles = [
      ['profile', 'profile', 'Profile', ''],
      ['inventory', 'inventory', 'Inventory', ''],
      ['store', 'store', 'Shinobi Store', 'violet'],
      ['abilities', 'ability', 'Abilities', 'violet'],
      ['gifts', 'gift', 'Gift Store', 'gold'],
      ['map', 'map', 'Konoha Map', ''],
      ['feedback', 'feedback', 'Feedback', 'good'],
      ['channel', 'channel', 'Channel', 'good'],
    ];
    return '<div class="tile-grid">' + tiles.map(([page, icon, label, tone]) =>
      '<button class="tile ' + tone + '" type="button" data-page="' + page + '" aria-label="Open ' + esc(label) + '">'
      + '<span class="tile-icon">' + ico(icon) + '</span><strong>' + esc(label) + '</strong></button>').join('')
      + '</div>';
  }

  function heroCard(profile, opts) {
    const options = opts || {};
    const large = options.large === true;
    const headingTag = options.heading === 'h1' ? 'h1' : 'h2';
    const info = G.rankProgress(profile ? profile.xp : 0);
    const life = profile && profile.life;
    const statusChip = !life
      ? ''
      : life.alive
        ? '<span class="chip good">' + ico('shield') + 'Alive</span>'
        : '<span class="chip warn">' + ico('alert') + 'Dead</span>';
    return '<section class="hero">'
      + '<div class="identity">' + avatarHtml(large ? 'lg' : '')
      + '<div class="grow"><' + headingTag + ' class="who">' + esc(displayName() || 'Shinobi') + '</' + headingTag + '>'
      + '<p class="handle">' + (profile && profile.username ? '@' + esc(profile.username) : 'Telegram account') + '</p>'
      + '<div class="id-meta">'
      + '<span class="chip">' + ico('spark') + 'Lv. ' + info.tier + '</span>'
      + '<span class="chip violet">' + ico('trophy') + esc(info.rank) + '</span>'
      + (profile && profile.globalRank != null ? '<span class="chip">' + ico('users') + '#' + fmt(profile.globalRank) + '</span>' : '')
      + statusChip
      + '</div></div></div>'
      + '<div class="xp-row"><span class="xp-label">Rank progress</span><span class="xp-value">' + esc(info.label) + '</span></div>'
      + '<progress class="xp" max="100" value="' + info.pct + '" aria-label="' + esc('Rank progress ' + info.pct + ' percent') + '"></progress>'
      + '</section>';
  }

  function pageHome() {
    if (!state.data) {
      return skeletonRows(4) + errorCard()
        + (state.error ? '' : '<div class="loading"><span class="spinner on-dark"></span>Loading your Konoha account…</div>');
    }
    const p = state.data.profile;
    const b = state.data.balance;
    return heroCard(p, { heading: 'h1' })
      + errorCard() + flashCard()
      + '<div class="stat-grid">'
      + '<div class="stat-card gold">' + ico('coin') + '<small>Konoha coins</small><strong>' + fmt(b.coins) + '</strong></div>'
      + '<div class="stat-card violet">' + ico('chakra') + '<small>Chakra</small><strong>' + fmt(b.chakra) + '</strong></div>'
      + '<div class="stat-card">' + ico('streak') + '<small>Streak</small><strong>' + fmt(p.streak) + '<span class="delta">/7</span></strong></div>'
      + '</div>'
      + streakPanel()
      + claimResultCard()
      + claimBlock()
      + pendingCard()
      + sectionTitle('Explore Konoha', 'map')
      + tilesGrid();
  }

  // ---------------------------------------------------------------- profile --
  function pageProfile() {
    if (!state.data) return loadingPage('Profile', 'Loading profile…') + errorCard();
    const p = state.data.profile;
    const info = G.rankProgress(p.xp);
    const eq = equipped();
    const rosterList = roster();
    const jutsuList = jutsu();
    const stat = (label, value) => '<div class="mini-stat"><small>' + esc(label) + '</small><strong>' + esc(value) + '</strong></div>';
    return pageBar('Profile', 'Home') + '<p class="page-lead">The same record as /profile — synced live from the bot.</p>'
      + errorCard() + flashCard()
      + heroCard(p, { large: true })
      + '<div class="card"><div class="section-title">' + ico('check') + 'Account stats</div>'
      + '<div class="stat-grid two" style="margin-top:10px">'
      + stat('Coins', fmt(p.balance))
      + stat('Chakra', fmt(p.chakra))
      + stat('Kills', fmt(p.kills))
      + stat('Naruto patrols', fmt(p.narutoPatrols))
      + stat('Claim streak', fmt(p.streak) + ' / 7')
      + stat('Global rank', p.globalRank != null ? '#' + fmt(p.globalRank) : '—')
      + '</div>'
      + '<div class="divider" style="margin:12px 0"></div>'
      + '<div class="row-between"><span class="faint" style="font-size:11.5px">Last claim</span><span class="row-value">' + esc(p.lastClaim || '—') + '</span></div>'
      + '<div class="row-between" style="margin-top:6px"><span class="faint" style="font-size:11.5px">XP</span><span class="row-value">' + esc(info.label) + '</span></div>'
      + '</div>'
      + sectionTitle('Equipped shinobi', 'users', eq.length + ' of 3 slots · manage with /equip')
      + slotRow(eq)
      + sectionTitle('Roster', 'inventory', rosterList.length + ' shinobi owned')
      + (rosterList.length
        ? '<div class="list">' + rosterList.map((r) =>
          '<div class="row static"><span class="row-art">' + artFor(r, r.name, 'shinobi') + '</span>'
          + '<span class="row-body"><strong>' + esc(r.name) + '</strong><small>' + esc(eq.some((n) => String(n).toLowerCase() === String(r.name).toLowerCase()) ? 'Equipped' : 'In roster') + '</small></span>'
          + '<span class="row-end"><span class="row-value">' + (Number(r.qty) > 1 ? '×' + fmt(r.qty) : '') + '</span></span></div>').join('') + '</div>'
        : '<div class="empty">' + ico('inventory') + '<strong>No shinobi yet</strong><span>Recruit one from the Shinobi Store.</span></div>')
      + sectionTitle('Jutsu', 'jutsu', jutsuList.length + ' unlocked')
      + (jutsuList.length
        ? '<div class="wrap">' + jutsuList.map((j) => '<span class="chip violet">' + ico('jutsu') + esc(j) + '</span>').join('') + '</div>'
        : '<div class="notice">' + ico('info') + '<div>No jutsu unlocked yet. Mind Transmission Jutsu is in the Shinobi Store.</div></div>')
      + '<div class="btn-row" style="margin-top:4px">'
      + '<a class="btn btn-ghost" href="/profile.html">' + ico('external') + 'Full profile page</a>'
      + '<button class="btn btn-ghost" type="button" data-action="retry">' + ico('refresh') + 'Refresh</button>'
      + '</div>';
  }

  function slotRow(eq) {
    const slots = [0, 1, 2].map((i) => {
      const name = eq[i];
      if (!name) {
        return '<div class="slot empty">' + ico('plus') + '<strong>Empty slot</strong><small>Slot ' + (i + 1) + '</small></div>';
      }
      return '<div class="slot filled">' + artFor(null, name, 'shinobi') + '<strong>' + esc(name) + '</strong><small>Slot ' + (i + 1) + '</small></div>';
    }).join('');
    return '<div class="slot-row">' + slots + '</div>';
  }

  // -------------------------------------------------------------- inventory --
  const INVENTORY_SECTIONS = [
    ['shinobi', 'Shinobi', 'shinobi', 'Recruit from the Shinobi Store.'],
    ['jutsu', 'Jutsu', 'jutsu', 'Unlock jutsu in the Shinobi Store.'],
    ['gift', 'Gifts', 'gift', 'Gifts you received from other shinobi.'],
    ['chakra', 'Chakra', 'chakra', 'Chakra refills every daily claim.'],
    ['other', 'Other items', 'inventory', 'Anything else the bot has stored for you.'],
  ];

  function itemAction(item) {
    if (item.type === 'shinobi') return { cmd: '/equip ' + item.name, label: 'Equip in the bot' };
    if (item.type === 'jutsu') return { cmd: '/mt', label: 'Use with /mt in a group' };
    if (item.type === 'gift') return { cmd: '/gift', label: 'Gifts are sent in groups' };
    if (item.type === 'chakra') return { cmd: '/mission', label: 'Spent on missions in groups' };
    return null;
  }

  function inventoryItem(item) {
    const key = item.type + ':' + item.name;
    const open = state.detail === key;
    const action = itemAction(item);
    const qty = Number(item.qty) > 1 ? '×' + fmt(item.qty) : '1';
    return '<div class="card flat" style="padding:10px 12px">'
      + '<button class="row" type="button" style="background:none;box-shadow:none;padding:0" data-detail="' + esc(key) + '" aria-expanded="' + (open ? 'true' : 'false') + '">'
      + '<span class="row-art">' + artFor(item, item.name, item.type) + '</span>'
      + '<span class="row-body"><strong>' + esc(item.name) + '</strong><small>' + esc(item.type) + ' · quantity ' + qty + '</small></span>'
      + '<span class="row-end">' + ico(open ? 'minus' : 'plus') + '</span>'
      + '</button>'
      + (open
        ? '<div class="stack tight" style="margin-top:10px">'
          + '<div class="row-between"><span class="faint" style="font-size:11.5px">Type</span><span class="row-value">' + esc(item.type) + '</span></div>'
          + '<div class="row-between"><span class="faint" style="font-size:11.5px">Quantity</span><span class="row-value">' + qty + '</span></div>'
          + (action ? '<div class="row-between"><span class="faint" style="font-size:11.5px">Action</span><span class="row-value">' + esc(action.label) + '</span></div>'
            + '<button class="btn btn-ghost btn-sm" type="button" data-bot="' + esc(action.cmd) + '" aria-label="' + esc(action.label + ': ' + action.cmd) + '">'
            + ico('external') + esc(action.cmd) + '</button>'
            : '')
          + '</div>'
        : '')
      + '</div>';
  }

  function pageInventory() {
    if (!state.data) return loadingPage('Inventory', 'Loading inventory…') + errorCard();
    const inv = state.data.inventory || [];
    const groups = INVENTORY_SECTIONS.map(([key, label, icon, empty]) => {
      const items = inv.filter((x) => {
        const t = String(x.type || '').toLowerCase();
        if (key === 'shinobi') return t === 'shinobi' || t === 'character';
        if (key === 'other') return !['shinobi', 'character', 'jutsu', 'gift', 'chakra'].includes(t);
        return t === key;
      });
      if (key === 'other' && !items.length) return '';
      return sectionTitle(label, icon, items.length ? items.length + ' item' + (items.length === 1 ? '' : 's') : empty)
        + (items.length
          ? '<div class="stack tight">' + items.map(inventoryItem).join('') + '</div>'
          : '<div class="empty">' + ico(icon) + '<strong>Nothing here yet</strong><span>' + esc(empty) + '</span></div>');
    }).join('');
    const total = inv.reduce((sum, x) => sum + (Number(x.qty) || 1), 0);
    return pageBar('Inventory', 'Home') + '<p class="page-lead">' + fmt(total) + ' items stored on your bot account.</p>'
      + errorCard() + flashCard()
      + (inv.length ? groups : '<div class="empty">' + ico('inventory') + '<strong>Your inventory is empty</strong><span>Visit the Shinobi Store to recruit your first shinobi.</span></div>')
      + '<button class="btn btn-ghost btn-block" type="button" data-action="retry">' + ico('refresh') + 'Refresh inventory</button>';
  }

  // ------------------------------------------------------------------ store --
  const STORE_GROUPS = [
    ['shinobi', 'Shinobi', 'shinobi'],
    ['jutsu', 'Jutsu', 'jutsu'],
    ['chakra', 'Chakra', 'chakra'],
  ];

  function storeCard(item) {
    const isChakra = item.type === 'chakra';
    const owned = !isChakra && item.owned;
    const tone = item.type === 'jutsu' ? 'violet' : isChakra ? 'gold' : '';
    const name = isChakra ? 'Chakra' : item.name;
    const sub = isChakra ? '× ' + fmt(item.qty || 100) + ' · repeatable' : owned ? 'Owned' : 'One-time unlock';
    const button = owned
      ? '<button class="btn-buy owned" type="button" disabled aria-disabled="true">' + ico('check') + ' Owned</button>'
      : '<button class="btn-buy" type="button" data-confirm-buy="' + esc(name) + '" aria-label="Buy ' + esc(name) + ' for ' + fmt(item.price) + ' coins" '
        + (state.buying ? 'disabled' : '') + '>' + ico('plus') + ' Buy</button>';
    return '<article class="store-card ' + tone + (owned ? ' owned' : '') + '">'
      + '<div class="store-art">' + artFor(item, name, item.type) + '</div>'
      + '<div class="store-name">' + esc(name) + '</div>'
      + '<div class="store-meta"><span class="price">' + ico('coin') + fmt(item.price) + '</span><span class="faint" style="font-size:9.5px">' + esc(sub) + '</span></div>'
      + button + '</article>';
  }

  function pageStore() {
    if (!state.data) return loadingPage('Shinobi Store', 'Loading catalogue…') + errorCard();
    const items = state.data.store || [];
    const balance = state.data.balance ? state.data.balance.coins : 0;
    const groups = STORE_GROUPS.map(([type, label, icon]) => {
      const list = items.filter((x) => x.type === type);
      if (!list.length) return '';
      const pack = list[0];
      return sectionTitle(label, icon, type === 'chakra'
        ? 'Repeatable · ' + fmt(pack.qty || 100) + ' chakra per purchase'
        : 'One-time unlocks')
        + '<div class="store-grid">' + list.map(storeCard).join('') + '</div>';
    }).join('');
    return pageBar('Shinobi Store', 'Home') + '<p class="page-lead">Prices come from the bot catalogue. The bot checks and charges every purchase.</p>'
      + errorCard() + flashCard()
      + '<div class="card flat"><div class="row-between"><span class="faint" style="font-size:11.5px">Your balance</span>'
      + '<span class="row-value">' + fmt(balance) + ' ' + ico('coin') + '</span></div></div>'
      + (items.length ? groups : '<div class="empty">' + ico('store') + '<strong>The store is empty</strong><span>Try again in a moment.</span></div>');
  }

  function sheetHtml() {
    if (!state.confirm || !state.data) return '';
    const name = state.confirm;
    const items = state.data.store || [];
    const item = items.find((i) => i.name === name);
    if (!item) return '';
    const isChakra = item.type === 'chakra';
    const balance = Number(state.data.balance && state.data.balance.coins) || 0;
    const price = Number(item.price) || 0;
    const after = balance - price;
    return '<div class="scrim" data-scrim="1">'
      + '<div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title">'
      + '<div class="sheet-head"><span class="row-art lg ' + (item.type === 'jutsu' ? 'violet' : isChakra ? 'gold' : '') + '">'
      + artFor(item, isChakra ? 'Chakra' : item.name, item.type) + '</span>'
      + '<div class="grow"><h2 id="sheet-title">Buy ' + esc(isChakra ? 'Chakra' : item.name) + '?</h2>'
      + '<div class="faint" style="font-size:11.5px">' + esc(isChakra ? '× ' + fmt(item.qty || 100) + ' chakra · repeatable' : 'One-time unlock') + '</div></div>'
      + '<button class="icon-btn sheet-close" type="button" data-action="cancel-purchase" aria-label="Close purchase dialog">' + ico('close') + '</button></div>'
      + '<p>' + fmt(price) + ' Konoha coins will be taken from your balance. '
      + (after >= 0 ? 'Balance after: ' + fmt(after) + ' coins.' : 'You are ' + fmt(Math.abs(after)) + ' coins short — the bot will refuse the purchase.')
      + '</p>'
      + '<div class="btn-row">'
      + '<button class="btn btn-ghost" type="button" data-action="cancel-purchase">Cancel</button>'
      + '<button class="btn btn-primary" type="button" data-action="confirm-purchase" ' + (state.buying ? 'disabled aria-busy="true"' : '') + '>'
      + (state.buying ? '<span class="spinner"></span>Buying…' : ico('coin') + 'Confirm purchase') + '</button>'
      + '</div></div></div>';
  }

  // -------------------------------------------------------------- abilities --
  function abilityOwnership(name) {
    if (roster().some((r) => G.matches(name, r.name))) return 'owned';
    const n = String(name || '').toLowerCase();
    if (n.indexOf('mind transmission') >= 0) {
      return jutsu().some((j) => /mind/i.test(j)) ? 'owned' : 'locked';
    }
    if (n === 'rank' || n === 'profile') return 'always';
    return 'locked';
  }

  function abilityCard(row) {
    const name = String(row.name == null ? '' : row.name);
    const desc = String(row.description == null ? '' : row.description);
    const cmds = G.commandsIn(row.description);
    const cooldown = G.cooldownIn(row.description);
    const owned = abilityOwnership(name);
    const kind = G.abilityKind(row.description);
    const tone = kind === 'active' ? '' : 'violet';
    return '<article class="card flat ability-card">'
      + '<div class="ability-head"><span class="row-art ' + tone + '">' + artFor(null, name, kind === 'active' ? 'shinobi' : 'jutsu') + '</span>'
      + '<div class="ability-title"><strong>' + esc(name) + '</strong>'
      + '<span class="faint" style="font-size:10.5px;letter-spacing:.08em;text-transform:uppercase">' + (kind === 'active' ? 'Active' : 'Passive') + '</span></div>'
      + '<span class="chip ' + (owned === 'owned' || owned === 'always' ? 'good' : 'plain') + '">'
      + ico(owned === 'owned' || owned === 'always' ? 'check' : 'lock')
      + (owned === 'always' ? 'Always on' : owned === 'owned' ? 'Ready' : 'Locked') + '</span></div>'
      + (desc ? '<p class="ability-desc">' + esc(desc) + '</p>' : '')
      + '<div class="ability-meta">'
      + (cooldown ? '<span class="chip warn">' + ico('clock') + esc(cooldown) + ' window</span>' : '')
      + cmds.map((c) => '<code class="cmd">' + esc(c) + '</code>').join('')
      + (owned === 'locked' ? '<span class="chip plain">' + ico('info') + 'Unlock first</span>' : '')
      + '</div></article>';
  }

  function levelsSection() {
    const d = state.data && state.data.levels;
    if (!d) return '';
    const milestones = Array.isArray(d.itachiMilestones) ? d.itachiMilestones : [];
    const kills = Number(d.kills) || 0;
    const itachi = ownsItachi();
    let currentLevel = 0;
    milestones.forEach((m, index) => { if (kills >= Number(m.kills)) currentLevel = index + 1; });
    const rows = milestones.map((m, index) => {
      const done = kills >= Number(m.kills);
      const current = itachi && index + 1 === currentLevel;
      const cls = 'milestone ' + (done ? 'done' : '') + (current ? ' current' : '');
      return '<div class="' + cls + '"><span class="lv">Lv. ' + esc(m.level) + '</span>'
        + '<span class="name">' + esc(m.title) + '</span>'
        + '<span class="gain">' + esc(m.robGain) + '%</span></div>';
    }).join('');
    return sectionTitle('Level-up progress', 'trophy', 'Itachi levels by successful kills · rob chance per level')
      + '<div class="card">'
      + '<div class="row-between"><span class="chip ' + (itachi ? 'good' : 'plain') + '">' + ico(itachi ? 'check' : 'lock') + (itachi ? 'Itachi owned' : 'Itachi not owned') + '</span>'
      + '<span class="row-value">' + fmt(kills) + ' kills</span></div>'
      + '<div class="stack tight" style="margin-top:10px">' + rows + '</div>'
      + '<div class="divider" style="margin:12px 0"></div>'
      + '<div class="row-between"><span class="faint" style="font-size:11.5px">Next milestone</span><span class="row-value">' + esc(d.next || '—') + '</span></div>'
      + '<div class="row-between" style="margin-top:6px"><span class="faint" style="font-size:11.5px">Sakura training</span><span class="row-value">' + esc(d.sakura || '—') + '</span></div>'
      + '</div>';
  }

  function pageAbilities() {
    if (!state.data) return loadingPage('Abilities', 'Loading abilities…') + errorCard();
    const rows = state.data.abilities || [];
    const active = rows.filter((r) => G.abilityKind(r.description) === 'active');
    const passive = rows.filter((r) => G.abilityKind(r.description) !== 'active');
    const eq = equipped();
    return pageBar('Abilities', 'Home') + '<p class="page-lead">Active abilities are triggered with commands; passives are always on.</p>'
      + errorCard() + flashCard()
      + sectionTitle('Equipped shinobi', 'users', eq.length + ' of 3 slots used · the bot allows a maximum of three')
      + slotRow(eq)
      + sectionTitle('Active abilities', 'kunai', 'Trigger with the command shown — in the bot chat.')
      + (active.length ? '<div class="stack">' + active.map(abilityCard).join('') + '</div>' : '<div class="empty">' + ico('ability') + '<strong>No active abilities</strong><span>The bot did not return any command-based abilities.</span></div>')
      + sectionTitle('Passive abilities', 'shield', 'Always applied to your account.')
      + (passive.length ? '<div class="stack">' + passive.map(abilityCard).join('') + '</div>' : '<div class="empty">' + ico('shield') + '<strong>No passives</strong><span>Nothing to show yet.</span></div>')
      + levelsSection();
  }

  // ------------------------------------------------------------------ gifts --
  function pageGifts() {
    if (!state.data) return loadingPage('Gift Store', 'Loading gifts…') + errorCard();
    const gifts = state.data.gifts || [];
    return pageBar('Gift Store', 'Home') + '<p class="page-lead">Ino\'s catalogue. Gifts are sent in groups, never from the Mini App.</p>'
      + errorCard() + flashCard()
      + (gifts.length
        ? '<div class="gift-grid">' + gifts.map((g) =>
          '<article class="gift-card"><div class="gift-art">' + artFor(g, g.name, 'gift') + '</div>'
          + '<div class="gift-name">' + esc(g.name) + '</div>'
          + '<div class="gift-foot"><span class="gift-num">#' + esc(g.id) + '</span>'
          + '<span class="price">' + ico('coin') + fmt(g.price) + '</span></div></article>').join('') + '</div>'
        : '<div class="empty">' + ico('gift') + '<strong>The catalogue is empty</strong><span>Try again in a moment.</span></div>')
      + '<div class="notice" role="note">' + ico('info')
      + '<div><strong>How to send a gift (group only)</strong>'
      + '<div>Reply to the member in a group where @' + esc(C.BOT_USERNAME) + ' is present, then send <code class="cmd">/gift 3</code> using the catalogue number above. You cannot gift yourself, and nothing is charged here.</div>'
      + '</div></div>'
      + '<button class="btn btn-ghost btn-block" type="button" data-bot="/gift_store" aria-label="Open the bot to copy the gift store command">'
      + ico('external') + 'Open /gift_store in the bot</button>';
  }

  // -------------------------------------------------------------------- map --
  const LOCATIONS = [
    ['hokage', 'hokage', 'Hokage Office', 'Claim pending rewards · earn here'],
    ['ichiraku', 'ramen', 'Ichiraku Ramen', 'Buy ramen · restore chakra'],
    ['bbq', 'bbq', 'BBQ', 'Recover exhausted shinobi'],
    ['gate', 'gate', 'Village Gate', 'Patrols and missions start here'],
    ['training', 'training', 'Training Ground', 'Tsunade training sessions'],
    ['hotsprings', 'hotsprings', 'Hot Springs', 'Slow chakra recovery'],
    ['store', 'store', 'Stores', 'Shinobi and item shops'],
  ];

  function pageMap() {
    return pageBar('Konoha Map', 'Home') + '<p class="page-lead">The village lives in the bot chat. Open the map there to move.</p>'
      + errorCard()
      + '<section class="map-hero">' + art('village', 'village') + '<span class="chip good">' + ico('check') + 'Hidden Leaf · playable</span>'
      + '<h2>Hidden Leaf Village</h2><p>Every location, mission and reward is handled by the bot. Nothing here is a copy of your balance.</p>'
      + '<button class="btn btn-primary" type="button" data-start="mini_map" aria-label="Open the Konoha map in the bot">'
      + ico('map') + 'Open Konoha Map</button></section>'
      + sectionTitle('Locations', 'map', 'Open the map in the bot to enter one')
      + '<div class="loc-grid">' + LOCATIONS.map(([, icon, name, desc]) =>
        '<div class="loc"><span class="loc-icon">' + ico(icon) + '</span><span class="loc-body"><strong>' + esc(name) + '</strong><small>' + esc(desc) + '</small></span></div>').join('')
      + '</div>'
      + '<div class="notice warn">' + ico('lock')
      + '<div><strong>Hidden Sand Village</strong><div>Not playable yet — the bot shows it as locked.</div></div></div>';
  }

  // ------------------------------------------------------------------- more --
  function commandRow(cmd, icon, title, desc, group) {
    return '<button class="row" type="button" data-bot="' + esc(cmd) + '" aria-label="Open the bot to use ' + esc(cmd) + ': ' + esc(title) + '">'
      + '<span class="row-art">' + ico(icon) + '</span>'
      + '<span class="row-body"><strong>' + esc(title) + '</strong><small>' + esc(desc) + '</small></span>'
      + '<span class="row-end">' + (group ? '<span class="tag">Group</span>' : '') + '<span class="cmd">' + esc(cmd) + '</span>' + ico('chevron-right') + '</span>'
      + '</button>';
  }

  function pageMore() {
    return pageBar('More', 'Home') + '<p class="page-lead">Everything else the bot can do, without leaving your account behind.</p>'
      + errorCard() + flashCard()
      + sectionTitle('Your account', 'profile')
      + '<div class="list">'
      + '<button class="row" type="button" data-page="profile"><span class="row-art">' + ico('profile') + '</span>'
      + '<span class="row-body"><strong>Profile</strong><small>Rank, XP, roster and jutsu</small></span>'
      + '<span class="row-end">' + ico('chevron-right') + '</span></button>'
      + '<a class="row" href="/profile.html"><span class="row-art">' + ico('external') + '</span>'
      + '<span class="row-body"><strong>Full profile page</strong><small>Standalone page · same record</small></span>'
      + '<span class="row-end">' + ico('chevron-right') + '</span></a>'
      + commandRow('/pet', 'paw', 'Pets', 'Feed, play, train and equip companions')
      + commandRow('/lb', 'trophy', 'Leaderboard', 'Global and group coin rankings')
      + commandRow('/equip', 'users', 'Equip shinobi', 'Three active shinobi at most')
      + '</div>'
      + sectionTitle('Community', 'users')
      + '<div class="list">'
      + '<button class="row" type="button" data-page="feedback"><span class="row-art good">' + ico('feedback') + '</span>'
      + '<span class="row-body"><strong>Feedback</strong><small>Bugs, ideas and reviews for the owner</small></span>'
      + '<span class="row-end">' + ico('chevron-right') + '</span></button>'
      + '<button class="row" type="button" data-page="channel"><span class="row-art good">' + ico('channel') + '</span>'
      + '<span class="row-body"><strong>Official channel</strong><small>Updates and announcements</small></span>'
      + '<span class="row-end">' + ico('chevron-right') + '</span></button>'
      + '</div>'
      + sectionTitle('Group actions', 'swords', 'These need a group where the bot is present')
      + '<div class="list">'
      + commandRow('/mission', 'mission', 'Mission', 'Send a shinobi on a mission', true)
      + commandRow('/patrol', 'shield', 'Patrol', 'Patrol the village for coins', true)
      + commandRow('/gift', 'gift', 'Send a gift', 'Reply to a member, then /gift number', true)
      + commandRow('/kill', 'kunai', 'Kill a target', 'Reply to a member with Itachi equipped', true)
      + commandRow('/games', 'game', 'Games', 'XOXO and rock-paper-scissors lobbies', true)
      + '</div>'
      + '<div class="notice">' + ico('info')
      + '<div>Every number on these screens is read from your bot account with Telegram\'s signed session. No balance is stored in the Mini App.</div></div>';
  }

  function pageFeedback() {
    return pageBar('Feedback', 'More')
      + '<section class="card glow"><div class="identity"><span class="row-art lg good">' + ico('feedback') + '</span>'
      + '<div class="grow"><h2 class="who" style="font-size:17px">We are listening</h2>'
      + '<p class="handle">Bugs, ideas and reviews reach the owner directly.</p></div></div>'
      + '<div class="stack tight" style="margin-top:14px">'
      + '<div class="row-between"><span class="faint" style="font-size:12px">Report a bug</span><span class="chip">' + ico('alert') + 'Bug</span></div>'
      + '<div class="row-between"><span class="faint" style="font-size:12px">Suggest a feature</span><span class="chip violet">' + ico('spark') + 'Idea</span></div>'
      + '<div class="row-between"><span class="faint" style="font-size:12px">Share a review</span><span class="chip good">' + ico('star') + 'Review</span></div>'
      + '</div>'
      + '<a class="btn btn-primary btn-block" style="margin-top:14px" href="https://t.me/' + esc(C.BOT_USERNAME) + '?start=owner" data-url="https://t.me/' + esc(C.BOT_USERNAME) + '?start=owner">'
      + ico('feedback') + 'Send feedback</a>'
      + '<p class="section-hint" style="margin-top:8px">Opens the bot in a private chat so your message stays between you and the owner.</p>'
      + '</section>';
  }

  function pageChannel() {
    return pageBar('Official channel', 'More')
      + '<section class="card glow"><div class="identity"><span class="row-art lg good">' + ico('channel') + '</span>'
      + '<div class="grow"><h2 class="who" style="font-size:17px">𝑭𝒓<span class="brand-flake" aria-hidden="true">❄️</span>𝒛𝒆𝒏 𝑩𝒍𝒐𝒐𝒅𝒆𝒅</h2>'
      + '<p class="handle">Announcements, updates and new features.</p></div></div>'
      + '<p class="ability-desc">The channel is the only place where new releases and event schedules are posted. Join it to stay in sync with the bot.</p>'
      + '<a class="btn btn-primary btn-block" style="margin-top:14px" href="https://t.me/frozenblooded" data-url="https://t.me/frozenblooded" target="_blank" rel="noopener">'
      + ico('channel') + 'Open the channel</a>'
      + '</section>'
      + '<div class="notice">' + ico('info') + '<div>This is the same link the bot shares in /help.</div></div>';
  }

  // -------------------------------------------------------------- rendering --
  const PAGES = {
    home: pageHome,
    profile: pageProfile,
    inventory: pageInventory,
    store: pageStore,
    abilities: pageAbilities,
    gifts: pageGifts,
    map: pageMap,
    more: pageMore,
    feedback: pageFeedback,
    channel: pageChannel,
  };

  let root;

  function render() {
    if (!root) return;
    const view = PAGES[state.page] || PAGES.home;
    try {
      root.innerHTML = shell(view());
      syncBackButton();
    } catch (e) {
      state.error = e;
      root.innerHTML = shell('<div class="notice error" role="alert">' + ico('alert')
        + '<div><strong>This screen could not be drawn.</strong><div>' + esc(e && e.message ? e.message : String(e)) + '</div>'
        + '<div class="notice-actions"><button class="btn btn-ghost btn-sm" type="button" data-action="retry">' + ico('refresh') + 'Retry</button></div></div></div>');
    }
  }

  function syncBackButton() {
    try {
      const bb = tg && tg.BackButton;
      if (!bb) return;
      if (state.stack.length) bb.show();
      else bb.hide();
    } catch (_) {}
  }

  function navigate(page) {
    if (!PAGES[page] || page === state.page) return;
    state.stack.push(state.page);
    state.page = page;
    state.error = null;
    state.flash = null;
    state.confirm = null;
    state.detail = null;
    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function goNav(page) {
    if (!PAGES[page]) return;
    state.stack = [];
    state.page = page;
    state.error = null;
    state.flash = null;
    state.confirm = null;
    state.detail = null;
    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function back() {
    state.page = state.stack.pop() || 'home';
    state.error = null;
    state.flash = null;
    state.confirm = null;
    state.detail = null;
    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function openExternal(url) {
    if (!url) return;
    if (tg && /^https:\/\/t\.me\//i.test(url) && typeof tg.openTelegramLink === 'function') tg.openTelegramLink(url);
    else if (tg && typeof tg.openLink === 'function') tg.openLink(url);
    else window.open(url, '_blank', 'noopener,noreferrer');
  }

  function launchStart(payload) {
    if (!C.BOT_STARTS[payload]) return;
    openExternal('https://t.me/' + C.BOT_USERNAME + '?start=' + encodeURIComponent(payload));
  }

  function openBot(command) {
    if (command && typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
      try { const p = navigator.clipboard.writeText(command); if (p && p.catch) p.catch(() => {}); } catch (_) {}
    }
    openExternal('https://t.me/' + C.BOT_USERNAME);
  }

  // ------------------------------------------------------------------ data --
  async function refresh() {
    if (state.claiming) return;
    const quiet = !!state.data;
    if (!quiet) render();
    state.error = null;
    try {
      const { dashboard } = takeDashboard(await serverlessCall({ action: 'bootstrap' }));
      state.data = dashboard;
    } catch (e) {
      state.error = e;
    } finally {
      render();
    }
  }

  async function claim() {
    if (state.claiming || claimedToday()) return;
    state.claiming = true;
    state.error = null;
    state.flash = null;
    render();
    try {
      const payload = C.unwrapPayload(await serverlessCall({ action: 'claim' }));
      if (!payload || !payload.claim || !C.isDashboard(payload.dashboard)) {
        throw Object.assign(new Error('Claim returned an unexpected payload. Check the bot before claiming again.'), { type: 'BAD_PAYLOAD' });
      }
      state.lastClaim = payload;
      state.data = payload.dashboard;
      state.flashKind = payload.claim.claimed ? 'good' : 'info';
      state.flash = payload.claim.claimed
        ? 'Reward paid by the bot. Streak is now day ' + fmt(payload.claim.streak) + ' of 7.'
        : 'Already claimed today. Nothing was paid twice.';
    } catch (e) {
      state.error = e;
    } finally {
      state.claiming = false;
      render();
    }
  }

  async function buy(name) {
    if (state.buying || !name) return;
    state.buying = true;
    state.error = null;
    state.flash = null;
    render();
    try {
      const payload = C.unwrapPayload(await serverlessCall({ action: 'purchase', itemName: name }));
      if (!payload || !payload.purchase || !C.isDashboard(payload.dashboard)) {
        throw Object.assign(new Error('Purchase returned an unexpected payload. Check your balance in the bot.'), { type: 'BAD_PAYLOAD' });
      }
      state.data = payload.dashboard;
      state.confirm = null;
      const r = payload.purchase;
      state.flashKind = r.status === 'ok' ? 'good' : 'info';
      if (r.status === 'ok') state.flash = 'Purchased ' + name + '. New balance: ' + fmt(r.balance) + ' coins.';
      else if (r.status === 'owned') state.flash = 'You already own this. No coins were taken.';
      else if (r.status === 'insufficient') state.flash = 'Not enough coins. Balance: ' + fmt(r.balance) + '.';
      else if (r.status === 'duplicate') state.flash = 'That purchase was already recorded.';
      else if (r.status === 'failed' && !r.safe) state.flash = 'Uncertain result. Do not retry yet — check the bot balance.';
      else state.flash = 'Purchase was not completed. No coins were taken.';
      if (r.status === 'failed') state.flashKind = 'error';
    } catch (e) {
      state.error = e;
    } finally {
      state.buying = false;
      render();
    }
  }

  // ---------------------------------------------------------------- events --
  document.addEventListener('click', async (event) => {
    const link = event.target.closest('a[data-url]');
    if (link && root && root.contains(link)) {
      event.preventDefault();
      openExternal(link.dataset.url);
      return;
    }
    const button = event.target.closest('button');
    if (!button || !root || !root.contains(button)) return;

    const action = button.dataset.action;
    if (action === 'back') { back(); return; }
    if (action === 'retry') { await refresh(); return; }
    if (action === 'claim') { await claim(); return; }
    if (action === 'cancel-purchase') { state.confirm = null; render(); return; }
    if (action === 'confirm-purchase') { await buy(state.confirm); return; }

    if (button.dataset.nav) { goNav(button.dataset.nav); return; }
    if (button.dataset.page) { navigate(button.dataset.page); return; }
    if (button.dataset.start) { launchStart(button.dataset.start); return; }
    if (button.dataset.bot) { openBot(button.dataset.bot); return; }
    if (button.dataset.confirmBuy) {
      state.confirm = button.dataset.confirmBuy;
      state.flash = null;
      state.error = null;
      render();
      return;
    }
    if (button.dataset.detail) {
      state.detail = state.detail === button.dataset.detail ? null : button.dataset.detail;
      render();
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && state.confirm) {
      state.confirm = null;
      render();
    }
  });

  document.addEventListener('click', (event) => {
    if (event.target && event.target.classList && event.target.classList.contains('scrim')) {
      state.confirm = null;
      render();
    }
  });

  // ------------------------------------------------------------ deep links --
  function openDeepLink() {
    let want = '';
    try { want = new URLSearchParams(window.location.search).get('page') || ''; } catch (_) {}
    if (!want && tg && tg.initDataUnsafe && tg.initDataUnsafe.start_param) {
      want = String(tg.initDataUnsafe.start_param);
    }
    const map = {
      home: 'home', store: 'store', inventory: 'inventory', abilities: 'abilities',
      gifts: 'gifts', map: 'map', more: 'more', profile: 'profile',
      feedback: 'feedback', channel: 'channel', mini_map: 'map', mini_claim: 'home', mini_owner: 'feedback',
    };
    const page = map[want];
    if (page && page !== 'home') {
      state.stack = ['home'];
      state.page = page;
    }
  }

  function boot() {
    root = document.getElementById('app');
    if (!root || root.dataset.booted === '1') return;
    root.dataset.booted = '1';
    openDeepLink();
    render();
    if (serverlessAvailable()) refresh();
    else {
      state.error = Object.assign(new Error('Open this Mini App from the bot inside Telegram.'), { type: 'UNAVAILABLE', status: 0 });
      render();
    }
  }

  // Small public surface used by deep links and the local UI tests.
  window.FBApp = { navigate: goNav, current: () => state.page, refresh };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
