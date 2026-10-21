import { table, integer, text, uniqueIndex, index, sql } from 'sdk/db';


// MissFrozen (Gaming) database schema — app8888370613
// Fresh-database schema: only tables this bot uses. Apply with `npx tgcloud migrate`
// on THIS app's own database. No cross-bot tables.


export const users = table('users', {
  telegramId: integer('telegram_id').primaryKey(),
  // MissFrozen gaming economy only.
  balance: integer('balance').notNull().default(0),
  lastClaimDate: text('last_claim_date'),
  username: text('username'),
  firstName: text('first_name'),
  xp: integer('xp').notNull().default(0),
  kills: integer('kills').notNull().default(0),
  narutoPatrols: integer('naruto_patrols').notNull().default(0),
  claimStreak: integer('claim_streak').notNull().default(0),
  equipped: text('equipped'),
  blocked: integer('blocked').notNull().default(0),
}, (t) => ({
  usernameIdx: index('idx_users_username').on(t.username),
}));

export const userEquipped = table('user_equipped', {
  telegramId: integer('telegram_id').notNull(),
  shinobi: text('shinobi').notNull(),
  slot: integer('slot').notNull().default(0),
}, (t) => ({
  pk: uniqueIndex('uidx_user_equipped').on(t.telegramId, t.shinobi),
  idxUser: index('idx_user_equipped_user').on(t.telegramId),
}));

export const inventory = table('inventory', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  telegramId: integer('telegram_id').notNull(),
  itemType: text('item_type').notNull(),
  itemName: text('item_name').notNull(),
  qty: integer('qty').notNull().default(1),
}, (t) => ({
  owner: uniqueIndex('uidx_inventory_owner_item').on(t.telegramId, t.itemName),
}));

export const purchases = table('purchases', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  updateId: integer('update_id'),
  telegramId: integer('telegram_id').notNull(),
  itemName: text('item_name').notNull(),
  qty: integer('qty').notNull().default(1),
  cost: integer('cost').notNull(),
  createdAt: integer('created_at').default(sql`(unixepoch())`),
}, (t) => ({
  uniqUpdate: uniqueIndex('uidx_purchases_update').on(t.updateId),
}));

export const activities = table('activities', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  telegramId: integer('telegram_id').notNull(),
  shinobi: text('shinobi').notNull(),
  kind: text('kind').notNull(),
  status: text('status').notNull().default('idle'),
  startedAt: integer('started_at').notNull().default(0),
  endsAt: integer('ends_at').notNull().default(0),
  cooldownUntil: integer('cooldown_until').notNull().default(0),
  baseRoll: integer('base_roll').notNull().default(0),
  chatId: integer('chat_id').notNull().default(0),
}, (t) => ({
  owner: uniqueIndex('uidx_activities_owner_shinobi').on(t.telegramId, t.shinobi),
}));

export const groupMembers = table('group_members', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  chatId: integer('chat_id').notNull(),
  telegramId: integer('telegram_id').notNull(),
}, (t) => ({
  uniq: uniqueIndex('uidx_group_members').on(t.chatId, t.telegramId),
}));

// Bot messages in groups waiting to be deleted.

export const cleanup = table('cleanup', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  chatId: integer('chat_id').notNull(),
  messageId: integer('message_id').notNull(),
  deleteAt: integer('delete_at').notNull(),
}, (t) => ({
  due: index('idx_cleanup_due').on(t.deleteAt),
}));

export const topicSettings = table('topic_settings', {
  settingKey: text('setting_key').primaryKey(),
  settingValue: text('setting_value').notNull(),
});

// ---- Study module tables (no foreign keys; relations are plain columns) ----

export const groupSettings = table('group_settings', {
  chatId: integer('chat_id').primaryKey(),
  economyEnabled: integer('economy_enabled').notNull().default(1),
  updatedBy: integer('updated_by'),
  updatedAt: integer('updated_at'),
});

