import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}]/u;
const ICON_SPAN = /<span class="ico emoji-icon[^"]*"[^>]*>([^<]*)<\/span>/g;

/** Payload shaped exactly like tgcloud/endpoints/miniapp.js dashboard(). */
function dashboard() {
  return {
    profile: {
      displayName: 'Kakashi', username: 'copy_ninja', rank: 'Jōnin', globalRank: 12,
      xp: 4200, xpText: '4,200 / 6,500 XP → Anbu', balance: 48250, chakra: 640, kills: 37,
      streak: 3, lastClaim: '2026-10-23', narutoPatrols: 12,
      life: { alive: true, label: 'Alive' },
      equippedList: ['Itachi', 'Sakura'],
      roster: [{ name: 'Itachi', emoji: '👁️', qty: 1 }, { name: 'Sakura', emoji: '🌸', qty: 1 }],
      jutsu: ['Mind Transmission Jutsu'],
    },
    today: '2026-10-24',
    balance: { coins: 48250, chakra: 640, pendingRewards: 1000, kills: 37 },
    inventory: [
      { type: 'shinobi', name: 'Itachi', qty: 1 },
      { type: 'jutsu', name: 'Mind Transmission Jutsu', qty: 1 },
      { type: 'chakra', name: 'Chakra', qty: 640 },
    ],
    store: [
      { name: 'Sasuke', emoji: '⚔️', price: 1500, type: 'shinobi', owned: false },
      { name: 'Itachi', emoji: '👁️', price: 2600, type: 'shinobi', owned: true },
      { name: 'Chakra', emoji: '⚡', price: 200, qty: 100, type: 'chakra', owned: false },
    ],
    abilities: [
      { name: 'Itachi', description: '👁️ kill & rob · /kill rewards by level' },
      { name: 'Rank', description: 'academy → kage' },
    ],
    levels: {
      kills: 37, current: 'current', next: 'next level at 75 kills', sakura: 'training',
      itachiMilestones: [{ level: 1, kills: 0, robGain: 20, title: 'anbu itachi' }],
    },
    gifts: [{ id: 1, name: "Konan's Rose", emoji: '🌹', price: 100 }],
  };
}

class Element {
  constructor(tag) {
    this.tagName = tag;
    this.dataset = {};
    this.className = '';
    this.textContent = '';
    this._html = '';
  }
  set innerHTML(value) { this._html = String(value); }
  get innerHTML() { return this._html; }
  contains() { return true; }
  addEventListener() {}
}

