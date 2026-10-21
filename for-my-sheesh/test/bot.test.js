import test from 'node:test';
import assert from 'node:assert/strict';
import { routeMessage } from '../tgcloud/lib/bot/message_router.js';
import { routeCallback } from '../tgcloud/lib/bot/callback_router.js';
import { createBotSupport } from '../tgcloud/lib/bot/support.js';
import { BUTTON_LABELS, CALLBACKS } from '../tgcloud/lib/config.js';
import {
  ANNIVERSARY_INTRO,
  HELP_MEMBER,
  HELP_OWNER,
  MENU_STEP_ONE,
  OWNER_START,
  TEXTS,
  UNAUTHORIZED_TEMPLATE,
  WELCOME_MESSAGE,
} from '../tgcloud/lib/content.js';
import { createSqliteStore } from './helpers/sqlite_store.js';
import {
  GIRLFRIEND_ID,
  NOW,
  OWNER_ID,
  STRANGER_ID,
  makeAccess,
  makeApi,
  makeCallback,
  makePrivateMessage,
  makeUser,
} from './helpers/fixtures.js';

function setup({ store } = {}) {
  const sqlite = store ?? createSqliteStore();
  const clock = { now: NOW };
  const access = makeAccess(sqlite, { now: NOW });
  const support = createBotSupport(sqlite, { now: () => clock.now });
  const api = makeApi();
  const deps = { api, access, support, store: sqlite, now: () => clock.now };
  return { store: sqlite, clock, access, support, api, deps };
}

async function send(message, deps, updateId = 1) {
  return routeMessage(message, { update: { update_id: updateId } }, deps);
}

async function tap(query, deps, updateId = 1) {
  return routeCallback(query, { update: { update_id: updateId } }, deps);
}

function textIncludes(text) {
  return (params) => typeof params.text === 'string' && params.text.includes(text);
}

test('owner /start shows the owner experience with one primary button', async () => {
  const { deps, api, store } = setup();
  await send(makePrivateMessage(makeUser(OWNER_ID), '/start'), deps);

  const messages = api.messages();
  assert.equal(messages.length, 1);
  assert.equal(messages[0].text, OWNER_START);
  assert.equal(messages[0].reply_markup.inline_keyboard.length, 1);
  assert.equal(messages[0].reply_markup.inline_keyboard[0].length, 1);
  assert.equal(messages[0].reply_markup.inline_keyboard[0][0].text, 'mini 🎁 surprises');
  assert.equal(messages[0].reply_markup.inline_keyboard[0][0].callback_data, CALLBACKS.menu);
  store.close();
});

test('authorized girlfriend /start sends the exact welcome with exactly one button', async () => {
  const { deps, api, access, store } = setup();
  await access.grant(GIRLFRIEND_ID, OWNER_ID);

  await send(makePrivateMessage(makeUser(GIRLFRIEND_ID), '/start'), deps);
  const messages = api.messages();

  assert.equal(messages.length, 1);
  assert.equal(messages[0].text, WELCOME_MESSAGE);
  assert.equal(messages[0].parse_mode, undefined);
  assert.deepEqual(messages[0].reply_markup, {
    inline_keyboard: [
      [{ text: 'mini 🎁 surprises', callback_data: CALLBACKS.menu }],
    ],
  });
  assert.equal(BUTTON_LABELS.menu, 'mini 🎁 surprises');
  store.close();
});

test('unauthorized /start sends the exact rejection with a safe mention', async () => {
  const { deps, api, store } = setup();
  const stranger = makeUser(STRANGER_ID, { first_name: 'Mallory' });

  await send(makePrivateMessage(stranger, '/start'), deps);
  const messages = api.messages();
  assert.equal(messages.length, 1);

  const expected = UNAUTHORIZED_TEMPLATE.replace(
    '{mention}',
    `<a href="tg://user?id=${STRANGER_ID}">Mallory</a>`,
  );
  assert.equal(messages[0].text, expected);
  assert.equal(messages[0].parse_mode, 'HTML');
  assert.equal(messages[0].text.includes('{mention}'), false);
  store.close();
});