// ---- Announce sessions ----
// state: pick_groups | pick_scope | collecting | confirming

export const announceSessions = table('announce_sessions', {
  userId: integer('user_id').primaryKey(),
  // Legacy v1 columns — still in live DB. Multi-target uses announce_targets;
  // app writes chatId:0 / chatTitle:'' placeholders on every insert.
  chatId: integer('chat_id').notNull(),
  chatTitle: text('chat_title'),
  mode: text('mode').notNull().default('admin'),
  // Aligned with live DB DEFAULT so migrate does not flag a constraint change.
  // App always sets state explicitly (pick_groups | pick_scope | collecting | confirming).
  state: text('state').notNull().default('collecting'),
  sendGroups: integer('send_groups').notNull().default(1),
  sendDms: integer('send_dms').notNull().default(0),
  createdAt: integer('created_at').notNull(),
});

export const announceTargets = table('announce_targets', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id').notNull(),
  chatId: integer('chat_id').notNull(),
  title: text('title'),
  selected: integer('selected').notNull().default(0),
}, (t) => ({
  userChat: uniqueIndex('uidx_announce_targets_user_chat').on(t.userId, t.chatId),
}));

export const announceItems = table('announce_items', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id').notNull(),
  dmMessageId: integer('dm_message_id').notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
}, (t) => ({
  userIdx: index('idx_announce_items_user').on(t.userId),
}));

export const announcedMessages = table('announced_messages', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  chatId: integer('chat_id').notNull(),
  messageId: integer('message_id').notNull(),
  announcerId: integer('announcer_id').notNull(),
  sourceDmMsgId: integer('source_dm_msg_id'),
  createdAt: integer('created_at').notNull(),
}, (t) => ({
  msg: uniqueIndex('uidx_announced_msg').on(t.chatId, t.messageId),
  ann: index('idx_announced_announcer').on(t.announcerId),
}));

export const replyBridge = table('reply_bridge', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  adminId: integer('admin_id').notNull(),
  adminMsgId: integer('admin_msg_id').notNull(),
  groupChatId: integer('group_chat_id').notNull(),
  userMsgId: integer('user_msg_id').notNull(),
  userId: integer('user_id').notNull(),
  botMsgId: integer('bot_msg_id'),
  createdAt: integer('created_at').notNull(),
}, (t) => ({
  adminMsg: uniqueIndex('uidx_reply_bridge_admin_msg').on(t.adminId, t.adminMsgId),
}));

export const knownGroups = table('known_groups', {
  chatId: integer('chat_id').primaryKey(),
  title: text('title'),
  username: text('username'),
  active: integer('active').notNull().default(1),
  // 1 = approved, 0 = disapproved (owner /diss_grp)
  approved: integer('approved').notNull().default(1),
  addedById: integer('added_by_id'),
  addedByName: text('added_by_name'),
  updatedAt: integer('updated_at').notNull(),
});


// XOXO + RPS game tables
// APPEND to schema.js — do not replace existing tables.
// Requires: table, integer, text, uniqueIndex, index from 'sdk/db'


/** Map: pending patrol rewards (claim at Hokage Office). */

/** Map: shinobi resting at BBQ for chakra recovery. */

/** Map: cached Telegram photo file_ids for storage channel messages. */

export const mapMediaCache = table('map_media_cache', {
  storageMessageId: integer('storage_message_id').primaryKey(),
  fileId: text('file_id').notNull(),
});

/** Map gate multi-select: shinobi marked for next patrol dispatch. */

export const mapGateSelection = table('map_gate_selection', {
  telegramId: integer('telegram_id').notNull(),
  shinobi: text('shinobi').notNull(),
}, (t) => ({
  pk: uniqueIndex('uidx_map_gate_sel').on(t.telegramId, t.shinobi),
}));

