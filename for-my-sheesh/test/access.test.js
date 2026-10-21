import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccessError, ACCESS_ERROR_CODES } from '../tgcloud/lib/errors.js';
import { createSqliteStore } from './helpers/sqlite_store.js';
import {
  GIRLFRIEND_ID,
  NOW,
  OWNER_ID,
  STRANGER_ID,
  makeAccess,
} from './helpers/fixtures.js';

test('owner is authorized initially and is bootstrapped into the allowlist', async () => {
  const store = createSqliteStore();
  const access = makeAccess(store);

  const result = await access.authorize(OWNER_ID);
  assert.deepEqual(result, { allowed: true, role: 'owner', isOwner: true });

  const row = await store.get(OWNER_ID);
  assert.equal(row.role, 'owner');
  assert.equal(row.grantedAt, NOW);
  store.close();
});

test('unknown users are denied by default', async () => {
  const store = createSqliteStore();
  const access = makeAccess(store);

  const result = await access.authorize(STRANGER_ID);
  assert.deepEqual(result, { allowed: false, role: null, isOwner: false });

  assert.equal(await store.get(STRANGER_ID), null);
  store.close();
});

test('owner can grant access and the member is allowed on the next request', async () => {
  const store = createSqliteStore();
  const access = makeAccess(store);

  const grant = await access.grant(GIRLFRIEND_ID, OWNER_ID);
  assert.equal(grant.changed, true);
  assert.equal(grant.role, 'member');

  const row = await store.get(GIRLFRIEND_ID);
  assert.equal(row.role, 'member');
  assert.equal(row.grantedBy, OWNER_ID);
  assert.equal(row.grantedAt, NOW);

  const result = await access.authorize(GIRLFRIEND_ID);
  assert.deepEqual(result, { allowed: true, role: 'member', isOwner: false });
  store.close();
});

test('owner can revoke access and the next protected request is denied', async () => {
  const store = createSqliteStore();
  const access = makeAccess(store);

  await access.grant(GIRLFRIEND_ID, OWNER_ID);
  assert.equal((await access.authorize(GIRLFRIEND_ID)).allowed, true);

  const revoke = await access.revoke(GIRLFRIEND_ID, OWNER_ID);
  assert.equal(revoke.revoked, true);
  assert.equal(await store.get(GIRLFRIEND_ID), null);
  assert.equal((await access.authorize(GIRLFRIEND_ID)).allowed, false);
  store.close();
});

test('non-owner grant attempts are rejected and change nothing', async () => {
  const store = createSqliteStore();
  const access = makeAccess(store);
  await access.grant(GIRLFRIEND_ID, OWNER_ID);

  await assert.rejects(
    () => access.grant(STRANGER_ID, GIRLFRIEND_ID),
    (error) => error instanceof AccessError && error.code === ACCESS_ERROR_CODES.NOT_OWNER,
  );

  assert.equal((await access.authorize(STRANGER_ID)).allowed, false);
  assert.equal(await store.get(STRANGER_ID), null);
  store.close();
});

test('non-owner revoke attempts are rejected', async () => {
  const store = createSqliteStore();
  const access = makeAccess(store);
  await access.grant(GIRLFRIEND_ID, OWNER_ID);

  await assert.rejects(
    () => access.revoke(GIRLFRIEND_ID, STRANGER_ID),
    (error) => error instanceof AccessError && error.code === ACCESS_ERROR_CODES.NOT_OWNER,
  );

  assert.equal((await access.authorize(GIRLFRIEND_ID)).allowed, true);
  store.close();
});

test('the owner can never be revoked or demoted', async () => {
  const store = createSqliteStore();
  const access = makeAccess(store);
  await access.authorize(OWNER_ID);

  await assert.rejects(
    () => access.revoke(OWNER_ID, OWNER_ID),
    (error) => error instanceof AccessError && error.code === ACCESS_ERROR_CODES.OWNER_PROTECTED,
  );

  const selfGrant = await access.grant(OWNER_ID, OWNER_ID);
  assert.equal(selfGrant.changed, false);
  assert.equal(selfGrant.role, 'owner');

  const row = await store.get(OWNER_ID);
  assert.equal(row.role, 'owner');
  assert.equal((await access.authorize(OWNER_ID)).allowed, true);
  store.close();
});

test('invalid IDs are rejected for grant, revoke, authorize and owner checks', async () => {
  const store = createSqliteStore();
  const access = makeAccess(store);

  for (const invalid of ['@someone', 'abc', '0', '-100123', '00123', '1.5', '', ' 12 34 ', 0, -4, 1.5, null]) {
    await assert.rejects(
      () => access.grant(invalid, OWNER_ID),
      (error) => error instanceof AccessError && error.code === ACCESS_ERROR_CODES.INVALID_ID,
      `grant should reject ${String(invalid)}`,
    );
    await assert.rejects(
      () => access.revoke(invalid, OWNER_ID),
      (error) => error instanceof AccessError && error.code === ACCESS_ERROR_CODES.INVALID_ID,
      `revoke should reject ${String(invalid)}`,
    );
    await assert.rejects(
      () => access.authorize(invalid),
      (error) => error instanceof AccessError && error.code === ACCESS_ERROR_CODES.INVALID_ID,
      `authorize should reject ${String(invalid)}`,
    );
  }
  store.close();
});