test('untrusted display names are HTML-escaped in the mention', async () => {
  const { deps, api, store } = setup();
  const stranger = makeUser(STRANGER_ID, {
    first_name: '<b>Not</b> & "nice"',
    username: undefined,
  });

  await send(makePrivateMessage(stranger, '/start'), deps);
  const [message] = api.messages();
  assert.match(message.text, /&lt;b&gt;Not&lt;\/b&gt; &amp; &quot;nice&quot;/);
  assert.equal(message.text.includes('<b>'), false);
  store.close();
});

test('unauthorized users cannot run any private command', async () => {
  const { deps, api, access, store } = setup();
  for (const command of ['/grant 123', '/revoke 123', '/access', '/help', '/setapp https://app123456789.tgcloud.ai/']) {
    await send(makePrivateMessage(makeUser(STRANGER_ID), command), deps, 10);
  }
  const messages = api.messages();
  assert.equal(messages.length, 5);
  for (const message of messages) {
    assert.match(message.text, /ᴡʀᴏɴɢ ᴅᴏᴏʀ/);
  }
  assert.equal((await access.authorize(123)).allowed, false);
  store.close();
});

test('plain chatter from a stranger gets no reply', async () => {
  const { deps, api, store } = setup();
  await send(makePrivateMessage(makeUser(STRANGER_ID), 'hello?'), deps);
  assert.equal(api.messages().length, 0);
  store.close();
});

test('group chats are ignored completely', async () => {
  const { deps, api, store } = setup();
  const message = makePrivateMessage(makeUser(OWNER_ID), '/start', {
    chat: { id: -100123, type: 'supergroup' },
  });
  await send(message, deps);
  assert.equal(api.messages().length, 0);
  store.close();
});

test('owner /grant persists access before reporting success', async () => {
  const { deps, store } = setup();
  let rowAtSend = null;
  const original = deps.api.sendMessage.bind(deps.api);
  deps.api.sendMessage = async (params) => {
    if (params.text?.includes('Access granted')) rowAtSend = await store.get(GIRLFRIEND_ID);
    return original(params);
  };

  await send(
    makePrivateMessage(makeUser(OWNER_ID), `/grant ${GIRLFRIEND_ID}`),
    deps,
  );
  assert.equal(rowAtSend.role, 'member');
  assert.equal(rowAtSend.grantedBy, OWNER_ID);
  store.close();
});

test('non-owners cannot grant or revoke, even after being authorized', async () => {
  const { deps, api, access, store } = setup();
  await access.grant(GIRLFRIEND_ID, OWNER_ID);

  await send(
    makePrivateMessage(makeUser(GIRLFRIEND_ID), `/grant ${STRANGER_ID}`),
    deps,
    2,
  );
  await send(
    makePrivateMessage(makeUser(GIRLFRIEND_ID), `/revoke ${OWNER_ID}`),
    deps,
    3,
  );

  const texts = api.messages().map((message) => message.text);
  assert.deepEqual(texts, [TEXTS.notOwner, TEXTS.notOwner]);
  assert.equal((await access.authorize(STRANGER_ID)).allowed, false);
  assert.equal((await access.authorize(OWNER_ID)).allowed, true);
  store.close();
});

test('owner /grant and /revoke are idempotent and immediately effective', async () => {
  const { deps, api, store } = setup();
  const owner = makeUser(OWNER_ID);
  const girlfriend = makeUser(GIRLFRIEND_ID);

  await send(makePrivateMessage(owner, `/grant ${GIRLFRIEND_ID}`), deps, 1);
  await send(makePrivateMessage(owner, `/grant ${GIRLFRIEND_ID}`), deps, 2);
  await send(makePrivateMessage(girlfriend, '/start'), deps, 3);
  await send(makePrivateMessage(owner, `/revoke ${GIRLFRIEND_ID}`), deps, 4);
  await send(makePrivateMessage(owner, `/revoke ${GIRLFRIEND_ID}`), deps, 5);
  await send(makePrivateMessage(girlfriend, '/start'), deps, 6);

  const texts = api.messages().map((message) => message.text);
  assert.equal(texts[0], `✅ Access granted to ${GIRLFRIEND_ID} as a member. 🎀`);
  assert.equal(texts[1], `✅ ${GIRLFRIEND_ID} already has access. Nothing changed. 🎀`);
  assert.equal(texts[2], WELCOME_MESSAGE);
  assert.equal(texts[3], `✅ Access revoked for ${GIRLFRIEND_ID}. 🎀`);
  assert.equal(texts[4], `✅ ${GIRLFRIEND_ID} did not have access. Nothing changed. 🎀`);
  assert.match(texts[5], /ᴡʀᴏɴɢ ᴅᴏᴏʀ/);
  store.close();
});

