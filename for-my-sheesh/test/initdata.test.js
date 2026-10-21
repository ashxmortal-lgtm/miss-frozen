import test from 'node:test';
import assert from 'node:assert/strict';
import { InitDataError, INIT_DATA_ERROR_CODES } from '../tgcloud/lib/errors.js';
import { validateInitData } from '../tgcloud/lib/initdata.js';
import { NOW, makeUser } from './helpers/fixtures.js';

function code(expected) {
  return (error) => error instanceof InitDataError && error.code === expected;
}

test('valid fresh verified initData is accepted', () => {
  const result = validateInitData(
    { auth_date: NOW, user: makeUser(123456), query_id: 'q' },
    { now: NOW, maxAgeSeconds: 3600 },
  );
  assert.equal(result.userId, 123456);
  assert.equal(result.authDate, NOW);
  assert.equal(result.user.first_name, 'Sheesh');
});

test('a numeric string auth_date is accepted', () => {
  const result = validateInitData(
    { auth_date: String(NOW), user: makeUser(42) },
    { now: NOW, maxAgeSeconds: 3600 },
  );
  assert.equal(result.userId, 42);
});

test('missing or non-object initData is rejected', () => {
  for (const value of [undefined, null, '', 'auth_date=1', [], 5]) {
    assert.throws(
      () => validateInitData(value, { now: NOW }),
      code(INIT_DATA_ERROR_CODES.MISSING),
    );
  }
});

test('missing, zero or malformed auth_date is rejected', () => {
  for (const authDate of [undefined, null, 0, -3, 'abc', '', 1.5, {}]) {
    assert.throws(
      () => validateInitData({ auth_date: authDate, user: makeUser(1) }, { now: NOW }),
      code(INIT_DATA_ERROR_CODES.MALFORMED),
      `auth_date ${String(authDate)}`,
    );
  }
});

test('expired initData is rejected after the configurable window', () => {
  const initData = { auth_date: NOW - 7200, user: makeUser(123456) };
  assert.throws(
    () => validateInitData(initData, { now: NOW, maxAgeSeconds: 3600 }),
    code(INIT_DATA_ERROR_CODES.EXPIRED),
  );
  const accepted = validateInitData(initData, { now: NOW, maxAgeSeconds: 7200 });
  assert.equal(accepted.userId, 123456);
});

test('timestamps too far in the future are rejected', () => {
  assert.throws(
    () => validateInitData({ auth_date: NOW + 120, user: makeUser(1) }, { now: NOW }),
    code(INIT_DATA_ERROR_CODES.MALFORMED),
  );
});

test('tampered or invalid user identities are rejected', () => {
  const cases = [
    undefined,
    null,
    {},
    { id: 'abc' },
    { id: 0 },
    { id: -5 },
    { id: 1.5 },
    { id: '@handle' },
    { id: 123, is_bot: true },
    [],
  ];
  for (const user of cases) {
    assert.throws(
      () => validateInitData({ auth_date: NOW, user }, { now: NOW }),
      code(INIT_DATA_ERROR_CODES.MALFORMED),
      JSON.stringify(user),
    );
  }
});

test('validateInitData never reads initDataUnsafe', () => {
  const initData = { auth_date: NOW, user: makeUser(7) };
  Object.defineProperty(initData, 'initDataUnsafe', {
    get() {
      throw new Error('must not read initDataUnsafe');
    },
  });
  assert.equal(validateInitData(initData, { now: NOW }).userId, 7);
});
