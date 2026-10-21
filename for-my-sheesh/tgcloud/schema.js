import { table, integer, text, check, index, primaryKey, sql } from 'sdk/db';

// For My Sheesh — durable state.
//
// TGCloud gives every bot its own persistent SQLite database. Apply this schema
// with `npx tgcloud migrate`; `push` alone never changes the database.
//
// No foreign keys (the runtime disables them), so integrity is enforced in
// application code. The allowlist is the single source of truth for access; the
// owner ID itself is trusted server config (tgcloud/lib/config.js), never a row.

export const accessList = table(
  'access_list',
  {
    // Verified numeric Telegram user ID.
    telegramId: integer('telegram_id').primaryKey(),
    // 'owner' | 'member'. The owner row is bootstrapped idempotently; a row can
    // never promote a non-owner because authorization compares the config ID.
    role: text('role').notNull().default('member'),
    grantedAt: integer('granted_at').notNull(),
    grantedBy: integer('granted_by').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => ({
    roleCheck: check('access_role_check', sql`${t.role} in ('owner', 'member')`),
    grantedIdx: index('idx_access_granted_at').on(t.grantedAt),
  }),
);

// Append-only record of owner actions. Failures here never grant or revoke
// anything; they are only logged.
export const ownerAudit = table(
  'owner_audit',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    actorId: integer('actor_id').notNull(),
    action: text('action').notNull(),
    targetId: integer('target_id').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => ({
    createdIdx: index('idx_owner_audit_created').on(t.createdAt),
  }),
);

// Small key/value table: currently only the Mini App base URL, so the owner can
// point the gift button at the deployed app without a redeploy.
export const botSettings = table('bot_settings', {
  settingKey: text('setting_key').primaryKey(),
  settingValue: text('setting_value').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

// Telegram may redeliver the same update. Claiming update_id before handling
// makes callback handling idempotent.
export const processedUpdates = table('processed_updates', {
  updateId: integer('update_id').primaryKey(),
  processedAt: integer('processed_at').notNull(),
});

// Cooldown for rapid double-taps on the same menu step, so one tap does not
// stack identical messages. One row per user + step.
export const menuTaps = table(
  'menu_taps',
  {
    telegramId: integer('telegram_id').notNull(),
    step: text('step').notNull(),
    sentAt: integer('sent_at').notNull(),
    messageId: integer('message_id').notNull().default(0),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.telegramId, t.step] }),
    sentIdx: index('idx_menu_taps_sent').on(t.sentAt),
  }),
);