export const bbqSessions = table('bbq_sessions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  telegramId: integer('telegram_id').notNull(),
  shinobi: text('shinobi').notNull(),
  bbqStart: integer('bbq_start').notNull().default(0),
  lastRecoveryAt: integer('last_recovery_at').notNull().default(0),
}, (t) => ({
  ownerShinobi: uniqueIndex('uidx_bbq_sessions_owner_shinobi').on(t.telegramId, t.shinobi),
}));

export const pendingPatrolRewards = table('pending_patrol_rewards', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  telegramId: integer('telegram_id').notNull(),
  shinobi: text('shinobi').notNull(),
  kind: text('kind').notNull().default('patrol'),
  reward: integer('reward').notNull().default(0),
  completedAt: integer('completed_at').notNull().default(0),
  claimed: integer('claimed').notNull().default(0),
}, (t) => ({
  ownerShinobi: index('idx_pending_patrol_owner').on(t.telegramId, t.shinobi, t.claimed),
}));

/** Map: prepared field meal for next mission/patrol (one slot per user via shinobi='*'). */

export const fieldMeals = table('field_meals', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  telegramId: integer('telegram_id').notNull(),
  shinobi: text('shinobi').notNull().default('*'),
  mealKey: text('meal_key').notNull(),
  preparedAt: integer('prepared_at').notNull().default(0),
}, (t) => ({
  ownerShinobi: uniqueIndex('uidx_field_meals_owner_shinobi').on(t.telegramId, t.shinobi),
}));

export const gameLobbies = table('game_lobbies', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  chatId: integer('chat_id').notNull(),
  messageId: integer('message_id'),
  creatorId: integer('creator_id').notNull(),
  playerXId: integer('player_x_id'),
  playerOId: integer('player_o_id'),
  playerXUsername: text('player_x_username'),
  playerXFirstName: text('player_x_first_name'),
  playerOUsername: text('player_o_username'),
  playerOFirstName: text('player_o_first_name'),
  status: text('status').notNull(),
  stake: integer('stake').notNull().default(0),
  pot: integer('pot').notNull().default(0),
  board: text('board').notNull().default('["","","","","","","","",""]'),
  currentTurn: text('current_turn'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  turnStartedAt: integer('turn_started_at'),
  winnerId: integer('winner_id'),
  result: text('result'),
  stakesReserved: integer('stakes_reserved').notNull().default(0),
  kind: text('kind').notNull().default('open'),
  gameType: text('game_type').notNull().default('xoxo'),
  gameState: text('game_state').notNull().default('{}'),
}, (t) => ({
  chatIdx: index('idx_game_lobbies_chat').on(t.chatId),
  statusIdx: index('idx_game_lobbies_status').on(t.status),
}));

export const gameActivePlayers = table('game_active_players', {
  userId: integer('user_id').primaryKey(),
  lobbyId: integer('lobby_id').notNull(),
});

export const gameMatches = table('game_matches', {
  lobbyId: integer('lobby_id').primaryKey(),
  chatId: integer('chat_id').notNull(),
  playerXId: integer('player_x_id'),
  playerOId: integer('player_o_id'),
  stake: integer('stake'),
  pot: integer('pot'),
  result: text('result'),
  winnerId: integer('winner_id'),
  finishedAt: integer('finished_at').notNull(),
  gameType: text('game_type').notNull().default('xoxo'),
});

export const xoxoStats = table('xoxo_stats', {
  userId: integer('user_id').primaryKey(),
  games: integer('games').notNull().default(0),
  wins: integer('wins').notNull().default(0),
  losses: integer('losses').notNull().default(0),
  draws: integer('draws').notNull().default(0),
  coinsWon: integer('coins_won').notNull().default(0),
  coinsLost: integer('coins_lost').notNull().default(0),
  streak: integer('streak').notNull().default(0),
  bestStreak: integer('best_streak').notNull().default(0),
});