test('the owner cannot revoke themselves', async () => {
  const { deps, api, access, store } = setup();
  await send(makePrivateMessage(makeUser(OWNER_ID), `/revoke ${OWNER_ID}`), deps);
  assert.equal(api.messages()[0].text, TEXTS.ownerProtected);
  assert.equal((await access.authorize(OWNER_ID)).allowed, true);
  store.close();
});

test('invalid IDs and malformed command arguments are rejected', async () => {
  const { deps, api, store } = setup();
  const owner = makeUser(OWNER_ID);

  await send(makePrivateMessage(owner, '/grant'), deps, 1);
  await send(makePrivateMessage(owner, '/grant @her'), deps, 2);
  await send(makePrivateMessage(owner, '/grant 123 456'), deps, 3);
  await send(makePrivateMessage(owner, '/revoke -100123'), deps, 4);
  await send(makePrivateMessage(owner, '/grant 0'), deps, 5);

  const texts = api.messages().map((message) => message.text);
  assert.equal(texts[0], TEXTS.grantUsage);
  assert.equal(texts[1], TEXTS.invalidId);
  assert.equal(texts[2], TEXTS.grantUsage);
  assert.equal(texts[3], TEXTS.invalidId);
  assert.equal(texts[4], TEXTS.invalidId);
  store.close();
});

test('/access lists roles only for the owner', async () => {
  const { deps, api, access, store } = setup();
  await access.grant(GIRLFRIEND_ID, OWNER_ID);

  await send(makePrivateMessage(makeUser(OWNER_ID), '/access'), deps, 1);
  await send(makePrivateMessage(makeUser(GIRLFRIEND_ID), '/access'), deps, 2);

  const [ownerView, memberView] = api.messages().map((message) => message.text);
  assert.match(ownerView, new RegExp(`${OWNER_ID} — owner`));
  assert.match(ownerView, new RegExp(`${GIRLFRIEND_ID} — member`));
  assert.equal(memberView, TEXTS.notOwner);
  store.close();
});

test('/help shows owner commands only to the owner', async () => {
  const { deps, api, access, store } = setup();
  await access.grant(GIRLFRIEND_ID, OWNER_ID);

  await send(makePrivateMessage(makeUser(OWNER_ID), '/help'), deps, 1);
  await send(makePrivateMessage(makeUser(GIRLFRIEND_ID), '/help'), deps, 2);

  const [ownerHelp, memberHelp] = api.messages().map((message) => message.text);
  assert.equal(ownerHelp, HELP_OWNER);
  assert.equal(memberHelp, HELP_MEMBER);
  assert.equal(memberHelp.includes('/grant'), false);
  assert.equal(memberHelp.includes('/access'), false);
  store.close();
});

