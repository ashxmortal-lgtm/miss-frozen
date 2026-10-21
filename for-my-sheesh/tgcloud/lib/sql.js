// All SQL used by the durable allowlist/settings store lives here, with no SDK
// import, so the exact same statements can be executed by tests against
// node:sqlite. Named parameters use TGCloud's documented `:name` syntax; the
// test adapter strips the leading colon.
//
// Tables are declared in tgcloud/schema.js and created by `npx tgcloud migrate`.

const ACCESS_COLUMNS = `
  telegram_id AS telegramId,
  role,
  granted_at AS grantedAt,
  granted_by AS grantedBy,
  updated_at AS updatedAt
`;

export const SQL = Object.freeze({
  ensureOwner: `
    INSERT INTO access_list (telegram_id, role, granted_at, granted_by, updated_at)
    VALUES (:telegramId, 'owner', :now, :now, :now)
    ON CONFLICT(telegram_id) DO NOTHING
  `,

  getAccess: `SELECT ${ACCESS_COLUMNS} FROM access_list WHERE telegram_id = :telegramId`,

  listAccess: `
    SELECT ${ACCESS_COLUMNS}
    FROM access_list
    ORDER BY CASE role WHEN 'owner' THEN 0 ELSE 1 END, granted_at ASC, telegram_id ASC
  `,

  insertMember: `
    INSERT INTO access_list (telegram_id, role, granted_at, granted_by, updated_at)
    VALUES (:telegramId, 'member', :now, :grantedBy, :now)
    ON CONFLICT(telegram_id) DO NOTHING
  `,

  deleteNonOwner: `
    DELETE FROM access_list
    WHERE telegram_id = :telegramId AND role <> 'owner'
  `,

  // Used only after application code has proved the target is not the
  // configured owner. Lets the owner clean up a poisoned 'owner' row.
  deleteAny: `
    DELETE FROM access_list
    WHERE telegram_id = :telegramId
  `,

  insertAudit: `
    INSERT INTO owner_audit (actor_id, action, target_id, created_at)
    VALUES (:actorId, :action, :targetId, :now)
  `,

  getSetting: `SELECT setting_value AS value FROM bot_settings WHERE setting_key = :key`,

  upsertSetting: `
    INSERT INTO bot_settings (setting_key, setting_value, updated_at)
    VALUES (:key, :value, :now)
    ON CONFLICT(setting_key) DO UPDATE SET
      setting_value = excluded.setting_value,
      updated_at = excluded.updated_at
  `,

  claimUpdate: `
    INSERT INTO processed_updates (update_id, processed_at)
    VALUES (:updateId, :now)
    ON CONFLICT(update_id) DO NOTHING
  `,

  getMenuTap: `
    SELECT sent_at AS sentAt, message_id AS messageId
    FROM menu_taps
    WHERE telegram_id = :telegramId AND step = :step
  `,

  upsertMenuTap: `
    INSERT INTO menu_taps (telegram_id, step, sent_at, message_id)
    VALUES (:telegramId, :step, :now, :messageId)
    ON CONFLICT(telegram_id, step) DO UPDATE SET
      sent_at = excluded.sent_at,
      message_id = excluded.message_id
  `,
});

export const AUDIT_ACTIONS = Object.freeze({
  GRANT: 'grant',
  REVOKE: 'revoke',
  SET_MINI_APP_URL: 'set_mini_app_url',
});