async function bootApp() {
  const rootEl = new Element('main');
  const document = {
    readyState: 'complete',
    getElementById: (id) => (id === 'app' ? rootEl : null),
    addEventListener: () => {},
    createElement: (tag) => new Element(tag),
  };
  const tg = {
    initDataUnsafe: { user: { first_name: 'Kakashi' } },
    ready() {}, expand() {}, setHeaderColor() {}, setBackgroundColor() {},
    openTelegramLink() {}, openLink() {},
    Serverless: { call(name, input, cb) { cb(null, dashboard()); } },
  };
  const sandbox = {
    document, console, location: { search: '' }, URLSearchParams, setTimeout, clearTimeout,
    navigator: { clipboard: null }, Telegram: { WebApp: tg },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.scrollTo = () => {};
  vm.createContext(sandbox);
  for (const file of ['contract.js', 'icons.js', 'game.js', 'streak.js', 'app.js']) {
    vm.runInContext(read('web', 'js', file), sandbox, { filename: 'web/js/' + file });
  }
  await new Promise((resolve) => setTimeout(resolve, 5));
  return { rootEl, app: sandbox.FBApp };
}

test('every screen renders colour emojis only (no SVG, no monochrome fallback)', async () => {
  const { rootEl, app } = await bootApp();
  assert.ok(app && typeof app.navigate === 'function', 'app booted');

  const pages = ['home', 'inventory', 'store', 'abilities', 'gifts', 'map', 'more', 'feedback', 'channel', 'profile'];
  for (const page of pages) {
    app.navigate(page);
    const html = rootEl.innerHTML;
    assert.ok(html.length > 2000, page + ' rendered');
    assert.doesNotMatch(html, /<svg|<img[^>]+\.svg/i, page + ' contains no SVG icon');
    assert.doesNotMatch(html, /ico-fallback/, page + ' has no monochrome fallback');

    const glyphs = [...html.matchAll(ICON_SPAN)].map((match) => match[1].trim());
    assert.ok(glyphs.length >= 6, page + ' renders icons (' + glyphs.length + ')');
    for (const glyph of glyphs) {
      assert.match(glyph, EMOJI, page + ' icon is a native emoji, got "' + glyph + '"');
    }

    // One footer on every screen, above the bottom navigation.
    assert.match(html, /class="app-footer"/, page + ' has the footer');
    assert.match(html, /credit-snowflake" aria-hidden="true">❄️</, page + ' keeps the snowflake emoji');
    assert.match(html, /MINI APP V2\.0 · SYNCED WITH @MISSFROZEN_BOT/, page + ' shows the version + sync line');
    assert.ok(html.indexOf('class="app-footer"') < html.indexOf('class="bottom-nav"'),
      page + ' footer comes before the bottom navigation');
  }
});

test('navigation, stats and rewards use the requested emojis', async () => {
  const { rootEl, app } = await bootApp();
  app.navigate('home');
  const home = rootEl.innerHTML;

  for (const [glyph, label] of [['🏠', 'Home'], ['🎒', 'Inventory'], ['🏪', 'Store'],
    ['✨', 'Abilities'], ['🗺️', 'Map'], ['📱', 'More']]) {
    assert.match(home, new RegExp(glyph + '</span><span>' + label + '</span>'),
      'bottom nav uses ' + glyph + ' for ' + label);
  }

  assert.match(home, /🪙<\/span><small>Konoha coins/, 'coins stat uses 🪙');
  assert.match(home, /🔮<\/span><small>Chakra/, 'chakra stat uses 🔮');
  assert.match(home, /🔥<\/span><small>Streak/, 'streak stat uses 🔥');
  assert.match(home, /📱<\/span><span>More<\/span>/, 'more tab uses 📱');
});

test('bot-provided emojis survive on store, gifts, roster and abilities', async () => {
  const { rootEl, app } = await bootApp();

  app.navigate('store');
  const store = rootEl.innerHTML;
  assert.match(store, /⚔️<\/span><\/div><div class="store-name">Sasuke/, 'store keeps the bot emoji for Sasuke');
  assert.match(store, /🔮<\/span><\/div><div class="store-name">Chakra/, 'chakra always uses 🔮, never the bot ⚡');
  assert.doesNotMatch(store, /⚡<\/span><\/div><div class="store-name">Chakra/, 'chakra is not rendered with ⚡');

  app.navigate('gifts');
  assert.match(rootEl.innerHTML, /🌹/, 'gift emoji from the bot is shown');

  app.navigate('abilities');
  const abilities = rootEl.innerHTML;
  assert.match(abilities, /👁️ kill &amp; rob/, 'ability label keeps the emoji from the bot');
  assert.match(abilities, /🧠|🥷|👁️/, 'ability artwork uses character emojis');

  app.navigate('profile');
  const profile = rootEl.innerHTML;
  assert.match(profile, /👁️<\/span><strong>Itachi/, 'roster keeps the Itachi emoji');
  assert.match(profile, /🌸<\/span><strong>Sakura/, 'roster keeps the Sakura emoji');
  assert.match(profile, /4,200 \/ 6,500 XP → Anbu/, 'XP text is not stripped');
});

test('the icon registry defines every name the UI asks for', async () => {
  const sandbox = { module: { exports: {} } };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read('web', 'js', 'icons.js'), sandbox, { filename: 'web/js/icons.js' });
  const icons = sandbox.FBIcons;
  assert.ok(icons, 'FBIcons is exported');

  const names = [
    'logo', 'snow', 'snowfall', 'home', 'inventory', 'store', 'ability', 'profile',
    'gift', 'map', 'more', 'feedback', 'channel', 'settings', 'coin', 'chakra',
    'streak', 'trophy', 'star', 'reward', 'claim', 'spark', 'check', 'lock', 'unlock',
    'plus', 'minus', 'close', 'refresh', 'external', 'info', 'alert', 'clock', 'play',
    'dot', 'chevron-right', 'chevron-left', 'paw', 'mission', 'shinobi', 'jutsu',
    'shield', 'swords', 'kunai', 'users', 'game', 'hokage', 'ramen', 'bbq',
    'training', 'hotsprings', 'gate',
  ];
  for (const name of names) assert.ok(icons.has(name), 'missing icon name: ' + name);
  assert.equal(icons.has('definitely-not-an-icon'), false, 'unknown names are reported as missing');
  assert.match(icons.icon('definitely-not-an-icon'), /✨/, 'unknown names fall back to a colour emoji');
  assert.doesNotMatch(icons.icon('home'), /<svg|<path/, 'icon markup never contains SVG');

  // Artwork slots resolve to emojis as well (never to SVG).
  for (const art of ['mask', 'sasuke', 'sakura', 'naruto', 'itachi', 'hinata', 'jiraiya',
    'jutsu', 'chakra', 'rose', 'ramen', 'peanuts', 'puppy', 'butterfly', 'hat',
    'rasengan', 'chidori', 'ring', 'sharingan', 'star', 'swords', 'crate', 'village',
    'coin', 'rank']) {
    assert.ok(icons.ART[art], 'missing artwork: ' + art);
  }
});