test('repeated grant and revoke requests are idempotent', async () => {
  const store = createSqliteStore();
  const access = makeAccess(store);

  const first = await access.grant(GIRLFRIEND_ID, OWNER_ID);
  const second = await access.grant(GIRLFRIEND_ID, OWNER_ID);
  assert.equal(first.changed, true);
  assert.equal(second.changed, false);

  const row = await store.get(GIRLFRIEND_ID);
  assert.equal(row.grantedAt, NOW);

  const revokeFirst = await access.revoke(GIRLFRIEND_ID, OWNER_ID);
  const revokeSecond = await access.revoke(GIRLFRIEND_ID, OWNER_ID);
  assert.equal(revokeFirst.revoked, true);
  assert.equal(revokeSecond.revoked, false);
  store.close();
});

test('a malformed or poisoned role row cannot promote a non-owner', async () => {
  const store = createSqliteStore();
  const access = makeAccess(store);
  await access.authorize(OWNER_ID);

  store.raw(
    `INSERT INTO access_list (telegram_id, role, granted_at, granted_by, updated_at)
     VALUES (:id, 'owner', :now, :now, :now)`,
    { id: GIRLFRIEND_ID, now: NOW },
  );
  assert.equal((await access.authorize(GIRLFRIEND_ID)).allowed, false);

  const unknownRoleStore = {
    async ensureOwner() {},
    async get() {
      return { telegramId: STRANGER_ID, role: 'root', grantedAt: NOW, grantedBy: OWNER_ID };
    },
  };
  const unknownRoleAccess = makeAccess(unknownRoleStore);
  assert.equal((await unknownRoleAccess.authorize(STRANGER_ID)).allowed, false);

  // A poisoned row can still be removed by the owner.
  assert.equal((await access.revoke(GIRLFRIEND_ID, OWNER_ID)).revoked, true);
  store.close();
});

test('storage failures fail closed and never grant access', async () => {
  const failingStore = {
    async ensureOwner() {
      throw new Error('database offline');
    },
  };
  const access = makeAccess(failingStore);

  await assert.rejects(
    () => access.authorize(OWNER_ID),
    (error) =>
      error instanceof AccessError && error.code === ACCESS_ERROR_CODES.STORAGE_UNAVAILABLE,
  );
  await assert.rejects(
    () => access.authorize(GIRLFRIEND_ID),
    (error) =>
      error instanceof AccessError && error.code === ACCESS_ERROR_CODES.STORAGE_UNAVAILABLE,
  );
});

test('a read failure after a successful bootstrapping write also fails closed', async () => {
  const store = {
    async ensureOwner() {},
    async get() {
      throw new Error('read failed');
    },
  };
  const access = makeAccess(store);
  await assert.rejects(
    () => access.authorize(OWNER_ID),
    (error) =>
      error instanceof AccessError && error.code === ACCESS_ERROR_CODES.STORAGE_UNAVAILABLE,
  );
});

test('concurrent grants are atomic and idempotent', async () => {
  const store = createSqliteStore();
  const access = makeAccess(store);

  const results = await Promise.all(
    Array.from({ length: 12 }, () => access.grant(GIRLFRIEND_ID, OWNER_ID)),
  );
  assert.equal(results.filter((result) => result.changed).length, 1);
  assert.equal((await access.authorize(GIRLFRIEND_ID)).allowed, true);
  store.close();
});

test('access survives closing and reopening the durable database', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'for-my-sheesh-'));
  const file = join(dir, 'bot.sqlite');
  try {
    const first = createSqliteStore({ file });
    const firstAccess = makeAccess(first);
    await firstAccess.grant(GIRLFRIEND_ID, OWNER_ID);
    first.close();

    const second = createSqliteStore({ file });
    const secondAccess = makeAccess(second);
    assert.equal((await secondAccess.authorize(GIRLFRIEND_ID)).allowed, true);
    assert.equal((await secondAccess.authorize(OWNER_ID)).allowed, true);
    second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('/access data is owner-only and contains only necessary fields', async () => {
  const store = createSqliteStore();
  const access = makeAccess(store);
  await access.grant(GIRLFRIEND_ID, OWNER_ID);

  const rows = await access.list(OWNER_ID);
  assert.equal(rows.length, 2);
  assert.deepEqual(Object.keys(rows[0]).sort(), [
    'grantedAt',
    'grantedBy',
    'role',
    'telegramId',
  ]);
  assert.equal(rows[0].role, 'owner');
  assert.equal(rows[1].telegramId, GIRLFRIEND_ID);

  await assert.rejects(
    () => access.list(GIRLFRIEND_ID),
    (error) => error instanceof AccessError && error.code === ACCESS_ERROR_CODES.NOT_OWNER,
  );
  store.close();
});

test('owner grants are audited and audit failures do not roll back access', async () => {
  const store = createSqliteStore();
  const access = makeAccess(store);
  await access.grant(GIRLFRIEND_ID, OWNER_ID);

  const audit = store.rawGet('SELECT action, actor_id AS actorId, target_id AS targetId FROM owner_audit');
  assert.deepEqual({ ...audit }, { action: 'grant', actorId: OWNER_ID, targetId: GIRLFRIEND_ID });

  const failingAuditStore = Object.create(store);
  failingAuditStore.audit = async () => {
    throw new Error('audit disk full');
  };
  const accessWithAuditFailure = makeAccess(failingAuditStore);
  const result = await accessWithAuditFailure.grant(STRANGER_ID, OWNER_ID);
  assert.equal(result.changed, true);
  assert.equal((await access.authorize(STRANGER_ID)).allowed, true);
  store.close();
});
