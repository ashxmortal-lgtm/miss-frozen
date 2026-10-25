// `ensureMtEphemeralCommand()`: /mt must be registered as an ephemeral group
// command without wiping the rest of the menu, and a menu whose flag was lost
// must be repaired instead of being suppressed by the in-memory cache.
// Telegram's setMyCommands replaces the whole scope, so the live list is read
// first and merged.
import assert from 'node:assert/strict';
import { api } from 'sdk';
import {
  ensureMtEphemeralCommand, resetMtRegistrationState,
} from '../../tgcloud/lib/mt.js';
import { COMMANDS } from '../../tgcloud/lib/command_registry.js';
import { style } from '../../tgcloud/lib/texts.js';

// ---- a tiny fake Telegram command store -------------------------------------
let store = [];
let getCalls = 0;
let setCalls = 0;
let setFails = 0;
let getFails = 0;
let getSupported = true;

api.getMyCommands = async (payload) => {
  getCalls += 1;
  assert.deepEqual(payload?.scope, { type: 'all_group_chats' }, 'the group scope is used');
  if (getFails > 0) { getFails -= 1; throw Object.assign(new Error('Bad Request: unknown method'), { code: 400 }); }
  return store.map((c) => ({ ...c }));
};
const storeCommands = async (payload) => {
  setCalls += 1;
  assert.deepEqual(payload.scope, { type: 'all_group_chats' });
  assert.ok(Array.isArray(payload.commands), 'the command list is an array');
  if (setFails > 0) { setFails -= 1; throw Object.assign(new Error('Bad Request: command list invalid'), { code: 400 }); }
  store = payload.commands.map((c) => ({ ...c }));
  return true;
};
api.setMyCommands = storeCommands;

