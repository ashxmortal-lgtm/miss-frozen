// MissFrozen Mini App endpoint: gaming data only (profile, balance, store,
// inventory, abilities, levels, gifts). Study actions are rejected.
import { api, db, EndpointError } from 'sdk';
import { eq } from 'sdk/db';
import { inventory } from '../schema.js';
import { profileData } from '../lib/profile.js';
import { claimDaily, todayKey, DAILY_COINS, DAILY_CHAKRA, BONUS_COINS, BONUS_CHAKRA, SAKURA_COINS, SAKURA_CHAKRA } from '../lib/economy.js';
import { ITEMS, CHAKRA_RATE, CHAKRA_MIN } from '../lib/store.js';
import { purchase } from '../lib/purchase.js';
import { GIFTS } from '../lib/gift.js';
import { ROWS as ABILITY_ROWS } from '../lib/ability.js';
import { levelUpData } from '../lib/levels.js';
import { pendingRewardTotal } from '../lib/map/pending.js';

const fail = (message, code) => { throw new EndpointError(message, { code }); };
const safeId = (value) => Number.isSafeInteger(Number(value)) && Number(value) > 0;
const ERROR_REPORT_OWNER_ID = 8716863150;
const ERROR_REPORT_CHUNK_SIZE = 3500;
const ERROR_REPORT_DEDUPE_MS = 60_000;
const ERROR_REPORT_DEDUPE_LIMIT = 100;
const recentErrorReports = new Map();
const MINIAPP_ACTIONS = new Set(['bootstrap', 'claim', 'purchase']);

function sanitizeDiagnosticText(value, user) {
  let text = String(value ?? '');
  for (const key of ['id', 'username', 'first_name', 'last_name', 'phone_number']) {
    let personalValue;
    try { personalValue = user?.[key]; } catch (_) {}
    if (typeof personalValue === 'string' || typeof personalValue === 'number') {
      const secret = String(personalValue);
      if (secret.length >= 2) text = text.split(secret).join('[redacted user data]');
    }
  }
  return text
    .replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g, '[redacted bot token]')
    .replace(/\bTMA\s+[A-Za-z0-9+/=_-]{16,}/gi, 'TMA [redacted initData]')
    .replace(/\b(initData|init_data|tgWebAppData)\s*[:=]\s*[^,\s;]+/gi, '$1=[redacted]')
    .replace(/\b(authorization)\s*[:=]\s*[^\r\n,;]+/gi, '$1=[redacted]')
    .replace(/\b(token|secret|password)\s*[:=]\s*[^,\s;]+/gi, '$1=[redacted]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[redacted email]')
    .replace(/(?:\+?\d{1,3}[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}\b/g, '[redacted phone number]')
    .replace(/@[A-Za-z0-9_]{5,}/g, '[redacted handle]')
    .replace(/\b\d{6,20}\b/g, '[redacted numeric identifier]');
}

function errorField(error, field, fallback) {
  try {
    const value = error?.[field];
    return typeof value === 'string' && value ? value : fallback;
  } catch (_) {
    return fallback;
  }
}

function errorFingerprint(value) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function isDuplicateErrorReport(fingerprint, now) {
  for (const [key, expiresAt] of recentErrorReports) {
    if (expiresAt <= now) recentErrorReports.delete(key);
  }
  if (recentErrorReports.has(fingerprint)) return true;
  recentErrorReports.set(fingerprint, now + ERROR_REPORT_DEDUPE_MS);
  while (recentErrorReports.size > ERROR_REPORT_DEDUPE_LIMIT) {
    recentErrorReports.delete(recentErrorReports.keys().next().value);
  }
  return false;
}

function splitTelegramText(text, limit = ERROR_REPORT_CHUNK_SIZE) {
  const chunks = [];
  let chunk = '';
  for (const character of text) {
    if (chunk.length + character.length > limit) {
      chunks.push(chunk);
      chunk = '';
    }
    chunk += character;
  }
  if (chunk || chunks.length === 0) chunks.push(chunk);
  return chunks;
}

async function reportMiniAppRuntimeError(error, action, user) {
  try {
    const safeAction = MINIAPP_ACTIONS.has(action) ? action : 'unknown';
    const name = sanitizeDiagnosticText(
      errorField(error, 'name', 'NonErrorThrow'), user,
    );
    const message = sanitizeDiagnosticText(
      errorField(error, 'message', String(error)), user,
    );
    const stack = sanitizeDiagnosticText(
      errorField(error, 'stack', '(stack unavailable)'), user,
    );
    const fingerprint = errorFingerprint(`${safeAction}\n${name}\n${message}\n${stack}`);
    const now = Date.now();
    if (isDuplicateErrorReport(fingerprint, now)) return;

    const timestamp = new Date(now).toISOString();
    const report = [
      'Frozen Blooded Mini App runtime error',
      'Endpoint: miniapp',
      `Action: ${safeAction}`,
      `Timestamp: ${timestamp}`,
      `Error name: ${name}`,
      `Error message: ${message}`,
      'Stack:',
      stack,
    ].join('\n');
    const chunks = splitTelegramText(report);
    for (let i = 0; i < chunks.length; i += 1) {
      await api.sendMessage({
        chat_id: ERROR_REPORT_OWNER_ID,
        text: `[Mini App error ${fingerprint} | part ${i + 1}/${chunks.length}]\n${chunks[i]}`,
      });
    }
  } catch (reportError) {
    try { console.error('Mini App owner error report failed; preserving original exception.', reportError); } catch (_) {}
  }
}



