import { DatabaseSync } from 'node:sqlite';
import { SQL } from '../../tgcloud/lib/sql.js';

// Mirrors tgcloud/schema.js. Kept explicit so tests exercise the real SQL from
// lib/sql.js against a persistent SQLite file, just like TGCloud's built-in DB.
export const DDL = `
CREATE TABLE IF NOT EXISTS access_list (
  telegram_id INTEGER PRIMARY KEY,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
  granted_at INTEGER NOT NULL,
  granted_by INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_access_granted_at ON access_list (granted_at);

CREATE TABLE IF NOT EXISTS owner_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  target_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_owner_audit_created ON owner_audit (created_at);

CREATE TABLE IF NOT EXISTS bot_settings (
  setting_key TEXT PRIMARY KEY,
  setting_value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS processed_updates (
  update_id INTEGER PRIMARY KEY,
  processed_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS menu_taps (
  telegram_id INTEGER NOT NULL,
  step TEXT NOT NULL,
  sent_at INTEGER NOT NULL,
  message_id INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (telegram_id, step)
);
CREATE INDEX IF NOT EXISTS idx_menu_taps_sent ON menu_taps (sent_at);
`;

function normalizeParams(values) {
  if (!values) return {};
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key.replace(/^:/, ''), value]),
  );
}

export function createSqliteStore(options = {}) {
  const database = new DatabaseSync(options.file ?? ':memory:');
  database.exec(DDL);

  const run = (sql, values) => database.prepare(sql).run(normalizeParams(values));
  const get = (sql, values) => database.prepare(sql).get(normalizeParams(values)) ?? null;
  const all = (sql, values) => database.prepare(sql).all(normalizeParams(values));

  return {
    async ensureOwner({ ownerId, now }) {
      run(SQL.ensureOwner, { telegramId: ownerId, now });
    },
    async get(telegramId) {
      return get(SQL.getAccess, { telegramId });
    },
    async list() {
      return all(SQL.listAccess);
    },
    async insertMember({ telegramId, now, grantedBy }) {
      return run(SQL.insertMember, { telegramId, now, grantedBy }).changes > 0;
    },
    async deleteNonOwner(telegramId) {
      return run(SQL.deleteNonOwner, { telegramId }).changes > 0;
    },
    async deleteAny(telegramId) {
      return run(SQL.deleteAny, { telegramId }).changes > 0;
    },
    async audit({ actorId, action, targetId, now }) {
      run(SQL.insertAudit, { actorId, action, targetId, now });
    },
    async getSetting(key) {
      const row = get(SQL.getSetting, { key });
      return row ? row.value : null;
    },
    async setSetting(key, value, now) {
      run(SQL.upsertSetting, { key, value, now });
    },
    async claimUpdate(updateId, now) {
      return run(SQL.claimUpdate, { updateId, now }).changes > 0;
    },
    async getMenuTap(telegramId, step) {
      return get(SQL.getMenuTap, { telegramId, step });
    },
    async setMenuTap({ telegramId, step, now, messageId }) {
      run(SQL.upsertMenuTap, { telegramId, step, now, messageId: messageId ?? 0 });
    },
    // Test-only escape hatch for poisoned-row / raw assertions.
    raw(sql, values = {}) {
      return run(sql, values);
    },
    rawGet(sql, values = {}) {
      return get(sql, values);
    },
    close() {
      database.close();
    },
    get database() {
      return database;
    },
  };
}
