import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

test('profile Mini App calls only the existing authenticated getProfile endpoint', () => {
  const app = read('web', 'js', 'profile.js');
  assert.match(app, /serverless\.call\('getProfile',\s*\{\}/);
  assert.doesNotMatch(app, /serverless\.call\('miniapp'/);
  assert.doesNotMatch(app, /user_id|telegram_id|initDataUnsafe\.user\.id/);

  const endpoint = read('tgcloud', 'endpoints', 'getProfile.js');
  assert.match(endpoint, /ctx\?\.initData\?\.user/);
  assert.match(endpoint, /return profileData\(user\)/);
  assert.doesNotMatch(endpoint, /input\.user|input\.id/);
});

test('profile renderer inserts bot data as text, not HTML', () => {
  const app = read('web', 'js', 'profile.js');
  assert.match(app, /node\.textContent\s*=\s*String\(text\)/);
  assert.doesNotMatch(app, /innerHTML\s*=/);
});

test('profile UI loads from the bot-synced endpoint without trusting browser user IDs', () => {
  class FakeElement {
    constructor(tag) {
      this.tagName = tag;
      this.children = [];
      this.textContent = '';
      this.hidden = false;
      this.className = '';
      this.listeners = {};
    }
    append(node) { this.children.push(node); }
    replaceChildren(...nodes) { this.children = nodes; }
    addEventListener(name, callback) { this.listeners[name] = callback; }
  }

  const status = new FakeElement('div');
  const content = new FakeElement('section');
  const retry = new FakeElement('button');
  const calls = [];
  const profile = {
    displayName: '<img src=x onerror=alert(1)>', username: 'shinobi', rank: 'Genin',
    xp: 80, xpText: '80 / 500 XP → Genin', balance: 1200, chakra: 9, kills: 3,
    streak: 2, lastClaim: '2026-10-16', narutoPatrols: 0,
    roster: [{ name: 'Sakura', emoji: '🌸', qty: 1 }], jutsu: ['Clone Jutsu'],
  };
  const tg = {
    initData: 'signed-init-data',
    Serverless: {
      call(name, payload, callback) {
        calls.push({ name, payload });
        callback(null, profile);
      },
    },
    ready() {}, expand() {}, setHeaderColor() {}, setBackgroundColor() {},
  };
  const document = {
    getElementById(id) {
      return { 'profile-state': status, 'profile-content': content, 'profile-retry': retry }[id] || null;
    },
    createElement(tag) { return new FakeElement(tag); },
  };

  vm.runInNewContext(read('web', 'js', 'profile.js'), {
    window: { Telegram: { WebApp: tg } },
    document,
  });

  assert.deepEqual(calls.map((call) => call.name), ['getProfile']);
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0].payload)), {});
  assert.equal(status.textContent, 'Profile loaded from the bot.');
  const renderedText = (node) => [node.textContent, ...node.children.map(renderedText)].join(' ');
  assert.match(renderedText(content), /Genin/);
  assert.match(renderedText(content), /Sakura/);
  assert.match(renderedText(content), /<img src=x onerror=alert\(1\)>/);
});

test('full app root and /profile command page load their respective assets', () => {
  const app = read('web', 'index.html');
  assert.match(app, /css\/app\.css/);
  assert.match(app, /js\/contract\.js/);
  assert.match(app, /js\/app\.js/);
  assert.match(read('web', 'js', 'app.js'), /https:\/\/t\.me\/frozenblooded/);

  const profile = read('web', 'profile.html');
  assert.match(profile, /\/css\/app\.css/);
  assert.match(profile, /\/css\/profile\.css/);
  assert.match(profile, /\/js\/profile\.js/);
  assert.match(profile, /https:\/\/t\.me\/frozenblooded/);

  const config = read('tgcloud.jsonc');
  assert.match(config, /"source":\s*"web"/);
  assert.match(config, /"from":\s*"\/profile"/);
  assert.match(config, /"to":\s*"\/profile\.html"/);
});
