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

export const index = (name, ...cols) => ({ kind: 'index', name, cols, on: () => ({ kind: 'index', name, cols }) });
export const uniqueIndex = (name, ...cols) => ({ kind: 'uniqueIndex', name, cols, on: () => ({ kind: 'uniqueIndex', name, cols }) });
export const primaryKey = (...cols) => ({ kind: 'primaryKey', cols });

// Schema-DSL shims: schema.js declares the real tables, and this shim keeps the
// declared DB column name so `db.select()...where(eq(users.telegramId, id))`
// reads (e.g. getBalance) resolve against the in-memory database.
const mockColumn = (name) => {
  const column = { __column: true, name };
  for (const method of ['notNull', 'default', 'primaryKey', 'deprecated', 'references', 'autoIncrement']) {
    column[method] = () => column;
  }
  return column;
};
// Comparisons carry the column and value so the tiny query builder below can
// turn them into SQL instead of hard-coding call order in every test.
export const eq = (column, value) => ({ __cmp: 'eq', column: column?.name ?? column, value });
export const ne = (column, value) => ({ __cmp: 'ne', column: column?.name ?? column, value });
export const gt = (column, value) => ({ __cmp: 'gt', column: column?.name ?? column, value });
export const gte = (column, value) => ({ __cmp: 'gte', column: column?.name ?? column, value });
export const lt = (column, value) => ({ __cmp: 'lt', column: column?.name ?? column, value });
export const lte = (column, value) => ({ __cmp: 'lte', column: column?.name ?? column, value });
export const like = (column, value) => ({ __cmp: 'like', column: column?.name ?? column, value });
export const and = (...parts) => ({ __cmp: 'and', parts: parts.flat() });
export const or = (...parts) => ({ __cmp: 'or', parts: parts.flat() });
export const asc = (column) => ({ __dir: 'asc', column: column?.name ?? column });
export const desc = (column) => ({ __dir: 'desc', column: column?.name ?? column });
export const inArray = (column, values) => ({ __cmp: 'in', column: column?.name ?? column, values });
export const integer = (name) => mockColumn(name);
export const text = (name) => mockColumn(name);
// Constraint-callback failures are recorded instead of swallowed. The platform
// compiles schema.js at deploy time, so a ReferenceError there breaks the whole
// deployment while a permissive stub would keep the tests green.
export const schemaErrors = [];

export const table = (name, cols, extra) => {
  if (typeof extra === 'function') {
    try {
      extra(new Proxy({}, { get: (_t, key) => mockColumn(String(key)) }));
    } catch (error) {
      schemaErrors.push({ table: name, error });
    }
  }
  return { __table: true, tableName: name, ...(cols || {}) };
};

/** Throw if any table() constraint callback failed (used by schema tests). */
export function assertSchemaCallbacksClean() {
  if (!schemaErrors.length) return;
  const detail = schemaErrors
    .map(({ table: name, error }) => `${name}: ${error?.constructor?.name || 'Error'}: ${error?.message || error}`)
    .join('; ');
  throw new Error(`schema.js constraint callbacks failed: ${detail}`);
}

function queryOf(query) {
  if (typeof query === 'string') return { text: query, params: [] };
  if (query && '__raw' in query) return { text: String(query.__raw), params: [] };
  return { text: query.text, params: query.params || [] };
}

const tableNameOf = (target) => {
  if (typeof target === 'string') return target;
  return target?.tableName || target?.name || String(target);
};

function renderWhere(clause, params) {
  if (!clause) return '';
  if (clause.__cmp === 'and' || clause.__cmp === 'or') {
    const joiner = clause.__cmp === 'and' ? ' AND ' : ' OR ';
    const inner = (clause.parts || []).map((p) => renderWhere(p, params)).filter(Boolean);
    if (!inner.length) return '';
    return `(${inner.join(joiner)})`;
  }
  if (clause.__cmp === 'in') {
    const values = clause.values || [];
    if (!values.length) return '0';
    params.push(...values.map(normalize));
    return `${clause.column} IN (${values.map(() => '?').join(', ')})`;
  }
  const operator = {
    eq: '=', ne: '!=', gt: '>', gte: '>=', lt: '<', lte: '<=', like: 'LIKE',
  }[clause.__cmp];
  if (!operator) return '';
  params.push(normalize(clause.value));
  return `${clause.column} ${operator} ?`;
}

// Tiny stand-in for the SDK query builder: only the shapes the bot actually
// uses (select/from/where/orderBy/limit) are supported.
function selectBuilder(columns) {
  const state = { from: null, where: null, order: [], limit: null };
  const build = () => {
    const params = [];
    const cols = columns
      ? Object.values(columns).map((c) => c?.name ?? String(c)).join(', ')
      : '*';
    let text = `SELECT ${cols} FROM ${tableNameOf(state.from)}`;
    const where = renderWhere(state.where, params);
    if (where) text += ` WHERE ${where}`;
    if (state.order.length) {
      text += ` ORDER BY ${state.order.map((o) => `${o.column} ${o.__dir.toUpperCase()}`).join(', ')}`;
    }
    if (state.limit !== null) text += ` LIMIT ${Number(state.limit)}`;
    return { text, params };
  };
  const builder = {
    from(target) { state.from = target; return builder; },
    where(clause) { state.where = clause; return builder; },
    orderBy(...orders) { state.order = orders.flat(); return builder; },
    limit(value) { state.limit = value; return builder; },
    async get() {
      const { text, params } = build();
      return database.prepare(text).get(...params) || null;
    },
    async all() {
      const { text, params } = build();
      return database.prepare(text).all(...params);
    },
    async run() { return db.run(build()); },
  };
  return builder;
}

export const db = {
  select(columns) { return selectBuilder(columns); },
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