const USER_COMMANDS = COMMANDS.filter((c) => c.access === 'user' && !c.hidden);
const nameOf = (entry) => entry.command?.replace(/^\//, '') || String(entry.cmd || '').replace(/^\//, '');
const byName = (list, name) => list.find((c) => nameOf(c) === name);
const resetCounters = () => { getCalls = 0; setCalls = 0; setFails = 0; getFails = 0; };

const realNow = Date.now;
const advance = (ms) => { Date.now = () => realNow() + ms; };
const restoreNow = () => { Date.now = realNow; };

// ---- 1. a cold bot registers the full menu with /mt marked ephemeral --------
resetMtRegistrationState();
store = [];
resetCounters();
assert.equal(await ensureMtEphemeralCommand(), true);
assert.equal(setCalls, 1, 'one write on a cold start');
const first = byName(store, 'mt');
assert.ok(first, '/mt is registered');
assert.equal(first.is_ephemeral, true, '/mt carries is_ephemeral: true');
assert.equal(store.filter((c) => c.is_ephemeral).length, 1, 'no other command is marked ephemeral');
assert.equal(store.length, USER_COMMANDS.length, 'the whole user menu is written');
for (const cmd of USER_COMMANDS) {
  assert.ok(byName(store, nameOf(cmd)), `${cmd.cmd} is registered`);
}
assert.equal(byName(store, 'search_tsuna'), undefined, 'the hidden discovery command stays out');

// ---- 2. an already correct menu is not written again ------------------------
resetCounters();
assert.equal(await ensureMtEphemeralCommand(), true);
assert.equal(setCalls, 0, 'no setMyCommands when /mt is already ephemeral');
assert.equal(getCalls, 0, 'and the verified menu is cached for the isolate');

// ---- 3. a lost ephemeral flag is repaired (the cache expires) ---------------
// Simulate Telegram dropping the flag (e.g. the menu was rewritten elsewhere).
store = store.map((c) => (nameOf(c) === 'mt' ? { command: 'mt', description: c.description } : c));
advance(61_000);
resetCounters();
assert.equal(await ensureMtEphemeralCommand(), true, 'the repair succeeds');
assert.equal(setCalls, 1, 'the lost flag triggers exactly one rewrite');
assert.equal(byName(store, 'mt').is_ephemeral, true, 'the flag is back');
restoreNow();

// ---- 4. repair preserves commands this code base does not own ---------------
resetMtRegistrationState();
store = [
  { command: 'mt', description: 'Mind Transmission' }, // flag lost
  { command: 'custom_admin', description: 'Custom bot command' },
  { command: 'help', description: 'stale description' },
];
resetCounters();
assert.equal(await ensureMtEphemeralCommand(), true);
assert.equal(setCalls, 1, 'the stale menu is repaired');
assert.equal(byName(store, 'mt').is_ephemeral, true, '/mt got the flag');
const custom = byName(store, 'custom_admin');
assert.ok(custom, 'the foreign command is preserved');
assert.equal(custom.description, style('Custom bot command'),
  'its text is untouched (the API wrapper applies the bot style to descriptions)');
assert.equal(custom.is_ephemeral, undefined, 'the foreign command is not made ephemeral');
assert.equal(store.length, USER_COMMANDS.length + 1, 'registry commands are added, nothing is dropped');
for (const cmd of USER_COMMANDS) {
  assert.ok(byName(store, nameOf(cmd)), `${cmd.cmd} survives the repair`);
}
assert.ok(!store.some((c) => nameOf(c) === 'mt_telepathy'), 'no invented entries');

// ---- 5. a malformed command list is handled safely --------------------------
resetMtRegistrationState();
const malformed = [null, 'nope', 42, { description: 'no name' }, { command: '!!bad!!', description: 'x' }];
api.getMyCommands = async () => malformed;
store = [];
resetCounters();
assert.equal(await ensureMtEphemeralCommand(), true);
assert.equal(setCalls, 1, 'a malformed list is replaced by the registry menu');
assert.equal(byName(store, 'mt').is_ephemeral, true);
api.getMyCommands = async (payload) => {
  getCalls += 1;
  assert.deepEqual(payload?.scope, { type: 'all_group_chats' });
  if (getFails > 0) { getFails -= 1; throw Object.assign(new Error('Bad Request: unknown method'), { code: 400 }); }
  return store.map((c) => ({ ...c }));
};

// ---- 6. a failed registration is retried, not cached as success -------------
resetMtRegistrationState();
store = [];
resetCounters();
setFails = 1;
assert.equal(await ensureMtEphemeralCommand(), false, 'the failure is reported');
assert.equal(setCalls, 2, 'the flag write, then the menu-only fallback');
assert.equal(byName(store, 'mt').is_ephemeral, undefined, 'the fallback menu has no flag');
// A second invocation inside the retry window does not hammer Telegram.
assert.equal(await ensureMtEphemeralCommand(), false);
assert.equal(setCalls, 2, 'the retry is throttled');
// After the window the next /mt tries the flag again and succeeds.
advance(61_000);
assert.equal(await ensureMtEphemeralCommand(), true, 'the retry succeeds');
assert.equal(setCalls, 3, 'exactly one extra attempt');
assert.equal(byName(store, 'mt').is_ephemeral, true);
restoreNow();

// ---- 7. force bypasses the cache (group-join hook / manual repair) ----------
resetCounters();
assert.equal(await ensureMtEphemeralCommand({ force: true }), true);
assert.equal(getCalls, 1, 'a forced call re-reads the live menu');
assert.equal(setCalls, 0, 'still no write when the menu is correct');

// ---- 8. an unsupported is_ephemeral keeps the menu but stays unverified -----
resetMtRegistrationState();
store = [];
resetCounters();
let writes = 0;
api.setMyCommands = async (payload) => {
  writes += 1;
  if (payload.commands.some((c) => c.is_ephemeral)) {
    throw Object.assign(new Error('Bad Request: is_ephemeral is not supported'), { code: 400 });
  }
  store = payload.commands.map((c) => ({ ...c }));
  return true;
};
assert.equal(await ensureMtEphemeralCommand(), false, 'a stripped-menu fallback is not a verified success');
assert.equal(writes, 2, 'the flag write, then a menu-only fallback');
assert.equal(byName(store, 'mt') !== undefined, true, 'the group menu still exists');
assert.equal(byName(store, 'mt').is_ephemeral, undefined, 'the fallback cannot set the flag');
// Not verified: the next window tries the flag again instead of suppressing it.
advance(61_000);
assert.equal(await ensureMtEphemeralCommand(), false);
assert.equal(writes, 4, 'the flag is attempted again');
restoreNow();

// ---- 9. getMyCommands unsupported: still register the menu once --------------
resetMtRegistrationState();
api.setMyCommands = storeCommands; // restore after the unsupported-flag mock
store = [];
resetCounters();
const withoutGet = api.getMyCommands;
delete api.getMyCommands;
assert.equal(await ensureMtEphemeralCommand(), true, 'registration works without a read');
assert.equal(byName(store, 'mt').is_ephemeral, true);
assert.equal(setCalls, 1, 'one write when the live list cannot be read');
resetCounters();
assert.equal(await ensureMtEphemeralCommand(), true);
assert.equal(setCalls, 0, 'the verified cache prevents a second write');
api.getMyCommands = withoutGet;

// ---- 10. the other registered commands keep working -------------------------
for (const cmd of ['help', 'balance', 'inventory', 'buy', 'rob', 'protect', 'byakugan', 'mt']) {
  assert.ok(byName(store, cmd), `/${cmd} is still registered after the repairs`);
}
assert.equal(store.filter((c) => c.is_ephemeral).length, 1, 'only /mt is ephemeral');

console.log('mt registration: OK');