async function dashboard(user) {
  const uid = user.id;
  const profile = await profileData(user);
  async function safe(label, fn, fallback) {
    try { return await fn(); }
    catch (err) {
      try { console.error('miniapp dashboard partial failure:', label, err && err.message); } catch (_) {}
      return fallback;
    }
  }
  const [owned, levels, pendingRewards] = await Promise.all([
    safe('inventory', () => db.select().from(inventory).where(eq(inventory.telegramId, uid)).all(), []),
    safe('levels', () => levelUpData(user), null),
    safe('pendingRewards', () => pendingRewardTotal(uid), 0),
  ]);
  const ownedByName = new Map(owned.map((item) => [item.itemName, item]));
  return {
    profile,
    today: todayKey(),
    balance: {
      coins: profile.balance,
      kills: profile.kills,
      rank: profile.rank,
      chakra: profile.chakra,
      pendingRewards,
    },
    inventory: owned.map((item) => ({ type: item.itemType, name: item.itemName, qty: item.qty || 1 })),
    store: [
      ...ITEMS.map((item) => ({ ...item, owned: ownedByName.has(item.name) })),
      { name: 'Chakra', emoji: '⚡', price: CHAKRA_MIN * CHAKRA_RATE, type: 'chakra', qty: CHAKRA_MIN, owned: false },
    ],
    abilities: ABILITY_ROWS.map(([name, description]) => ({ name, description })),
    levels,
    gifts: GIFTS.map(({ id, emoji, name, price }) => ({ id, emoji, name, price })),
  };
}

async function handleMiniApp(input, ctx) {
  // The platform verifies initData. Never accept an account ID from the browser.
  const user = ctx?.initData?.user;
  if (!user || !safeId(user.id)) {
    fail('Open the Mini App from Telegram to access your account.', 'UNAUTHORIZED');
  }
  const action = String(input?.action || 'bootstrap');
  if (action === 'bootstrap') return dashboard(user);

  if (action === 'claim') {
    const claim = await claimDaily(user.id);
    return { claim, rewards: {
      dailyCoins: DAILY_COINS,
      dailyChakra: DAILY_CHAKRA,
      bonusCoins: BONUS_COINS,
      bonusChakra: BONUS_CHAKRA,
      sakuraCoins: SAKURA_COINS,
      sakuraChakra: SAKURA_CHAKRA,
    }, dashboard: await dashboard(user) };
  }

  if (action === 'purchase') {
    const name = String(input?.itemName || '').trim();
    // Chakra is multi-buy: each tap buys CHAKRA_MIN units at CHAKRA_RATE coins each.
    if (name.toLowerCase() === 'chakra') {
      const qty = CHAKRA_MIN;
      const cost = qty * CHAKRA_RATE;
      const result = await purchase(user.id, null, {
        type: 'chakra',
        name: 'Chakra',
        qty,
        cost,
      });
      return {
        purchase: result,
        item: { name: 'Chakra', emoji: '⚡', type: 'chakra', price: cost, qty },
        dashboard: await dashboard(user),
      };
    }
    const item = ITEMS.find((candidate) => candidate.name === name);
    if (!item) fail('That item is not available in the Shinobi Store.', 'ITEM_NOT_FOUND');
    const result = await purchase(user.id, null, {
      type: item.type,
      name: item.name,
      qty: 1,
      cost: item.price,
    });
    return { purchase: result, item, dashboard: await dashboard(user) };
  }

  fail('Unknown Mini App action.', 'UNKNOWN_ACTION');
}

export default async function (input, ctx) {
  const rawAction = input?.action;
  const requestedAction = typeof rawAction === 'string'
    ? (rawAction || 'bootstrap')
    : (rawAction == null ? 'bootstrap' : 'unknown');
  const action = MINIAPP_ACTIONS.has(requestedAction) ? requestedAction : 'unknown';
  try {
    return await handleMiniApp(input, ctx);
  } catch (error) {
    if (error instanceof EndpointError) throw error;
    try { console.error(`[miniapp] ${action} runtime exception`, error); } catch (_) {}
    try { await reportMiniAppRuntimeError(error, action, ctx?.initData?.user); } catch (_) {}
    throw error;
  }
}
