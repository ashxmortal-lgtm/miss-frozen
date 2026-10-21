import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { callEndpoint, ClientError } from '../web/js/api.js';
import { createApp, ACCESS_DENIED } from '../web/js/app-core.js';
import { initPetals, prefersReducedMotion } from '../web/js/effects.js';
import { parseRoute } from '../web/js/route.js';
import { LETTER } from '../tgcloud/lib/content.js';

const WEB_ROOT = new URL('../web/', import.meta.url);
const html = readFileSync(new URL('index.html', WEB_ROOT), 'utf8');
const css = readFileSync(new URL('css/app.css', WEB_ROOT), 'utf8');

function makeDom(path = '/gift') {
  const dom = new JSDOM(html, {
    url: `https://app123456789.tgcloud.ai${path}`,
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  window.matchMedia = (query) => ({
    matches: false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  });
  window.scrollTo = () => {};
  return dom;
}

function fakeGift() {
  return {
    gift: {
      id: LETTER.id,
      title: LETTER.title,
      occasion: '7 months of us',
      paragraphs: [...LETTER.paragraphs],
      signature: LETTER.signature,
    },
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function makeApi(overrides = {}) {
  return {
    accessStatus: async () => ({ allowed: true, role: 'owner', isOwner: true }),
    gift: async () => fakeGift(),
    ...overrides,
  };
}

test('gift cover markup matches the specification and leaks no letter content', () => {
  const dom = makeDom('/gift');
  const doc = dom.window.document;

  assert.equal(doc.querySelector('.greeting').textContent, "Hi Sheesh's Mommy! 👋");
  assert.equal(doc.querySelector('.gift-line').textContent, "You've received a virtual gift!");
  assert.equal(doc.getElementById('open-gift').textContent, 'Open Your Gift 🎁');
  assert.match(doc.getElementById('cover-title').textContent, /𝒔𝒆𝒏𝒕 𝒚𝒐𝒖 𝒂 𝒈𝒊𝒇𝒕/);

  const envelope = doc.querySelector('svg.envelope');
  assert.ok(envelope, 'inline SVG envelope is present');
  assert.ok(doc.querySelector('.envelope .heart'), 'red heart is part of the envelope');
  assert.equal(doc.getElementById('view-letter').hidden, true);

  assert.equal(html.includes('My Dearest'), false);
  assert.equal(html.includes('possesive'), false);
  assert.equal(html.includes('8716863150'), false);
  assert.equal(html.includes('telegram.org/js/telegram-web-app.js'), true);
  assert.equal(html.includes('/js/app.js'), true);
  assert.equal(/\son[a-z]+=/.test(html), false, 'no inline event handlers');
  dom.window.close();
});

test('styles include the gentle animations and respect reduced motion', () => {
  assert.match(css, /@keyframes bob/);
  assert.match(css, /\.envelope-bob\s*\{[^}]*animation:\s*bob/);
  assert.match(css, /@keyframes petal-fall/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /\.petal\s*\{[\s\S]*?display:\s*none/);
  assert.match(css, /min-height:\s*100dvh/);

  // No fixed-height scroll traps on the letter or page.
  assert.equal(/\.letter-card[^}]*max-height/m.test(css), false);
  assert.equal(/\.letter-body[^}]*overflow-y:\s*(hidden|scroll|auto)/m.test(css), false);
  assert.equal(/body\s*\{[^}]*overflow-y:\s*hidden/m.test(css), false);
  assert.equal(/^\s*height:\s*100vh/m.test(css), false);
});

test('deep links select home/gift and fail safely for unknown routes', () => {
  assert.equal(parseRoute('/gift', ''), 'gift');
  assert.equal(parseRoute('/gift/', ''), 'gift');
  assert.equal(parseRoute('/', '?route=gift'), 'gift');
  assert.equal(parseRoute('/', ''), 'home');
  assert.equal(parseRoute('/index.html', ''), 'home');
  assert.equal(parseRoute('/admin', ''), 'home');
  assert.equal(parseRoute('/', '?route=admin'), 'home');
  assert.equal(parseRoute('/', '?route=../gift'), 'home');
  assert.equal(parseRoute('/gift', '?route=<script>'), 'gift');
});

test('start authenticates, then shows the cover even on the direct gift route', async () => {
  const dom = makeDom('/gift');
  const app = createApp({
    document: dom.window.document,
    window: dom.window,
    api: makeApi(),
    route: 'gift',
  });

  assert.equal(app.getView(), 'loading');
  await app.start();
  assert.equal(app.getView(), 'cover');
  assert.equal(app.isGiftRoute(), true);
  assert.equal(dom.window.document.body.dataset.route, 'gift');
  dom.window.close();
});

test('an unknown deep link renders the normal cover, never private content', async () => {
  const dom = makeDom('/something-else');
  const app = createApp({
    document: dom.window.document,
    window: dom.window,
    api: makeApi(),
  });
  await app.start();
  assert.equal(app.getView(), 'cover');
  assert.equal(dom.window.document.getElementById('view-letter').hidden, true);
  dom.window.close();
});

test('Open Your Gift renders the complete letter and a way back', async () => {
  const dom = makeDom('/gift');
  const doc = dom.window.document;
  const app = createApp({
    document: doc,
    window: dom.window,
    api: makeApi(),
    route: 'gift',
  });
  await app.start();

  doc.getElementById('open-gift').click();
  await tick();

  assert.equal(app.getView(), 'letter');
  const paragraphs = [...doc.querySelectorAll('#letter-body p')];
  assert.equal(paragraphs.length, 12);
  assert.deepEqual(
    paragraphs.map((p) => p.textContent),
    [...LETTER.paragraphs],
  );
  assert.equal(doc.getElementById('letter-signature').textContent, LETTER.signature);
  assert.equal(doc.getElementById('letter-heading').textContent, LETTER.title);
  assert.equal(doc.getElementById('back-to-cover').hidden, false);

  doc.getElementById('back-to-cover').click();
  assert.equal(app.getView(), 'cover');
  assert.equal(doc.getElementById('view-letter').hidden, true);
  dom.window.close();
});

test('users outside Telegram see a clear, private-safe error', async () => {
  const dom = makeDom('/');
  const error = new ClientError(
    'Open this little gift from Telegram so I can check whose hands it is in. 🎀',
    'NOT_IN_TELEGRAM',
  );
  const app = createApp({
    document: dom.window.document,
    window: dom.window,
    api: makeApi({
      accessStatus: async () => {
        throw error;
      },
    }),
  });
  await app.start();

  assert.equal(app.getView(), 'error');
  assert.equal(dom.window.document.getElementById('error-message').textContent, error.message);
  assert.equal(dom.window.document.getElementById('error-back').hidden, true);
  dom.window.close();
});

test('an unauthorized user sees the exact app denial', async () => {
  const dom = makeDom('/gift');
  const app = createApp({
    document: dom.window.document,
    window: dom.window,
    api: makeApi({
      accessStatus: async () => {
        throw new ClientError(ACCESS_DENIED, 'ENDPOINT_ERROR');
      },
    }),
  });
  await app.start();

  assert.equal(ACCESS_DENIED, 'You are not allowed to open this app.');
  assert.equal(
    dom.window.document.getElementById('error-message').textContent,
    'You are not allowed to open this app.',
  );
  assert.equal(dom.window.document.body.textContent.includes('My Dearest'), false);
  dom.window.close();
});

test('a gift fetch failure offers retry and a safe way back', async () => {
  const dom = makeDom('/gift');
  const doc = dom.window.document;
  let attempts = 0;
  const app = createApp({
    document: doc,
    window: dom.window,
    api: makeApi({
      gift: async () => {
        attempts += 1;
        if (attempts === 1) throw new ClientError('A tiny hiccup. Try once more. 🎀');
        return fakeGift();
      },
    }),
    route: 'gift',
  });
  await app.start();

  doc.getElementById('open-gift').click();
  await tick();
  assert.equal(app.getView(), 'error');
  assert.equal(doc.getElementById('error-back').hidden, false);
  assert.equal(doc.getElementById('error-message').textContent, 'A tiny hiccup. Try once more. 🎀');

  doc.getElementById('retry').click();
  await tick();
  assert.equal(app.getView(), 'letter');
  dom.window.close();
});

test('error back button returns to the cover', async () => {
  const dom = makeDom('/gift');
  const doc = dom.window.document;
  const app = createApp({
    document: doc,
    window: dom.window,
    api: makeApi({
      gift: async () => {
        throw new ClientError('No gift right now.');
      },
    }),
    route: 'gift',
  });
  await app.start();
  doc.getElementById('open-gift').click();
  await tick();
  assert.equal(app.getView(), 'error');

  doc.getElementById('error-back').click();
  assert.equal(app.getView(), 'cover');
  dom.window.close();
});

test('reduced motion removes the falling petals', () => {
  const dom = makeDom('/');
  const doc = dom.window.document;
  const container = doc.getElementById('petals');

  dom.window.matchMedia = (query) => ({
    matches: true,
    media: query,
    addEventListener() {},
    removeEventListener() {},
  });
  assert.equal(prefersReducedMotion(dom.window), true);
  initPetals(doc, dom.window);
  assert.equal(container.children.length, 0);

  dom.window.matchMedia = (query) => ({
    matches: false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
  });
  initPetals(doc, dom.window);
  assert.equal(container.children.length, 8);
  dom.window.close();
});

test('the endpoint bridge sends initData implicitly and maps errors safely', async () => {
  let seen = null;
  const webApp = {
    Serverless: {
      call(endpoint, input, callback) {
        seen = { endpoint, input };
        callback(null, { ok: true });
      },
    },
  };
  assert.deepEqual(await callEndpoint('getAccessStatus', { a: 1 }, { webApp }), { ok: true });
  assert.deepEqual(seen, { endpoint: 'getAccessStatus', input: { a: 1 } });

  const failing = {
    Serverless: {
      call(_endpoint, _input, callback) {
        callback({ message: 'You are not allowed to open this app.', type: 'ENDPOINT_ERROR' });
      },
    },
  };
  await assert.rejects(
    () => callEndpoint('getGift', {}, { webApp: failing }),
    (error) =>
      error instanceof ClientError &&
      error.message === 'You are not allowed to open this app.' &&
      error.code === 'ENDPOINT_ERROR',
  );
});

test('the bridge never reads initDataUnsafe', async () => {
  const webApp = {
    get initDataUnsafe() {
      throw new Error('initDataUnsafe must not be touched');
    },
    Serverless: {
      call(_endpoint, _input, callback) {
        callback(null, { allowed: true });
      },
    },
  };
  const result = await callEndpoint('getAccessStatus', {}, { webApp });
  assert.deepEqual(result, { allowed: true });
});

test('missing Telegram bridge produces a helpful error', async () => {
  const original = globalThis.Telegram;
  delete globalThis.Telegram;
  try {
    await assert.rejects(
      () => callEndpoint('getGift', {}),
      (error) => error instanceof ClientError && error.code === 'NOT_IN_TELEGRAM',
    );
  } finally {
    if (original !== undefined) globalThis.Telegram = original;
  }

  await assert.rejects(
    () => callEndpoint('getGift', {}, { webApp: {} }),
    (error) => error instanceof ClientError && error.code === 'BRIDGE_MISSING',
  );
});
