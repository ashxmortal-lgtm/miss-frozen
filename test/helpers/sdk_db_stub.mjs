// Minimal SDK database shim backed by node:sqlite for integration tests.
import { DatabaseSync } from 'node:sqlite';

export const database = new DatabaseSync(':memory:');

const normalize = (value) => {
  if (value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof Date) return Math.floor(value.getTime() / 1000);
  return value;
};

export function sql(strings, ...values) {
  let text = '';
  const params = [];
  strings.forEach((part, index) => {
    text += part;
    if (index >= values.length) return;
    const value = values[index];
    if (value && typeof value === 'object' && '__raw' in value) {
      text += String(value.__raw);
    } else {
      text += '?';
      params.push(normalize(value));
    }
  });
  return { text, params };
}
sql.raw = (text) => ({ __raw: String(text) });

export const index = (name, ...cols) => ({ kind: 'index', name, cols });
export const uniqueIndex = (name, ...cols) => ({ kind: 'uniqueIndex', name, cols });
export const primaryKey = (...cols) => ({ kind: 'primaryKey', cols });

function queryOf(query) {
  if (typeof query === 'string') return { text: query, params: [] };
  if (query && '__raw' in query) return { text: String(query.__raw), params: [] };
  return { text: query.text, params: query.params || [] };
}

export const db = {
  async run(query) {
    const { text, params } = queryOf(query);
    const statement = database.prepare(text);
    const result = statement.run(...params);
    return {
      rowsAffected: Number(result.changes || 0),
      lastInsertRowid: Number(result.lastInsertRowid || 0),
    };
  },
  async get(query) {
    const { text, params } = queryOf(query);
    return database.prepare(text).get(...params) || null;
  },
  async all(query) {
    const { text, params } = queryOf(query);
    return database.prepare(text).all(...params);
  },
};

database.exec(`
  CREATE TABLE users (
    telegram_id INTEGER PRIMARY KEY,
    balance INTEGER NOT NULL DEFAULT 0,
    last_claim_date TEXT,
    username TEXT,
    first_name TEXT,
    xp INTEGER NOT NULL DEFAULT 0,
    kills INTEGER NOT NULL DEFAULT 0,
    naruto_patrols INTEGER NOT NULL DEFAULT 0,
    claim_streak INTEGER NOT NULL DEFAULT 0,
    equipped TEXT,
    blocked INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE inventory (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id INTEGER NOT NULL,
    item_type TEXT NOT NULL,
    item_name TEXT NOT NULL,
    qty INTEGER NOT NULL DEFAULT 1
  );
  CREATE UNIQUE INDEX uidx_inventory_owner_item ON inventory (telegram_id, item_name);
  CREATE TABLE purchases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    update_id INTEGER,
    telegram_id INTEGER NOT NULL,
    item_name TEXT NOT NULL,
    qty INTEGER NOT NULL DEFAULT 1,
    cost INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX uidx_purchases_update ON purchases (update_id);
  CREATE TABLE rpg_tx (key TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
  CREATE TABLE shinobi_state (
    telegram_id INTEGER NOT NULL,
    shinobi TEXT NOT NULL,
    level INTEGER NOT NULL DEFAULT 1,
    patrol_streak INTEGER NOT NULL DEFAULT 0,
    exhausted_until INTEGER NOT NULL DEFAULT 0,
    dead_until INTEGER NOT NULL DEFAULT 0,
    last_robbed_at INTEGER NOT NULL DEFAULT 0,
    train_sessions INTEGER NOT NULL DEFAULT 0,
    next_train_at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (telegram_id, shinobi)
  );
  CREATE TABLE activities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id INTEGER NOT NULL,
    shinobi TEXT NOT NULL,
    kind TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'idle',
    started_at INTEGER NOT NULL DEFAULT 0,
    ends_at INTEGER NOT NULL DEFAULT 0,
    cooldown_until INTEGER NOT NULL DEFAULT 0,
    base_roll INTEGER NOT NULL DEFAULT 0,
    chat_id INTEGER NOT NULL DEFAULT 0,
    cooldown_sec INTEGER NOT NULL DEFAULT 0
  );
`);
