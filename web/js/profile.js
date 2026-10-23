/* Miss Frozen — standalone profile page.
   Reads the signed-in user's existing /profile record through the getProfile
   endpoint and renders it with the frozen design system. Every value is
   inserted as text; nothing from the bot is interpreted as HTML. */
(function () {
  const tg = window.Telegram && window.Telegram.WebApp;
  const doc = document;
  const stateBox = doc.getElementById('profile-state');
  const content = doc.getElementById('profile-content');
  const retry = doc.getElementById('profile-retry');

  const I = window.FBIcons || null;
  const G = window.FBGame || {
    fmt: (v) => (v == null || v === '' ? '—' : String(v)),
    rankProgress: () => ({ tier: 1, tiers: 6, rank: 'Academy Student', pct: 0, maxed: false, label: '—' }),
    stripEmoji: (v) => String(v == null ? '' : v),
    initial: (v) => String(v || 'S').charAt(0).toUpperCase(),
  };

  if (tg) {
    try { tg.ready(); } catch (_) {}
    try { tg.expand(); } catch (_) {}
    try {
      tg.setHeaderColor('#eef8ff');
      tg.setBackgroundColor('#eef8ff');
    } catch (_) {}
  }

  function element(tag, className, text) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = String(text);
    return node;
  }

  /** setAttribute is optional so the page also runs in restricted clients. */
  function attr(node, name, value) {
    if (node && typeof node.setAttribute === 'function') node.setAttribute(name, value);
    return node;
  }

  function iconNode(name) {
    if (I && typeof I.svgNode === 'function') {
      const node = I.svgNode(name);
      if (node) return node;
    }
    return element('span', 'ico-fallback');
  }

  function setState(message, isError) {
    stateBox.textContent = String(message);
    stateBox.className = isError ? 'notice error' : 'notice';
    attr(stateBox, 'role', isError ? 'alert' : 'status');
  }

  function setLoading() {
    content.replaceChildren();
    retry.hidden = true;
    setState('Loading your profile from the bot…', false);
  }

  function displayNumber(value) {
    if (value == null || value === '') return '—';
    return G.fmt(value);
  }

  function chip(label, iconName, tone) {
    const box = element('span', 'chip' + (tone ? ' ' + tone : ''));
    if (iconName) box.append(iconNode(iconName));
    box.append(element('span', null, label));
    return box;
  }

  function addStat(target, label, value) {
    const box = element('div', 'mini-stat');
    box.append(element('small', null, label));
    box.append(element('strong', null, value));
    target.append(box);
  }

  function addSectionTitle(target, title, iconName, hint) {
    const head = element('div', 'section-title');
    if (iconName) head.append(iconNode(iconName));
    head.append(element('span', null, title));
    target.append(head);
    if (hint) target.append(element('p', 'section-hint', hint));
  }

  function avatarNode(name) {
    const box = element('div', 'avatar ring');
    attr(box, 'role', 'img');
    attr(box, 'aria-label', 'Your profile picture');
    let photo = '';
    try {
      const user = tg && tg.initDataUnsafe && tg.initDataUnsafe.user;
      if (user && user.photo_url) photo = String(user.photo_url);
    } catch (_) {}
    if (photo) {
      const img = doc.createElement('img');
      img.alt = '';
      img.decoding = 'async';
      img.src = photo;
      img.addEventListener('error', () => { if (img.style) img.style.display = 'none'; });
      box.append(img);
    }
    box.append(element('span', 'avatar-fallback', G.initial(name)));
    return box;
  }

  function progressBar(percent) {
    const bar = doc.createElement('progress');
    bar.className = 'xp';
    bar.max = 100;
    bar.value = percent;
    attr(bar, 'aria-label', 'Rank progress ' + percent + ' percent');
    return bar;
  }

  function identityCard(profile) {
    const info = G.rankProgress(profile.xp);
    const card = element('section', 'hero');

    const row = element('div', 'identity');
    row.append(avatarNode(profile.displayName));
    const body = element('div', 'grow');
    body.append(element('h1', 'who', profile.displayName || 'Shinobi'));
    body.append(element('p', 'handle', profile.username ? '@' + profile.username : 'Telegram account'));

    const meta = element('div', 'id-meta');
    meta.append(chip('Lv. ' + info.tier, 'spark'));
    meta.append(chip(profile.rank || info.rank, 'trophy', 'violet'));
    if (profile.globalRank != null) meta.append(chip('#' + G.fmt(profile.globalRank), 'users'));
    if (profile.life) {
      meta.append(chip(profile.life.alive ? 'Alive' : 'Dead', profile.life.alive ? 'shield' : 'alert', profile.life.alive ? 'good' : 'warn'));
    }
    body.append(meta);
    row.append(body);
    card.append(row);

    const xpRow = element('div', 'xp-row');
    xpRow.append(element('span', 'xp-label', 'Rank progress'));
    xpRow.append(element('span', 'xp-value', G.stripEmoji(profile.xpText || info.label)));
    card.append(xpRow);
    card.append(progressBar(info.pct));
    return card;
  }

  function statsCard(profile) {
    const card = element('section', 'card');
    addSectionTitle(card, 'Account stats', 'check');
    const grid = element('div', 'stat-grid two');
    addStat(grid, 'Coins', displayNumber(profile.balance));
    addStat(grid, 'Chakra', displayNumber(profile.chakra));
    addStat(grid, 'XP', displayNumber(profile.xp));
    addStat(grid, 'Kills', displayNumber(profile.kills));
    addStat(grid, 'Patrols', displayNumber(profile.narutoPatrols));
    addStat(grid, 'Claim streak', displayNumber(profile.streak) + ' / 7');
    addStat(grid, 'Last claim', profile.lastClaim || '—');
    addStat(grid, 'Global rank', profile.globalRank != null ? '#' + displayNumber(profile.globalRank) : '—');
    card.append(grid);
    return card;
  }

  function equippedCard(profile) {
    const list = Array.isArray(profile.equippedList) ? profile.equippedList
      : (profile.life && profile.life.equipped ? [profile.life.equipped] : []);
    const card = element('section', 'card');
    addSectionTitle(card, 'Equipped shinobi', 'users', list.length + ' of 3 slots used');
    const row = element('div', 'slot-row');
    for (let i = 0; i < 3; i += 1) {
      const name = list[i];
      const slot = element('div', 'slot ' + (name ? 'filled' : 'empty'));
      slot.append(iconNode(name ? 'profile' : 'plus'));
      slot.append(element('strong', null, name || 'Empty slot'));
      slot.append(element('small', null, 'Slot ' + (i + 1)));
      row.append(slot);
    }
    card.append(row);
    return card;
  }

  function rosterCard(profile) {
    const list = Array.isArray(profile.roster) ? profile.roster : [];
    const card = element('section', 'card');
    addSectionTitle(card, 'Roster', 'inventory', list.length ? list.length + ' shinobi owned' : 'No shinobi yet');
    if (!list.length) {
      card.append(element('p', 'profile-empty', 'No shinobi in your roster yet. Recruit one from the Shinobi Store.'));
      return card;
    }
    const rows = element('div', 'list');
    for (const item of list) {
      const row = element('div', 'row static');
      const art = element('span', 'row-art');
      art.append(iconNode('profile'));
      row.append(art);
      const body = element('span', 'row-body');
      body.append(element('strong', null, item.name || 'Shinobi'));
      body.append(element('small', null, 'Owned'));
      row.append(body);
      if (Number(item.qty) > 1) {
        const end = element('span', 'row-end');
        end.append(element('span', 'row-value', '×' + displayNumber(item.qty)));
        row.append(end);
      }
      rows.append(row);
    }
    card.append(rows);
    return card;
  }

  function jutsuCard(profile) {
    const list = Array.isArray(profile.jutsu) ? profile.jutsu : [];
    const card = element('section', 'card');
    addSectionTitle(card, 'Jutsu', 'ability', list.length ? list.length + ' unlocked' : 'Nothing unlocked yet');
    if (!list.length) {
      card.append(element('p', 'profile-empty', 'No jutsu unlocked yet. Mind Transmission Jutsu is in the Shinobi Store.'));
      return card;
    }
    const wrap = element('div', 'wrap');
    for (const name of list) wrap.append(chip(String(name), 'spark', 'violet'));
    card.append(wrap);
    return card;
  }

  function renderProfile(profile) {
    if (!profile || typeof profile !== 'object' ||
        !Array.isArray(profile.roster) || !Array.isArray(profile.jutsu) ||
        typeof profile.rank !== 'string') {
      throw new Error('Unexpected profile response');
    }

    content.replaceChildren();
    content.append(identityCard(profile));
    content.append(statsCard(profile));
    content.append(equippedCard(profile));
    content.append(rosterCard(profile));
    content.append(jutsuCard(profile));
    content.append(element('p', 'profile-footnote', 'Synced from your bot profile — the same record /profile shows.'));

    setState('Profile loaded from the bot.', false);
    retry.hidden = true;
  }

  function loadProfile() {
    setLoading();
    if (!tg || !tg.initData) {
      setState('Open this page from the bot inside Telegram to load your private profile.', true);
      retry.hidden = false;
      return;
    }
    const serverless = tg.Serverless;
    if (!serverless || typeof serverless.call !== 'function') {
      setState('Telegram profile service is unavailable in this client. Open the bot and try again.', true);
      retry.hidden = false;
      return;
    }
    try {
      serverless.call('getProfile', {}, (error, result) => {
        if (error) {
          setState('Your profile could not be loaded. Your bot data was not changed; please retry.', true);
          retry.hidden = false;
          return;
        }
        try {
          if (result && result.ok === true && Object.prototype.hasOwnProperty.call(result, 'result')) {
            result = result.result;
          }
          renderProfile(result);
        } catch (_) {
          setState('The profile response was incomplete. Nothing was guessed; please retry.', true);
          retry.hidden = false;
        }
      });
    } catch (_) {
      setState('Your profile could not be loaded. Your bot data was not changed; please retry.', true);
      retry.hidden = false;
    }
  }

  retry.addEventListener('click', loadProfile);
  loadProfile();
})();
