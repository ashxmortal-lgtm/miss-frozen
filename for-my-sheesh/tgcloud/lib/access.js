import { OWNER_TELEGRAM_ID, ROLES } from './config.js';
import { AccessError, ACCESS_ERROR_CODES } from './errors.js';
import { isOwnerId, parseTelegramUserId } from './ids.js';
import { AUDIT_ACTIONS } from './sql.js';

const STORAGE_MESSAGE =
  'My little notebook is unavailable right now. Please try again in a moment. 🎀';

/**
 * Authorization is default-deny and fail-closed:
 *  - the caller ID comes from a verified Telegram update / verified initData,
 *    never from message text, a callback payload, a query string or a request body;
 *  - the configured owner ID is compared numerically against trusted config;
 *  - a database row can only ever grant the 'member' role;
 *  - an unknown, missing, unreadable or malformed row is a denial;
 *  - any storage failure throws, and every caller turns that into a denial.
 */
export function createAccessService(store, options = {}) {
  const ownerId = options.ownerTelegramId ?? OWNER_TELEGRAM_ID;
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));

  async function withStore(operation) {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof AccessError) throw error;
      // Log internally only. The caller receives no stack trace, SQL or IDs.
      console.error('[access] storage failure', error);
      throw new AccessError(ACCESS_ERROR_CODES.STORAGE_UNAVAILABLE, STORAGE_MESSAGE);
    }
  }

  async function ensureOwnerRow() {
    await store.ensureOwner({ ownerId, now: now() });
  }

  /**
   * Check current access for a verified user ID. Called on every private
   * command, every callback and every Mini App endpoint — never cached in a
   * frontend, a session or a module-level variable.
   *
   * @returns {Promise<{allowed: boolean, role: 'owner'|'member'|null, isOwner: boolean}>}
   */
  async function authorize(rawUserId) {
    const userId = parseTelegramUserId(rawUserId);

    return withStore(async () => {
      await ensureOwnerRow();
      const row = await store.get(userId);

      if (!row) {
        return { allowed: false, role: null, isOwner: false };
      }

      if (isOwnerId(userId, ownerId)) {
        return { allowed: true, role: ROLES.OWNER, isOwner: true };
      }

      // Defence in depth: even a poisoned row saying 'owner' cannot promote a
      // non-owner, because ownership is decided only by trusted config.
      if (row.role === ROLES.MEMBER) {
        return { allowed: true, role: ROLES.MEMBER, isOwner: false };
      }

      return { allowed: false, role: null, isOwner: false };
    });
  }

  /** Throwing convenience wrapper for endpoints and owner commands. */
  async function requireAccess(rawUserId) {
    const result = await authorize(rawUserId);
    if (!result.allowed) {
      throw new AccessError(ACCESS_ERROR_CODES.NOT_OWNER, 'You are not allowed to open this app.');
    }
    return result;
  }

  async function requireOwner(rawActorId) {
    const actorId = parseTelegramUserId(rawActorId);
    if (!isOwnerId(actorId, ownerId)) {
      throw new AccessError(ACCESS_ERROR_CODES.NOT_OWNER, 'Only the owner can do that.');
    }
    return actorId;
  }

  async function safeAudit(actorId, action, targetId) {
    try {
      await store.audit({ actorId, action, targetId, now: now() });
    } catch (error) {
      // The allowlist change already committed. Audit is not a permission
      // boundary; never report failure or roll back access for a log row.
      console.error('[access] audit write failed', error);
    }
  }

  /**
   * Grant the 'member' role. Idempotent: re-granting an existing member leaves
   * the original grant metadata intact. The owner can never be demoted or
   * rewritten by this operation.
   */
  async function grant(rawTargetId, rawActorId) {
    const actorId = await requireOwner(rawActorId);
    const targetId = parseTelegramUserId(rawTargetId);

    if (isOwnerId(targetId, ownerId)) {
      return { changed: false, role: ROLES.OWNER, alreadyOwner: true, targetId };
    }

    return withStore(async () => {
      await ensureOwnerRow();
      const changed = await store.insertMember({
        telegramId: targetId,
        now: now(),
        grantedBy: actorId,
      });
      const row = await store.get(targetId);

      if (!row) {
        throw new AccessError(
          ACCESS_ERROR_CODES.STORAGE_UNAVAILABLE,
          'The grant could not be verified. Please try again.',
        );
      }
      if (row.role !== ROLES.MEMBER) {
        throw new AccessError(
          ACCESS_ERROR_CODES.MALFORMED_ACCESS,
          'That access entry is inconsistent. Revoke it, then grant again.',
        );
      }

      if (changed) await safeAudit(actorId, AUDIT_ACTIONS.GRANT, targetId);
      return { changed, role: ROLES.MEMBER, alreadyOwner: false, targetId };
    });
  }

  /**
   * Revoke a member. The configured owner is protected in application code and
   * the SQL refuses to delete an 'owner' row as a second line of defence.
   * Revoking a non-member is a safe no-op.
   */
  async function revoke(rawTargetId, rawActorId) {
    const actorId = await requireOwner(rawActorId);
    const targetId = parseTelegramUserId(rawTargetId);

    if (isOwnerId(targetId, ownerId)) {
      throw new AccessError(ACCESS_ERROR_CODES.OWNER_PROTECTED, 'The owner cannot be revoked.');
    }

    return withStore(async () => {
      await ensureOwnerRow();
      const row = await store.get(targetId);
      if (!row) return { changed: false, revoked: false, targetId };

      // The target is not the configured owner (checked above), so a poisoned
      // 'owner' row can safely be removed. The normal path keeps the SQL-level
      // guard that refuses to delete an owner row.
      const changed =
        row.role === ROLES.OWNER
          ? await store.deleteAny(targetId)
          : await store.deleteNonOwner(targetId);

      if (changed) await safeAudit(actorId, AUDIT_ACTIONS.REVOKE, targetId);
      return { changed, revoked: changed, targetId };
    });
  }

  /** Owner-only allowlist view. No usernames, no tokens, no extra PII. */
  async function list(rawActorId) {
    const actorId = await requireOwner(rawActorId);
    return withStore(async () => {
      await ensureOwnerRow();
      return (await store.list()).map((row) => ({
        telegramId: row.telegramId,
        role: isOwnerId(row.telegramId, ownerId) ? ROLES.OWNER : ROLES.MEMBER,
        grantedAt: row.grantedAt,
        grantedBy: row.grantedBy,
      }));
    });
  }

  return {
    ownerId,
    authorize,
    requireAccess,
    requireOwner,
    grant,
    revoke,
    list,
    isOwner: (userId) => isOwnerId(userId, ownerId),
  };
}