export const rpsStats = table('rps_stats', {
  userId: integer('user_id').primaryKey(),
  games: integer('games').notNull().default(0),
  wins: integer('wins').notNull().default(0),
  losses: integer('losses').notNull().default(0),
  draws: integer('draws').notNull().default(0),
  coinsWon: integer('coins_won').notNull().default(0),
  coinsLost: integer('coins_lost').notNull().default(0),
  streak: integer('streak').notNull().default(0),
  bestStreak: integer('best_streak').notNull().default(0),
});

/** Idempotent stake/payout keys (replaces Python transactions for games). */

export const gameTx = table('game_tx', {
  key: text('key').primaryKey(),
  createdAt: integer('created_at').notNull(),
});

// Persistent support inbox routing. Existing topics and conversation history are retained.

export const supportConversations = table('support_conversations', {
  userId: integer('user_id').primaryKey(),
  // NULL only while a first-topic creation reservation is in progress.
  threadId: integer('thread_id'),
  status: text('status').notNull().default('stopped'),
  displayName: text('display_name').notNull().default('User'),
  username: text('username'),
  lastConfirmationMessageId: integer('last_confirmation_message_id'),
  isBanned: integer('is_banned').notNull().default(0),
  introMessageId: integer('intro_message_id'),
  unbanPromptAt: integer('unban_prompt_at').notNull().default(0),
  unbanRequestAt: integer('unban_request_at').notNull().default(0),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
}, (t) => ({
  thread: uniqueIndex('uidx_support_conversations_thread').on(t.threadId),
}));

// ---- Frozen Blooded shinobi RPG state (all additive; unix-epoch seconds) ----

/** Per-shinobi persistent state: level, exhaustion, death, robbery, training. */

export const shinobiState = table('shinobi_state', {
  telegramId: integer('telegram_id').notNull(),
  shinobi: text('shinobi').notNull(),
  level: integer('level').notNull().default(1),
  // Consecutive completed patrols since the last exhaustion reset.
  patrolStreak: integer('patrol_streak').notNull().default(0),
  // Shinobi is exhausted until this timestamp (0 = not exhausted).
  exhaustedUntil: integer('exhausted_until').notNull().default(0),
  // Shinobi is dead until this timestamp (0 = alive). Revival is automatic.
  deadUntil: integer('dead_until').notNull().default(0),
  // Target's equipped shinobi was robbed at this timestamp (24h robbery lockout).
  lastRobbedAt: integer('last_robbed_at').notNull().default(0),
  // Training Ground progress (sessions completed for this shinobi).
  trainSessions: integer('train_sessions').notNull().default(0),
  // Next time a training session may start (one per day).
  nextTrainAt: integer('next_train_at').notNull().default(0),
}, (t) => ({
  ownerShinobi: uniqueIndex('uidx_shinobi_state').on(t.telegramId, t.shinobi),
}));

/** Per-user skill state: protection, healing cooldowns and use counts, byakugan. */

export const userSkills = table('user_skills', {
  telegramId: integer('telegram_id').primaryKey(),
  // Jiraiya /protect — user immunity until this timestamp.
  protectedUntil: integer('protected_until').notNull().default(0),
  // Sakura's Healing: last successful use (24h cooldown) and total successful uses.
  sakuraHealAt: integer('sakura_heal_at').notNull().default(0),
  sakuraHealUses: integer('sakura_heal_uses').notNull().default(0),
  // Katsuyu's Healing: 24h skill cooldown.
  katsuyuHealAt: integer('katsuyu_heal_at').notNull().default(0),
  // Hinata /byakugan: last successful use (24h cooldown).
  byakuganAt: integer('byakugan_at').notNull().default(0),
}, (t) => ({}));

/** Hidden Tsunade search sessions (one active or outstanding row per user). */