test('/setapp validates the TGCloud host and is owner-only', async () => {
  const { deps, api, access, store } = setup();
  await access.grant(GIRLFRIEND_ID, OWNER_ID);
  const owner = makeUser(OWNER_ID);

  await send(
    makePrivateMessage(owner, '/setapp http://app123456789.tgcloud.ai/'),
    deps,
    1,
  );
  await send(
    makePrivateMessage(owner, '/setapp https://evil.example.com/'),
    deps,
    2,
  );
  await send(
    makePrivateMessage(owner, '/setapp https://app123456789.tgcloud.ai/gift'),
    deps,
    3,
  );
  await send(
    makePrivateMessage(makeUser(GIRLFRIEND_ID), '/setapp https://app123456789.tgcloud.ai/'),
    deps,
    4,
  );
  assert.equal(await store.getSetting('mini_app_url'), null);

  await send(
    makePrivateMessage(owner, '/setapp https://app123456789.tgcloud.ai/'),
    deps,
    5,
  );
  assert.equal(await store.getSetting('mini_app_url'), 'https://app123456789.tgcloud.ai');

  const texts = api.messages().map((message) => message.text);
  assert.match(texts[0], /exact TGCloud URL/);
  assert.match(texts[1], /not a TGCloud Mini App host/);
  assert.match(texts[2], /exact TGCloud URL/);
  assert.equal(texts[3], TEXTS.notOwner);
  assert.match(texts[4], /Mini App URL saved/);
  store.close();
});

test('the menu sequence uses new messages: choose -> 8 oct 2026 -> hehe -> /gift', async () => {
  const { deps, api, access, store } = setup();
  await access.grant(GIRLFRIEND_ID, OWNER_ID);
  await store.setSetting('mini_app_url', 'https://app123456789.tgcloud.ai', NOW);
  const girlfriend = makeUser(GIRLFRIEND_ID);

  await tap(makeCallback(girlfriend, CALLBACKS.menu), deps, 1);
  await tap(makeCallback(girlfriend, CALLBACKS.date), deps, 2);

  const messages = api.messages();
  assert.equal(messages.length, 2);
  assert.equal(messages[0].text, MENU_STEP_ONE);
  assert.deepEqual(messages[0].reply_markup, {
    inline_keyboard: [
      [{ text: '8 oct 2026', callback_data: CALLBACKS.date }],
    ],
  });

  assert.equal(messages[1].text, ANNIVERSARY_INTRO);
  assert.deepEqual(messages[1].reply_markup, {
    inline_keyboard: [
      [
        {
          text: 'hehe 🤌',
          web_app: { url: 'https://app123456789.tgcloud.ai/gift' },
        },
      ],
    ],
  });

  assert.deepEqual(
    api.answers().map((answer) => answer.callback_query_id),
    ['cb-1', 'cb-1'],
  );
  store.close();
});

test('when the Mini App URL is not configured, the button stays safe', async () => {
  const { deps, api, access, store } = setup();
  await access.grant(GIRLFRIEND_ID, OWNER_ID);

  await tap(makeCallback(makeUser(GIRLFRIEND_ID), CALLBACKS.date), deps, 1);
  const [message] = api.messages();
  assert.equal(message.text, ANNIVERSARY_INTRO);
  assert.deepEqual(message.reply_markup, {
    inline_keyboard: [
      [{ text: 'hehe 🤌', callback_data: CALLBACKS.pendingGift }],
    ],
  });

  await tap(makeCallback(makeUser(GIRLFRIEND_ID), CALLBACKS.pendingGift), deps, 2);
  assert.equal(api.answers().at(-1).text, TEXTS.pendingGift);
  assert.equal(api.answers().at(-1).show_alert, true);
  store.close();
});

test('forged or replayed callbacks do not bypass authorization', async () => {
  const { deps, api, store } = setup();
  await tap(makeCallback(makeUser(STRANGER_ID), CALLBACKS.menu), deps, 1);
  await tap(makeCallback(makeUser(STRANGER_ID), CALLBACKS.date), deps, 2);
  await tap(makeCallback(makeUser(STRANGER_ID), CALLBACKS.pendingGift), deps, 3);

  assert.equal(api.messages().length, 0);
  assert.equal(api.answers().length, 3);
  for (const answer of api.answers()) {
    assert.equal(answer.text, TEXTS.callbackNotAllowed);
  }
  store.close();
});

