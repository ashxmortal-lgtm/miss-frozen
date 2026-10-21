import { db } from 'sdk';
import { SQL } from './sql.js';

// Production implementation of the durable store, backed by the bot's own
// TGCloud SQLite database. Every call is awaited: the SDK's DB methods are
// async. Failures are thrown; callers convert them into a fail-closed denial.
//
// The interface is intentionally tiny so tests can run the identical SQL
// against node:sqlite:
//   ensureOwner({ ownerId, now })        -> void
//   get(telegramId)                      -> row | null
//   list()                               -> row[]
//   insertMember({ telegramId, now, grantedBy }) -> changed:boolean
//   deleteNonOwner(telegramId)           -> changed:boolean
//   audit({ actorId, action, targetId, now })    -> void
//   getSetting(key)                      -> string | null
//   setSetting(key, value, now)          -> void
//   claimUpdate(updateId, now)           -> boolean (true = first delivery)
//   getMenuTap(telegramId, step)         -> { sentAt, messageId } | null
//   setMenuTap({ telegramId, step, now, messageId }) -> void

function params(values) {
  // TGCloud documents named params as `{ ':id': value }`.
  return Object.fromEntries(Object.entries(values).map(([k, v]) => [`:${k}`, v]));
}

export function createSdkStore() {
  return {
    async ensureOwner({ ownerId, now }) {
      await db.run(SQL.ensureOwner, params({ telegramId: ownerId, now }));
    },

    async get(telegramId) {
      return await db.get(SQL.getAccess, params({ telegramId }));
    },

    async list() {
      return await db.all(SQL.listAccess);
    },

    async insertMember({ telegramId, now, grantedBy }) {
      const result = await db.run(SQL.insertMember, params({ telegramId, now, grantedBy }));
      return result.rowsAffected > 0;
    },

    async deleteNonOwner(telegramId) {
      const result = await db.run(SQL.deleteNonOwner, params({ telegramId }));
      return result.rowsAffected > 0;
    },

    async deleteAny(telegramId) {
      const result = await db.run(SQL.deleteAny, params({ telegramId }));
      return result.rowsAffected > 0;
    },

    async audit({ actorId, action, targetId, now }) {
      await db.run(SQL.insertAudit, params({ actorId, action, targetId, now }));
    },

    async getSetting(key) {
      const row = await db.get(SQL.getSetting, params({ key }));
      return row ? row.value : null;
    },

    async setSetting(key, value, now) {
      await db.run(SQL.upsertSetting, params({ key, value, now }));
    },

    async claimUpdate(updateId, now) {
      const result = await db.run(SQL.claimUpdate, params({ updateId, now }));
      return result.rowsAffected > 0;
    },

    async getMenuTap(telegramId, step) {
      return await db.get(SQL.getMenuTap, params({ telegramId, step }));
    },

    async setMenuTap({ telegramId, step, now, messageId }) {
      await db.run(
        SQL.upsertMenuTap,
        params({ telegramId, step, now, messageId: messageId ?? 0 }),
      );
    },
  };
}
