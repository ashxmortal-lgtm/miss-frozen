import { db } from 'sdk';
import { and, eq, sql } from 'sdk/db';
import { coupons, couponRedemptions, inventory, topicSettings } from '../schema.js';
import { fmt, SHINOBI } from './store.js';
import { GIFTS } from './gift.js';
import { adjustBalance } from './economy.js';
import { escapeHtml } from './texts.js';
import { OWNER_ID } from './config.js';
import { api } from './message_api.js';

const now = () => Math.floor(Date.now() / 1000);
const SESSION_PREFIX = 'coupon.wizard.';
const TYPES = ['shinobi', 'coins', 'chakra', 'gifts'];
const escape = escapeHtml;
const para = (...text) => ({ type: 'paragraph', text: text.length === 1 ? text[0] : text });
const heading = (text) => ({ type: 'heading', size: 2, text });
const divider = { type: 'divider' };
const button = (text, callback_data, style) => ({ text, callback_data, ...(style ? { style } : {}) });
const row = (...buttons) => ({ type: 'buttons', align: 'center', buttons });
const rich = (blocks) => ({ blocks, skip_entity_detection: true });

async function send(chatId, blocks) {
  return api.sendRichMessage({ chat_id: chatId, rich_message: rich(blocks) });
}
async function render(cq, blocks) {
  try {
    await api.editMessageText({ chat_id: cq.message.chat.id, message_id: cq.message.message_id, rich_message: rich(blocks) });
  } catch (e) {
    try { await send(cq.message.chat.id, blocks); } catch (sendError) { console.error('[coupon wizard render]', sendError?.description || sendError); }
  }
}
async function answer(cq, text = '') {
  try { await api.answerCallbackQuery({ callback_query_id: cq.id, ...(text ? { text } : {}) }); } catch (_) {}
}
function sessionKey(userId) { return `${SESSION_PREFIX}${userId}`; }
async function getSession(userId) {
  const row = await db.select().from(topicSettings).where(eq(topicSettings.settingKey, sessionKey(userId))).get();
  if (!row) return null;
  try { return JSON.parse(row.settingValue); } catch (_) { return null; }
}
async function putSession(userId, session) {
  await db.run(sql`INSERT INTO topic_settings (setting_key, setting_value) VALUES (${sessionKey(userId)}, ${JSON.stringify(session)}) ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value`);
}
async function clearSession(userId) {
  await db.delete(topicSettings).where(eq(topicSettings.settingKey, sessionKey(userId))).run();
}
function codeValue(input) {
  const code = String(input || '').trim().toUpperCase();
  return /^[A-Z0-9_-]{3,18}$/.test(code) ? code : null;
}
function isOwnerPrivate(message) {
  return message?.from?.id === OWNER_ID && message?.chat?.type === 'private';
}
function rewardLabel(type) {
  return ({ shinobi: '🥷 Shinobi', coins: '🍥 Coins', chakra: '⚡ Chakra', gifts: '🎁 Gifts' })[type] || type;
}
function createStartBlocks() {
  return [heading('🎟️ CREATE COUPON'), para('Step 1 of 4 · Choose a code name.'), para('Send a code containing 3–18 letters, numbers, _ or -.'), para('Send /cancel to stop.')];
}
function rewardChoiceBlocks(session) {
  const chosen = new Set(session.selected || []);
  const blocks = [heading(session.mode === 'create' ? '🎁 REWARD TYPES' : '🎁 EDIT REWARDS'), para('Select one or more reward types, then continue.')];
  for (let i = 0; i < TYPES.length; i += 2) {
    blocks.push(row(...TYPES.slice(i, i + 2).map((type) => button(`${chosen.has(type) ? '✅' : '▫️'} ${rewardLabel(type)}`, `cc:toggle:${type}`))));
  }
  blocks.push(row(button('Continue ➜', 'cc:rewards:continue', 'success'), button('Cancel', 'cc:cancel')));
  return blocks;
}
function inputPrompt(session) {
  const type = session.selected[session.rewardIndex];
  const counter = `${session.rewardIndex + 1}/${session.selected.length}`;
  let prompt;
  if (type === 'shinobi') prompt = `Enter the shinobi name and quantity, e.g. Naruto 2. Available: ${SHINOBI.map((s) => s.name).join(', ')}.`;
  else if (type === 'gifts') prompt = `Enter gift name and quantity, e.g. Konan's Rose 2. Available: ${GIFTS.map((g) => g.name).join('; ')}.`;
  else prompt = `Enter the ${type} amount as a positive whole number.`;
  return [heading(`🎁 REWARD ${counter}`), para(prompt), para('Send /cancel to stop.')];
}
function expiryBlocks(session) {
  return [heading('⏳ COUPON EXPIRY'), para('Choose when this coupon expires.'), row(button('Never expires', 'cc:expiry:never', 'success'), button('Custom days', 'cc:expiry:custom', 'primary')), row(button('Cancel', 'cc:cancel'))];
}
function finalizeBlocks(session) {
  const rewards = session.rewards || {};
  const lines = [];
  if (rewards.coins) lines.push(`🍥 Coins: ${fmt(rewards.coins)}`);
  if (rewards.chakra) lines.push(`⚡ Chakra: ${fmt(rewards.chakra)}`);
  for (const name of rewards.shinobis || []) lines.push(`🥷 Shinobi: ${name}`);
  for (const gift of rewards.gifts || []) lines.push(`🎁 Gift: ${gift.name}${gift.qty > 1 ? ` × ${gift.qty}` : ''}`);
  const expiry = session.expiresAt ? new Date(session.expiresAt * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : 'Never';
  return [heading('✅ COUPON READY'), para('Review this coupon before saving.'), divider, para('Code: ', { type: 'bold', text: session.code }), ...lines.map((line) => para(line)), para(`Expiry: ${expiry}`), row(button('✅ Create coupon', 'cc:create:save', 'success'), button('Cancel', 'cc:cancel'))];
}
function editMenuBlocks(session) {
  return [heading(`🎟️ EDIT ${session.code}`), para('Choose what to change.'), row(button('✏️ Rename', 'cc:edit:rename'), button('🎁 Rewards', 'cc:edit:rewards')), row(button('⏳ Expiry', 'cc:edit:expiry'), button('⏯️ Enable / disable', 'cc:edit:toggle')), row(button('🗑️ Delete', 'cc:edit:delete', 'danger'), button('Cancel', 'cc:cancel'))];
}

export async function handleCreateCoupon(message) {
  if (!isOwnerPrivate(message)) {
    if (message.from?.id === OWNER_ID) await send(message.chat.id, [para('For safety, please manage coupons in the bot’s private chat.')]);
    return true;
  }
  await putSession(message.from.id, { mode: 'create', phase: 'code', selected: [], rewards: {} });
  await send(message.chat.id, createStartBlocks());
  return true;
}

export async function handleListCoupons(message) {
  if (message.from?.id !== OWNER_ID) return false;
  const rows = await db.select().from(coupons).all();
  rows.sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
  const blocks = [heading('🎟️ COUPON CODES')];
  if (!rows.length) blocks.push(para('No coupons yet. Use /create_cc to create one.'));
  for (const coupon of rows.slice(0, 20)) {
    let reward = {};
    try { reward = JSON.parse(coupon.rewards || '{}'); } catch (_) {}
    const used = await db.$count(couponRedemptions, eq(couponRedemptions.code, coupon.code));
    const status = coupon.active === 0 ? 'Disabled' : (coupon.expiresAt && coupon.expiresAt < now() ? 'Expired' : 'Active');
    blocks.push(divider, para(`${coupon.code} · ${status} · ${used} redeemed`), para(rewardSummary(reward)));
    blocks.push(row(button(`Edit ${coupon.code}`, `cc:pick:${coupon.code}`)));
  }
  blocks.push(row(button('➕ Create coupon', 'cc:start'), button('Close', 'cc:cancel')));
  await send(message.chat.id, blocks);
  return true;
}
function rewardSummary(reward) {
  const parts = [];
  if (Number(reward.coins) > 0) parts.push(`${fmt(reward.coins)} coins`);
  if (Number(reward.chakra) > 0) parts.push(`${fmt(reward.chakra)} chakra`);
  if (reward.shinobis?.length) parts.push(`${reward.shinobis.join(', ')} shinobi`);
  const gifts = Array.isArray(reward.gifts) ? reward.gifts.map((g) => `${g.name}${g.qty > 1 ? ` × ${g.qty}` : ''}`) : [];
  if (typeof reward.gift === 'string' && reward.gift) gifts.push(reward.gift);
  if (gifts.length) parts.push(gifts.join(', '));
  return parts.length ? parts.join(' · ') : 'No rewards set';
}
export async function handleEditCoupon(message) {
  if (message.from?.id !== OWNER_ID) return false;
  if (message.chat?.type !== 'private') {
    await send(message.chat.id, [para('Please manage coupons in the bot’s private chat.')]);
    return true;
  }
  const rows = await db.select().from(coupons).all();
  if (!rows.length) {
    await send(message.chat.id, [heading('🎟️ EDIT COUPON'), para('No coupons to edit. Use /create_cc first.')]);
    return true;
  }
  const blocks = [heading('🎟️ EDIT COUPON'), para('Select a coupon code.')];
  for (const coupon of rows.slice(0, 30)) blocks.push(row(button(coupon.code, `cc:pick:${coupon.code}`)));
  blocks.push(row(button('Cancel', 'cc:cancel')));
  await send(message.chat.id, blocks);
  return true;
}

function cleanName(input, type) {
  const raw = String(input || '').trim();
  const qtyMatch = raw.match(/\s+(\d+)\s*$/);
  const qty = qtyMatch ? Number(qtyMatch[1]) : 1;
  const label = qtyMatch ? raw.slice(0, qtyMatch.index).trim() : raw;
  if (!Number.isSafeInteger(qty) || qty < 1 || qty > 1000 || !label) return null;
  if (type === 'shinobi') {
    const found = SHINOBI.find((x) => x.name.toLowerCase() === label.toLowerCase());
    return found ? { name: found.name, qty } : null;
  }
  const found = GIFTS.find((x) => x.name.toLowerCase() === label.toLowerCase() || `${x.emoji} ${x.name}`.toLowerCase() === label.toLowerCase());
  return found ? { name: `${found.emoji} ${found.name}`, qty } : null;
}

export async function handleCouponWizardText(message) {
  if (!isOwnerPrivate(message)) return false;
  const session = await getSession(message.from.id);
  if (!session) return false;
  const text = String(message.text || '').trim();
  if (!text) return false;
  if (/^\/cancel(?:@\w+)?$/i.test(text)) {
    await clearSession(message.from.id);
    await send(message.chat.id, [para('Coupon wizard cancelled.')]);
    return true;
  }
  if (text.startsWith('/')) return false;

  if (session.phase === 'code') {
    const code = codeValue(text);
    if (!code) {
      await send(message.chat.id, [para('Use 3–18 characters: A–Z, 0–9, _ or -. Try again, or send /cancel.')]);
      return true;
    }
    if (session.mode === 'create' && await db.select().from(coupons).where(eq(coupons.code, code)).get()) {
      await send(message.chat.id, [para('That code already exists. Choose a different code or use /edit_cc.')]);
      return true;
    }
    session.code = code;
    session.phase = 'rewards';
    await putSession(message.from.id, session);
    await send(message.chat.id, rewardChoiceBlocks(session));
    return true;
  }
  if (session.phase === 'reward_values') {
    const type = session.selected[session.rewardIndex];
    if (type === 'coins' || type === 'chakra') {
      const amount = Number(text.replace(/,/g, ''));
      if (!Number.isSafeInteger(amount) || amount < 1 || amount > 1000000000) {
        await send(message.chat.id, [para('Enter a whole number from 1 to 1,000,000,000.')]);
        return true;
      }
      session.rewards[type] = amount;
    } else {
      const reward = cleanName(text, type);
      if (!reward) {
        const choices = type === 'shinobi' ? SHINOBI.map((x) => x.name) : GIFTS.map((x) => x.name);
        await send(message.chat.id, [para(`I couldn’t match that ${type === 'shinobi' ? 'shinobi' : 'gift'}. Choose one of: ${choices.join(', ')}. You can add a quantity, e.g. “Naruto 2”.`)]);
        return true;
      }
      if (type === 'shinobi') session.rewards.shinobis = [reward.name];
      else session.rewards.gifts = [{ name: reward.name, qty: reward.qty }];
    }
    session.rewardIndex += 1;
    if (session.rewardIndex < session.selected.length) {
      await putSession(message.from.id, session);
      await send(message.chat.id, inputPrompt(session));
    } else if (session.mode === 'edit') {
      session.phase = 'edit_ready';
      await putSession(message.from.id, session);
      await send(message.chat.id, [heading('🎁 REWARDS UPDATED'), para(rewardSummary(session.rewards)), row(button('Save rewards', 'cc:edit:save_rewards', 'success'), button('Cancel', 'cc:cancel'))]);
    } else {
      session.phase = 'expiry';
      await putSession(message.from.id, session);
      await send(message.chat.id, expiryBlocks(session));
    }
    return true;
  }
  if (session.phase === 'expiry_days') {
    const days = Number(text);
    if (!Number.isSafeInteger(days) || days < 1 || days > 36500) {
      await send(message.chat.id, [para('Enter a whole number of days from 1 to 36,500.')]);
      return true;
    }
    session.expiresAt = now() + days * 86400;
    session.phase = session.mode === 'create' ? 'ready' : 'edit_ready';
    await putSession(message.from.id, session);
    await send(message.chat.id, session.mode === 'create' ? finalizeBlocks(session) : [heading('⏳ EXPIRY UPDATED'), para(`${session.code} will expire in ${days} days.`), row(button('Save expiry', 'cc:edit:save_expiry', 'success'), button('Cancel', 'cc:cancel'))]);
    return true;
  }
  if (session.phase === 'rename') {
    const code = codeValue(text);
    if (!code) { await send(message.chat.id, [para('Enter 3–18 characters: A–Z, 0–9, _ or -.')]); return true; }
    if (code !== session.code && await db.select().from(coupons).where(eq(coupons.code, code)).get()) {
      await send(message.chat.id, [para('That code already exists. Choose another name.')]);
      return true;
    }
    const oldCode = session.code;
    const existing = await db.select().from(coupons).where(eq(coupons.code, oldCode)).get();
    if (!existing) { await clearSession(message.from.id); await send(message.chat.id, [para('Coupon not found. Start again with /edit_cc.')]); return true; }
    await db.run(sql`UPDATE coupons SET code = ${code} WHERE code = ${oldCode}`);
    await db.run(sql`UPDATE coupon_redemptions SET code = ${code} WHERE code = ${oldCode}`);
    session.code = code;
    session.phase = 'edit';
    await putSession(message.from.id, session);
    await send(message.chat.id, [para(`Coupon renamed from ${oldCode} to ${code}.`), ...editMenuBlocks(session)]);
    return true;
  }
  return false;
}

export async function handleCouponWizardCallback(cq) {
  const data = String(cq.data || '');
  if (!data.startsWith('cc:')) return false;
  if (cq.from?.id !== OWNER_ID) { await answer(cq, 'Owner only.'); return true; }
  const userId = cq.from.id;
  let session = await getSession(userId);
  if (data === 'cc:cancel') {
    await clearSession(userId); await answer(cq, 'Cancelled');
    if (cq.message) await render(cq, [para('Coupon wizard closed.')]);
    return true;
  }
  if (data === 'cc:start') {
    session = { mode: 'create', phase: 'code', selected: [], rewards: {} };
    await putSession(userId, session); await answer(cq);
    if (cq.message) await render(cq, createStartBlocks());
    return true;
  }
  if (data.startsWith('cc:pick:')) {
    const code = data.slice('cc:pick:'.length);
    const coupon = await db.select().from(coupons).where(eq(coupons.code, code)).get();
    if (!coupon) { await answer(cq, 'Coupon not found'); return true; }
    let rewards = {};
    try { rewards = JSON.parse(coupon.rewards || '{}'); } catch (_) {}
    session = { mode: 'edit', phase: 'edit', code, rewards, selected: [] };
    await putSession(userId, session); await answer(cq);
    if (cq.message) await render(cq, editMenuBlocks(session));
    return true;
  }
  if (!session) { await answer(cq, 'Start with /create_cc or /edit_cc'); return true; }
  if (data.startsWith('cc:toggle:')) {
    const type = data.slice('cc:toggle:'.length);
    if (!TYPES.includes(type)) { await answer(cq); return true; }
    const selected = new Set(session.selected || []);
    selected.has(type) ? selected.delete(type) : selected.add(type);
    session.selected = TYPES.filter((t) => selected.has(t));
    await putSession(userId, session); await answer(cq);
    if (cq.message) await render(cq, rewardChoiceBlocks(session));
    return true;
  }
  if (data === 'cc:rewards:continue') {
    if (!session.selected?.length) { await answer(cq, 'Select at least one reward.'); return true; }
    session.rewards = session.mode === 'edit' ? {} : {};
    session.rewardIndex = 0;
    session.phase = 'reward_values';
    await putSession(userId, session); await answer(cq);
    if (cq.message) await render(cq, inputPrompt(session));
    return true;
  }
  if (data === 'cc:expiry:never') {
    session.expiresAt = 0;
    session.phase = session.mode === 'create' ? 'ready' : 'edit_ready';
    await putSession(userId, session); await answer(cq);
    if (cq.message) await render(cq, session.mode === 'create' ? finalizeBlocks(session) : [heading('⏳ EXPIRY UPDATED'), para(`${session.code} will never expire.`), row(button('Save expiry', 'cc:edit:save_expiry', 'success'), button('Cancel', 'cc:cancel'))]);
    return true;
  }
  if (data === 'cc:expiry:custom') {
    session.phase = 'expiry_days';
    await putSession(userId, session); await answer(cq);
    if (cq.message) await render(cq, [heading('⏳ CUSTOM EXPIRY'), para('Send how many days until expiry (1–36,500).')]);
    return true;
  }
  if (data === 'cc:create:save' && session.mode === 'create' && session.phase === 'ready') {
    const rewards = JSON.stringify(session.rewards || {});
    await db.run(sql`INSERT INTO coupons (code, rewards, expires_at, active, created_at, created_by) VALUES (${session.code}, ${rewards}, ${session.expiresAt || 0}, 1, ${now()}, ${userId}) ON CONFLICT(code) DO UPDATE SET rewards = excluded.rewards, expires_at = excluded.expires_at, active = 1`);
    await clearSession(userId); await answer(cq, 'Coupon created');
    if (cq.message) await render(cq, [heading('🎉 COUPON CREATED'), para(`Code: ${session.code}`), para(rewardSummary(session.rewards)), para(session.expiresAt ? `Expires: ${new Date(session.expiresAt * 1000).toISOString().slice(0, 10)}` : 'Expiry: Never'), para('Users can redeem it with /redeem CODE.')]);
    return true;
  }
  if (data === 'cc:edit:rename' && session.mode === 'edit') {
    session.phase = 'rename'; await putSession(userId, session); await answer(cq);
    if (cq.message) await render(cq, [heading('✏️ RENAME COUPON'), para('Send the new code name (3–18 letters, numbers, _ or -).')]);
    return true;
  }
  if (data === 'cc:edit:rewards' && session.mode === 'edit') {
    session.selected = [];
    await putSession(userId, session); await answer(cq);
    if (cq.message) await render(cq, rewardChoiceBlocks(session));
    return true;
  }
  if (data === 'cc:edit:expiry' && session.mode === 'edit') {
    session.phase = 'expiry'; await putSession(userId, session); await answer(cq);
    if (cq.message) await render(cq, expiryBlocks(session));
    return true;
  }
  if (data === 'cc:edit:save_expiry' && session.mode === 'edit' && session.phase === 'edit_ready') {
    await db.update(coupons).set({ expiresAt: session.expiresAt || 0 }).where(eq(coupons.code, session.code)).run();
    session.phase = 'edit'; await putSession(userId, session); await answer(cq, 'Expiry saved');
    if (cq.message) await render(cq, editMenuBlocks(session));
    return true;
  }
  if (data === 'cc:edit:toggle' && session.mode === 'edit') {
    const coupon = await db.select().from(coupons).where(eq(coupons.code, session.code)).get();
    if (coupon) await db.update(coupons).set({ active: coupon.active ? 0 : 1 }).where(eq(coupons.code, session.code)).run();
    await answer(cq, 'Updated'); if (cq.message) await render(cq, editMenuBlocks(session)); return true;
  }
  if (data === 'cc:edit:delete' && session.mode === 'edit') {
    await db.delete(coupons).where(eq(coupons.code, session.code)).run();
    await db.delete(couponRedemptions).where(eq(couponRedemptions.code, session.code)).run();
    await clearSession(userId); await answer(cq, 'Deleted');
    if (cq.message) await render(cq, [para(`Coupon ${session.code} deleted.`)]);
    return true;
  }
  if (data === 'cc:edit:save_rewards' && session.mode === 'edit' && session.phase === 'edit_ready') {
    await db.update(coupons).set({ rewards: JSON.stringify(session.rewards || {}) }).where(eq(coupons.code, session.code)).run();
    session.phase = 'edit'; await putSession(userId, session); await answer(cq, 'Rewards saved');
    if (cq.message) await render(cq, editMenuBlocks(session)); return true;
  }
  await answer(cq);
  return true;
}

export async function handleRedeemCoupon(message, text) {
  const user = message.from;
  const args = String(text || '').trim().split(/\s+/).slice(1);
  if (!args.length) { await api.sendMessage({ chat_id: message.chat.id, text: 'Usage: /redeem <code>\nExample: /redeem GIFT100' }); return true; }
  const code = codeValue(args[0]);
  if (!code) { await api.sendMessage({ chat_id: message.chat.id, text: 'That coupon code is not valid.' }); return true; }
  const coupon = await db.select().from(coupons).where(eq(coupons.code, code)).get();
  if (!coupon) { await api.sendMessage({ chat_id: message.chat.id, text: `❌ Invalid coupon code: ${code}` }); return true; }
  const t = now();
  if (!coupon.active) { await api.sendMessage({ chat_id: message.chat.id, text: '❌ This coupon is inactive or disabled.' }); return true; }
  if (coupon.expiresAt > 0 && coupon.expiresAt < t) { await api.sendMessage({ chat_id: message.chat.id, text: '❌ This coupon has expired.' }); return true; }
  let reward = {};
  try { reward = JSON.parse(coupon.rewards || '{}'); } catch (_) {}
  const inserted = await db.run(sql`INSERT INTO coupon_redemptions (code, telegram_id, redeemed_at) VALUES (${code}, ${user.id}, ${t}) ON CONFLICT(code, telegram_id) DO NOTHING`);
  if (!inserted.rowsAffected) { await api.sendMessage({ chat_id: message.chat.id, text: `❌ You have already redeemed coupon ${code}.` }); return true; }
  try {
    if (Number(reward.coins) > 0) await adjustBalance(user.id, Number(reward.coins));
    const chakra = Number(reward.chakra) || 0;
    if (chakra > 0) await addInventory(user.id, 'chakra', 'Chakra', chakra);
    for (const name of (Array.isArray(reward.shinobis) ? reward.shinobis : [])) await addInventory(user.id, 'shinobi', name, 1);
    const gifts = Array.isArray(reward.gifts) ? reward.gifts : (reward.gift ? [{ name: reward.gift, qty: 1 }] : []);
    for (const gift of gifts) await addInventory(user.id, 'gift', gift.name, Math.max(1, Number(gift.qty) || 1));
  } catch (e) {
    // Allow retry if an inventory or balance update failed before the grant completed.
    await db.delete(couponRedemptions).where(and(eq(couponRedemptions.code, code), eq(couponRedemptions.telegramId, user.id))).run().catch(() => {});
    throw e;
  }
  const rewardText = rewardSummary(reward);
  await api.sendMessage({ chat_id: message.chat.id, text: `🎉 Coupon redeemed!\n\n${escape(rewardText)}\n\nUse /balance or /inventory to check your rewards.` });
  return true;
}
async function addInventory(telegramId, itemType, itemName, qty) {
  await db.run(sql`INSERT INTO inventory (telegram_id, item_type, item_name, qty) VALUES (${telegramId}, ${itemType}, ${itemName}, ${qty}) ON CONFLICT(telegram_id, item_name) DO UPDATE SET qty = qty + excluded.qty`);
}