test('revocation immediately blocks callbacks from an already-open chat', async () => {
  const { deps, api, access, store } = setup();
  await access.grant(GIRLFRIEND_ID, OWNER_ID);
  await access.revoke(GIRLFRIEND_ID, OWNER_ID);

  await tap(makeCallback(makeUser(GIRLFRIEND_ID), CALLBACKS.menu), deps, 1);
  assert.equal(api.messages().length, 0);
  assert.equal(api.answers()[0].text, TEXTS.callbackNotAllowed);
  store.close();
});

test('unknown callback data is acknowledged without private content', async () => {
  const { deps, api, access, store } = setup();
  await access.grant(GIRLFRIEND_ID, OWNER_ID);

  await tap(makeCallback(makeUser(GIRLFRIEND_ID), 'steal:everything'), deps, 1);
  assert.equal(api.messages().length, 0);
  assert.equal(api.answers()[0].text, TEXTS.wrongDoor);
  store.close();
});

test('duplicate delivery of the same update does not send a second menu', async () => {
  const { deps, api, access, store } = setup();
  await access.grant(GIRLFRIEND_ID, OWNER_ID);
  const query = makeCallback(makeUser(GIRLFRIEND_ID), CALLBACKS.menu);

  await tap(query, deps, 500);
  await tap(query, deps, 500);

  assert.equal(api.messages().length, 1);
  assert.equal(api.answers().length, 2);
  store.close();
});

test('rapid double taps are coalesced, then allowed again after the cooldown', async () => {
  const { deps, api, access, clock, store } = setup();
  await access.grant(GIRLFRIEND_ID, OWNER_ID);
  const girlfriend = makeUser(GIRLFRIEND_ID);

  await tap(makeCallback(girlfriend, CALLBACKS.menu), deps, 1);
  await tap(makeCallback(girlfriend, CALLBACKS.menu), deps, 2);
  assert.equal(api.messages().length, 1);

  clock.now += 6;
  await tap(makeCallback(girlfriend, CALLBACKS.menu), deps, 3);
  assert.equal(api.messages().length, 2);
  store.close();
});

test('callbacks outside private chats are acknowledged but ignored', async () => {
  const { deps, api, access, store } = setup();
  await access.grant(GIRLFRIEND_ID, OWNER_ID);
  const query = makeCallback(makeUser(GIRLFRIEND_ID), CALLBACKS.menu, {
    message: {
      message_id: 1,
      chat: { id: -100123, type: 'supergroup' },
      date: NOW,
    },
  });

  await tap(query, deps, 1);
  assert.equal(api.messages().length, 0);
  assert.equal(api.answers().length, 1);
  store.close();
});

test('a storage outage denies commands and callbacks without leaking content', async () => {
  const failingStore = {
    async ensureOwner() {
      throw new Error('db down');
    },
    async claimUpdate() {
      return true;
    },
  };
  const access = makeAccess(failingStore);
  const support = createBotSupport(failingStore, { now: () => NOW });
  const api = makeApi();
  const deps = { api, access, support, store: failingStore, now: () => NOW };

  await send(makePrivateMessage(makeUser(OWNER_ID), '/start'), deps);
  assert.equal(api.messages()[0].text, TEXTS.storageUnavailable);
  assert.equal(api.messages()[0].reply_markup, undefined);

  await tap(makeCallback(makeUser(OWNER_ID), CALLBACKS.menu), deps);
  assert.equal(api.answers()[0].text, TEXTS.storageUnavailable);
  assert.equal(api.messages().length, 1);
});

test('unknown commands get a safe generic answer', async () => {
  const { deps, api, access, store } = setup();
  await access.grant(GIRLFRIEND_ID, OWNER_ID);
  await send(makePrivateMessage(makeUser(GIRLFRIEND_ID), '/sudo rm -rf'), deps);
  assert.equal(api.messages()[0].text, TEXTS.unknownCommand);
  store.close();
});

test('a mentioned command with @botname still routes', async () => {
  const { deps, api, access, store } = setup();
  await access.grant(GIRLFRIEND_ID, OWNER_ID);
  await send(makePrivateMessage(makeUser(GIRLFRIEND_ID), '/start@for_my_sheesh_bot'), deps);
  assert.equal(api.messages()[0].text, WELCOME_MESSAGE);
  store.close();
});