export const tsunadeSearch = table('tsunade_search', {
  telegramId: integer('telegram_id').primaryKey(),
  // 'active' = session running; 'done' = session finished and result shown.
  status: text('status').notNull().default('active'),
  startedAt: integer('started_at').notNull().default(0),
  endsAt: integer('ends_at').notNull().default(0),
  // Daily-use bookkeeping (IST day key + number of sessions started that day).
  dayKey: text('day_key'),
  dayCount: integer('day_count').notNull().default(0),
  // Completed 6-hour sessions ever (feeds the discovery roll, max 10).
  totalSearches: integer('total_searches').notNull().default(0),
  // 1 = Tsunade discovered; searches disabled permanently for this user.
  found: integer('found').notNull().default(0),
  foundAt: integer('found_at').notNull().default(0),
});

/** Pending Itachi kill attacks awaiting Shadow Clone activation or timeout. */

export const clonePending = table('clone_pending', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  attackerId: integer('attacker_id').notNull(),
  targetId: integer('target_id').notNull(),
  targetShinobi: text('target_shinobi').notNull(),
  chatId: integer('chat_id').notNull(),
  messageId: integer('message_id').notNull().default(0),
  // Seconds the target had to activate the clone (by Naruto level).
  windowSec: integer('window_sec').notNull().default(5),
  expiresAt: integer('expires_at').notNull().default(0),
  // pending | clone (blocked) | killed | timeout (killed)
  status: text('status').notNull().default('pending'),
  createdAt: integer('created_at').notNull().default(0),
}, (t) => ({
  targetPending: index('idx_clone_pending_target').on(t.targetId, t.status),
}));

/** Idempotency keys for at-most-once RPG effects (kills, robberies, heals, BBQ payments). */

export const rpgTx = table('rpg_tx', {
  key: text('key').primaryKey(),
  createdAt: integer('created_at').notNull(),
});

// Message IDs and optional source-chat fields route topic replies back to DMs or group messages.

export const supportMessageLinks = table('support_message_links', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id').notNull(),
  threadId: integer('thread_id').notNull(),
  supportMessageId: integer('support_message_id').notNull(),
  userMessageId: integer('user_message_id').notNull(),
  sourceChatId: integer('source_chat_id'),
  sourceThreadId: integer('source_thread_id'),
  createdAt: integer('created_at').notNull(),
}, (t) => ({
  uniqueTopicMessage: uniqueIndex('uidx_support_message_links_topic_message').on(t.threadId, t.supportMessageId),
  userIdx: index('idx_support_message_links_user').on(t.userId),
}));

/** Coupon codes created by owner; redeemable by any user once. */

export const coupons = table('coupons', {
  code: text('code').primaryKey(),
  // JSON string of rewards, e.g. {"coins":1000,"chakra":50,"shinobis":["Naruto"],"gift":"Rose"}
  rewards: text('rewards').notNull().default('{}'),
  // Unix expiry; 0 = never
  expiresAt: integer('expires_at').notNull().default(0),
  active: integer('active').notNull().default(1),
  createdAt: integer('created_at').notNull().default(0),
  createdBy: integer('created_by').notNull().default(0),
}, (t) => ({
  activeIdx: index('idx_coupons_active').on(t.active),
}));

/** One redemption per user per coupon. */

export const couponRedemptions = table('coupon_redemptions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  code: text('code').notNull(),
  telegramId: integer('telegram_id').notNull(),
  redeemedAt: integer('redeemed_at').notNull().default(0),
}, (t) => ({
  uniq: uniqueIndex('uidx_coupon_redemptions').on(t.code, t.telegramId),
  userIdx: index('idx_coupon_redemptions_user').on(t.telegramId),
}));

// Declared here so a fresh database gets it via `tgcloud migrate`.
// (map/handler.js also keeps its CREATE TABLE IF NOT EXISTS guard.)
export const mapMissionSelection = table('map_mission_selection', {
  telegramId: integer('telegram_id').notNull(),
  shinobi: text('shinobi').notNull(),
}, (t) => ({
  pk: uniqueIndex('uidx_map_mission_selection').on(t.telegramId, t.shinobi),
}));
