import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

// Round 13 — the Mini App's "Equipped shinobi" cards were empty while the bot
// (/inventory, /equip) knew what was equipped. The list now comes from the same
// call as the bot, with a fallback chain that can never produce an empty array,
// and the Mini App re-reads the record when it comes back to the foreground.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...parts) => fs.readFileSync(path.join(repoRoot, ...parts), 'utf8');
const readOne = (rel) => read(...rel.split('/'));

test('the Mini App profile carries the bot equipped list, never an empty array', () => {
  const profile = readOne('tgcloud/lib/profile.js');
  assert.match(profile, /import \{ getEquippedList, getEquipped, getUserSkills, isAccountDead \} from '\.\/rpg\/state\.js';/);
  assert.doesNotMatch(profile, /await import\('\.\/rpg\/state\.js'\)/, 'no dynamic import that can fail silently');
  const block = profile.slice(profile.indexOf('let equippedList = []'), profile.indexOf('let globalRank = 1'));
  assert.match(block, /equippedList = await getEquippedList\(id\)/, 'same source as /inventory and /equip');
  assert.match(block, /equippedList = equippedList\.filter\(/, 'only real names reach the slots');
  assert.match(block, /if \(!equippedList\.length\)/, 'empty list is replaced');
  assert.match(block, /life\.equipped/, 'falls back to the primary equip the bot shows');
  assert.match(block, /'Starter Shinobi'/, 'and to the starter, like getEquippedList');
});

test('both Mini App surfaces render the equipped slots in order with a fallback', () => {
  const app = readOne('web/js/app.js');
  const equipped = app.slice(app.indexOf('function equipped() {'), app.indexOf('function ownsSakura()'));
  assert.match(equipped, /p\.equippedList/, 'reads the bot list');
  assert.match(equipped, /p\.life && p\.life\.equipped/, 'falls back to the primary equip');
  assert.match(equipped, /slice\(0, 3\)/, 'never more than three slots');
  assert.match(app, /function slotRow\(eq\)/, 'the slot row');
  assert.match(app, /function pageProfile\(\)[\s\S]*?slotRow\(eq\)/, 'profile page renders the slots');

  const profilePage = readOne('web/js/profile.js');
  const card = profilePage.slice(profilePage.indexOf('function equippedCard(profile)'), profilePage.indexOf('function rosterCard(profile)'));
  assert.match(card, /profile\.equippedList/, 'reads the bot list');
  assert.match(card, /raw\.length\s*\n?\s*\?\s*raw\.slice\(0, 3\)/, 'ordered, max three slots');
  assert.match(card, /profile\.life && profile\.life\.equipped/, 'falls back when the list is empty');
  assert.match(card, /for \(let i = 0; i < 3; i \+= 1\)/, 'three slot cards');
});

test('the Mini App re-reads the record when it returns to the foreground', () => {
  const app = readOne('web/js/app.js');
  assert.match(app, /function syncOnReturn\(\)/, 'foreground sync');
  assert.match(app, /tg\.onEvent\('activated', syncOnReturn\)/, 'Telegram activation');
  assert.match(app, /addEventListener\('visibilitychange'/, 'WebView visibility');
  assert.match(app, /watchForeground\(\);/, 'installed at boot');

  const profilePage = readOne('web/js/profile.js');
  assert.match(profilePage, /addEventListener\('visibilitychange'[\s\S]*?loadProfile\(\)/, 'profile page re-reads too');
  assert.match(profilePage, /tg\.onEvent\('activated', loadProfile\)/);

  const config = readOne('tgcloud.jsonc');
  assert.match(config, /"path": "\/js\/\*", "set": \{ "Cache-Control": "no-cache" \}/, 'a shipped fix is not served from cache');
  assert.match(config, /"path": "\/index\.html", "set": \{ "Cache-Control": "no-cache" \}/);
});

test('miniapp equipped end to end (slots, legacy column, failure, empty)', () => {
  const output = execFileSync(
    process.execPath,
    ['--experimental-loader', './test/helpers/sdk-loader.mjs', 'test/helpers/run_miniapp_equipped.mjs'],
    { cwd: new URL('..', import.meta.url), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  assert.match(output, /miniapp equipped: OK/);
});

// ---------------------------------------------------------------- rendering --
const ELEMENT = class Element {
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
};

/** Payload shaped exactly like tgcloud/endpoints/miniapp.js dashboard(). */
function dashboardWith(profilePatch) {
  return {
    profile: {
      displayName: 'Kakashi', username: 'copy_ninja', rank: 'Jōnin', globalRank: 4,
      xp: 4200, xpText: '4,200 / 6,500 XP → Anbu', balance: 1200, chakra: 40, kills: 2,
      streak: 2, lastClaim: '2026-10-25', narutoPatrols: 3,
      life: { alive: true, label: 'Alive' },
      equippedList: [], roster: [], jutsu: [],
      ...profilePatch,
    },
    today: '2026-10-25',
    balance: { coins: 1200, chakra: 40, kills: 2, pendingRewards: 0 },
    inventory: [],
    store: [],
    abilities: [],
    levels: null,
    gifts: [],
  };
}

/** Boot the real Mini App bundle against a fake Telegram WebView. */
async function bootApp(dashboards) {
  const rootEl = new ELEMENT('main');
  const listeners = {};
  const events = {};
  let calls = 0;
  const document = {
    readyState: 'complete',
    visibilityState: 'visible',
    getElementById: (id) => (id === 'app' ? rootEl : null),
    addEventListener: (name, fn) => { (listeners[name] = listeners[name] || []).push(fn); },
    createElement: (tag) => new ELEMENT(tag),
  };
  const tg = {
    initDataUnsafe: { user: { first_name: 'Kakashi' } },
    ready() {}, expand() {}, setHeaderColor() {}, setBackgroundColor() {},
    openTelegramLink() {}, openLink() {},
    onEvent: (name, fn) => { (events[name] = events[name] || []).push(fn); },
    Serverless: {
      call(_name, _input, cb) {
        calls += 1;
        cb(null, dashboards[Math.min(calls - 1, dashboards.length - 1)]);
      },
    },
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
    vm.runInContext(readOne('web/js/' + file), sandbox, { filename: 'web/js/' + file });
  }
  await new Promise((resolve) => setTimeout(resolve, 10));
  const fired = (name) => { for (const fn of listeners[name] || []) fn({ type: name }); };
  const telegramEvent = (name) => { for (const fn of events[name] || []) fn(); };
  return { rootEl, app: sandbox.FBApp, calls: () => calls, fired, telegramEvent };
}

const slots = (html) => ({
  filled: (html.match(/class="slot filled"/g) || []).length,
  empty: (html.match(/class="slot empty"/g) || []).length,
});

test('the profile page fills the three slot cards from equippedList', async () => {
  const { rootEl, app } = await bootApp([
    dashboardWith({ equippedList: ['Itachi', 'Sakura'], life: { alive: true, label: 'Alive', equipped: 'Itachi' } }),
  ]);
  app.navigate('profile');
  const html = rootEl.innerHTML;
  assert.equal(slots(html).filled, 2, 'two equipped slots are drawn as filled');
  assert.equal(slots(html).empty, 1, 'the free slot stays empty');
  assert.match(html, /<strong>Itachi<\/strong><small>Slot 1<\/small>/, 'slot 1 holds Itachi');
  assert.match(html, /<strong>Sakura<\/strong><small>Slot 2<\/small>/, 'slot 2 holds Sakura');
  assert.match(html, /2 of 3 slots/, 'the heading counts the equipped shinobi');
});

test('an older payload without equippedList still fills the primary slot', async () => {
  const { rootEl, app } = await bootApp([
    dashboardWith({ equippedList: undefined, life: { alive: true, label: 'Alive', equipped: 'Sakura' } }),
  ]);
  app.navigate('profile');
  const html = rootEl.innerHTML;
  assert.equal(slots(html).filled, 1, 'the primary equip fills a slot instead of three empty cards');
  assert.match(html, /<strong>Sakura<\/strong><small>Slot 1<\/small>/);
});

test('returning to the foreground re-syncs the equipped shinobi', async () => {
  const { rootEl, app, calls, fired, telegramEvent } = await bootApp([
    dashboardWith({ equippedList: [], life: { alive: true, label: 'Alive', equipped: 'Starter Shinobi' } }),
    dashboardWith({ equippedList: ['Naruto', 'Sasuke'], life: { alive: true, label: 'Alive', equipped: 'Naruto' } }),
  ]);
  app.navigate('profile');
  assert.equal(slots(rootEl.innerHTML).filled, 1, 'starts from the boot payload');

  // The player equipped two shinobi in the bot and comes back to the Mini App.
  fired('visibilitychange');
  await new Promise((resolve) => setTimeout(resolve, 10));
  app.navigate('profile');
  const synced = rootEl.innerHTML;
  assert.ok(calls() >= 2, 'the app re-read the record');
  assert.equal(slots(synced).filled, 2, 'the slots follow /equip immediately');
  assert.match(synced, /<strong>Naruto<\/strong><small>Slot 1<\/small>/);
  assert.match(synced, /<strong>Sasuke<\/strong><small>Slot 2<\/small>/);

  // The two events are de-duplicated: within the same return only one re-read.
  telegramEvent('activated');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(calls(), 2, 'visibility + activation together fetch once');

  // Telegram's own activation event (Bot API 8+) does the same on its own.
  const second = await bootApp([
    dashboardWith({ equippedList: [], life: { alive: true, label: 'Alive', equipped: 'Starter Shinobi' } }),
    dashboardWith({ equippedList: ['Hinata'], life: { alive: true, label: 'Alive', equipped: 'Hinata' } }),
  ]);
  second.telegramEvent('activated');
  await new Promise((resolve) => setTimeout(resolve, 10));
  second.app.navigate('profile');
  assert.ok(second.calls() >= 2, 'activation alone re-reads the record');
  assert.equal(slots(second.rootEl.innerHTML).filled, 1);
  assert.match(second.rootEl.innerHTML, /<strong>Hinata<\/strong><small>Slot 1<\/small>/);
});
