import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BUTTON_LABELS,
  CALLBACKS,
  GIFT_ROUTE,
  MAX_INIT_DATA_AGE_SECONDS,
  OWNER_TELEGRAM_ID,
  ROLES,
  assertServerConfig,
} from '../tgcloud/lib/config.js';
import { escapeHtml, fillMention, mentionHtml } from '../tgcloud/lib/mentions.js';
import { formatGrantDate, parseCommand } from '../tgcloud/lib/bot/commands.js';
import {
  giftUrl,
  normalizeMiniAppUrl,
  resolveMiniAppBaseUrl,
  saveMiniAppBaseUrl,
} from '../tgcloud/lib/mini_app_url.js';
import { giftKeyboard, pendingGiftKeyboard, welcomeKeyboard } from '../tgcloud/lib/keyboards.js';
import { createSqliteStore } from './helpers/sqlite_store.js';
import { NOW, OWNER_ID } from './helpers/fixtures.js';

test('trusted config pins the owner, labels, routes and 64-byte callback data', () => {
  assert.equal(OWNER_TELEGRAM_ID, 8716863150);
  assert.equal(MAX_INIT_DATA_AGE_SECONDS, 43200);
  assert.equal(GIFT_ROUTE, '/gift');
  assert.deepEqual(BUTTON_LABELS, {
    menu: 'mini 🎁 surprises',
    date: '8 oct 2026',
    gift: 'hehe 🤌',
  });
  for (const data of Object.values(CALLBACKS)) {
    assert.ok(Buffer.byteLength(data, 'utf8') <= 64);
  }
  assert.equal(new Set(Object.values(CALLBACKS)).size, Object.values(CALLBACKS).length);
  assert.equal(ROLES.OWNER, 'owner');
  assert.equal(ROLES.MEMBER, 'member');
  assert.deepEqual(assertServerConfig(), {
    ownerTelegramId: 8716863150,
    maxInitDataAgeSeconds: 43200,
  });
});

test('assertServerConfig rejects an invalid owner or freshness window', () => {
  assert.throws(() => assertServerConfig({ ownerTelegramId: 0 }));
  assert.throws(() => assertServerConfig({ ownerTelegramId: 1.5 }));
  assert.throws(() => assertServerConfig({ ownerTelegramId: '8716863150' }));
  assert.throws(() => assertServerConfig({ maxInitDataAgeSeconds: 10 }));
  assert.throws(() => assertServerConfig({ maxInitDataAgeSeconds: 99999999 }));
});

test('HTML escaping and mentions never inject untrusted markup', () => {
  assert.equal(escapeHtml('<b>&"\''), '&lt;b&gt;&amp;&quot;&#39;');
  assert.equal(
    mentionHtml({ id: 123, first_name: '<Ann & Co>' }),
    '<a href="tg://user?id=123">&lt;Ann &amp; Co&gt;</a>',
  );
  assert.equal(
    mentionHtml({ id: 123, username: 'ann' }),
    '<a href="tg://user?id=123">ann</a>',
  );
  assert.equal(mentionHtml({ first_name: 'No ID' }), 'No ID');
  assert.equal(mentionHtml({ id: 123 }, { fallback: 'you' }), '<a href="tg://user?id=123">you</a>');
  assert.equal(mentionHtml({ id: 123, first_name: 'x'.repeat(80) }).includes('…'), true);
  assert.equal(fillMention('hi {mention}{other}', 'A'), 'hi A{other}');
});

test('command parsing is strict and keeps arguments intact', () => {
  assert.deepEqual(parseCommand('/start'), { name: 'start', args: [] });
  assert.deepEqual(parseCommand('  /start@for_my_sheesh_bot  '), {
    name: 'start',
    args: [],
  });
  assert.deepEqual(parseCommand('/grant@bot 123456'), { name: 'grant', args: ['123456'] });
  assert.deepEqual(parseCommand('/grant 123 456'), { name: 'grant', args: ['123', '456'] });
  assert.equal(parseCommand('hello'), null);
  assert.equal(parseCommand('/'), null);
  assert.equal(parseCommand('/bad-name'), null);
  assert.equal(parseCommand(undefined), null);
  assert.equal(formatGrantDate(NOW), '2025-10-09');
  assert.equal(formatGrantDate(NaN), 'unknown');
});

test('Mini App URL validation only accepts the documented TGCloud host', () => {
  assert.equal(normalizeMiniAppUrl('https://app123456789.tgcloud.ai/'), 'https://app123456789.tgcloud.ai');
  assert.equal(normalizeMiniAppUrl(' https://APP123456789.tgcloud.ai '), 'https://app123456789.tgcloud.ai');
  assert.equal(giftUrl('https://app123456789.tgcloud.ai'), 'https://app123456789.tgcloud.ai/gift');

  for (const invalid of [
    'http://app123456789.tgcloud.ai/',
    'https://app123456789.tgcloud.ai/gift',
    'https://app123456789.tgcloud.ai/?route=gift',
    'https://app123456789.tgcloud.ai/#gift',
    'https://app123456789.tgcloud.ai:443/',
    'https://user@app123456789.tgcloud.ai/',
    'https://evil.example.com/',
    'https://app12.tgcloud.ai/',
    'https://app123456789.tgcloud.ai.evil.com/',
    '',
    null,
  ]) {
    assert.throws(() => normalizeMiniAppUrl(invalid), `should reject ${String(invalid)}`);
  }
});

test('Mini App URL resolution prefers the durable setting and validates it', async () => {
  const store = createSqliteStore();
  assert.equal(await resolveMiniAppBaseUrl(store), null);

  await store.setSetting('mini_app_url', 'not a url', NOW);
  assert.equal(await resolveMiniAppBaseUrl(store), null);

  await store.setSetting('mini_app_url', 'https://app123456789.tgcloud.ai', NOW);
  assert.equal(await resolveMiniAppBaseUrl(store), 'https://app123456789.tgcloud.ai');

  const saved = await saveMiniAppBaseUrl(store, 'https://app987654321.tgcloud.ai/', OWNER_ID, NOW);
  assert.equal(saved, 'https://app987654321.tgcloud.ai');
  assert.equal(await store.getSetting('mini_app_url'), 'https://app987654321.tgcloud.ai');
  assert.ok(await store.rawGet('SELECT id FROM owner_audit LIMIT 1'));
  store.close();
});

test('keyboards use the exact labels and a gift URL with no identity data', () => {
  assert.deepEqual(welcomeKeyboard(), {
    inline_keyboard: [[{ text: 'mini 🎁 surprises', callback_data: 'fms:m' }]],
  });
  assert.deepEqual(giftKeyboard('https://app123456789.tgcloud.ai/gift'), {
    inline_keyboard: [
      [{ text: 'hehe 🤌', web_app: { url: 'https://app123456789.tgcloud.ai/gift' } }],
    ],
  });
  assert.deepEqual(pendingGiftKeyboard(), {
    inline_keyboard: [[{ text: 'hehe 🤌', callback_data: 'fms:p' }]],
  });
});
