import test from 'node:test';
import assert from 'node:assert/strict';
import { AccessError, ACCESS_ERROR_CODES, InitDataError } from '../tgcloud/lib/errors.js';
import {
  accessStatusFor,
  FORBIDDEN_MESSAGE,
  giftFor,
} from '../tgcloud/lib/api_service.js';
import { LETTER } from '../tgcloud/lib/content.js';
import { createSqliteStore } from './helpers/sqlite_store.js';
import {
  GIRLFRIEND_ID,
  NOW,
  OWNER_ID,
  STRANGER_ID,
  freshInitData,
  makeAccess,
  makeUser,
} from './helpers/fixtures.js';

const options = { now: NOW, maxAgeSeconds: 3600 };

function ctx(userId, extra = {}) {
  return { initData: freshInitData(userId, { authDate: NOW }), ...extra };
}

test('a verified owner gets access status', async () => {
  const store = createSqliteStore();
  const access = makeAccess(store);
  const status = await accessStatusFor(ctx(OWNER_ID), access, options);
  assert.deepEqual(status, { allowed: true, role: 'owner', isOwner: true });
  store.close();
});

test('a verified authorized member receives the complete letter', async () => {
  const store = createSqliteStore();
  const access = makeAccess(store);
  await access.grant(GIRLFRIEND_ID, OWNER_ID);

  const result = await giftFor(ctx(GIRLFRIEND_ID), access, options);
  assert.equal(result.gift.id, LETTER.id);
  assert.equal(result.gift.title, LETTER.title);
  assert.equal(result.gift.occasion, '7 months of us');
  assert.equal(result.gift.paragraphs.length, LETTER.paragraphs.length);
  assert.deepEqual(result.gift.paragraphs, [...LETTER.paragraphs]);
  assert.equal(result.gift.signature, LETTER.signature);
  assert.equal(result.gift.paragraphs.length, 12);
  assert.ok(result.gift.signature.length > 0);
  store.close();
});

test('an authenticated but unauthorized user is denied the exact app message', async () => {
  const store = createSqliteStore();
  const access = makeAccess(store);

  for (const operation of [
    () => accessStatusFor(ctx(STRANGER_ID), access, options),
    () => giftFor(ctx(STRANGER_ID), access, options),
  ]) {
    await assert.rejects(
      operation,
      (error) =>
        error instanceof AccessError &&
        error.code === ACCESS_ERROR_CODES.NOT_OWNER &&
        error.message === FORBIDDEN_MESSAGE,
    );
  }
  assert.equal(FORBIDDEN_MESSAGE, 'You are not allowed to open this app.');
  store.close();
});

test('revocation takes effect on the very next protected request', async () => {
  const store = createSqliteStore();
  const access = makeAccess(store);
  await access.grant(GIRLFRIEND_ID, OWNER_ID);
  assert.equal((await giftFor(ctx(GIRLFRIEND_ID), access, options)).gift.paragraphs.length, 12);

  await access.revoke(GIRLFRIEND_ID, OWNER_ID);
  await assert.rejects(
    () => giftFor(ctx(GIRLFRIEND_ID), access, options),
    (error) => error instanceof AccessError && error.message === FORBIDDEN_MESSAGE,
  );
  store.close();
});

test('identity in the request body or initDataUnsafe can never grant access', async () => {
  const store = createSqliteStore();
  const access = makeAccess(store);

  const forgedCtx = {
    ...ctx(STRANGER_ID),
    initDataUnsafe: { user: makeUser(OWNER_ID) },
    input: { user: { id: OWNER_ID }, userId: OWNER_ID },
  };

  await assert.rejects(
    () => giftFor(forgedCtx, access, options),
    (error) => error instanceof AccessError && error.message === FORBIDDEN_MESSAGE,
  );
  store.close();
});

test('missing, malformed and expired initData never reach the allowlist', async () => {
  const store = createSqliteStore();
  const access = makeAccess(store);

  await assert.rejects(
    () => giftFor({}, access, options),
    (error) => error instanceof InitDataError,
  );
  await assert.rejects(
    () => giftFor({ initData: { auth_date: NOW, user: makeUser(OWNER_ID) } }, access, {
      now: NOW + 9999,
      maxAgeSeconds: 3600,
    }),
    (error) => error instanceof InitDataError,
  );
  assert.equal((await store.get(OWNER_ID)), null, 'expired requests must not bootstrap rows');
  store.close();
});

test('a storage failure denies private content and never returns the letter', async () => {
  const failingStore = {
    async ensureOwner() {
      throw new Error('database offline');
    },
  };
  const access = makeAccess(failingStore);

  await assert.rejects(
    () => giftFor(ctx(OWNER_ID), access, options),
    (error) =>
      error instanceof AccessError && error.code === ACCESS_ERROR_CODES.STORAGE_UNAVAILABLE,
  );
});

test('private payloads contain no init data, hashes, tokens or internal IDs', async () => {
  const store = createSqliteStore();
  const access = makeAccess(store);
  const result = await giftFor(ctx(OWNER_ID), access, options);
  const serialized = JSON.stringify(result);

  assert.equal(serialized.includes('auth_date'), false);
  assert.equal(serialized.includes('query_id'), false);
  assert.equal(serialized.includes('8716863150'), false);
  assert.equal(serialized.includes('token'), false);
  assert.deepEqual(Object.keys(result.gift).sort(), [
    'id',
    'occasion',
    'paragraphs',
    'signature',
    'title',
  ]);
  store.close();
});
