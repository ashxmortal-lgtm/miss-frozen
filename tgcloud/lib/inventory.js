/**
 * /inventory — full shinobi status table.
 * Shows every owned shinobi (not just the equipped one) with their live,
 * timestamp-derived status, plus chakra and balance.
 */

import { db } from 'sdk';
import { api } from './message_api.js';
import { eq } from 'sdk/db';
import { users, inventory } from '../schema.js';
import { style, escapeHtml } from './texts.js';
import { fmt } from './store.js';
import { table } from './rich.js';
import { collectStatus, statusParts } from './rpg/status.js';
import { sakuraHeal, katsuyuHeal, restorableTimers, katsuyuRestore } from './rpg/training.js';
import { dueText } from './rpg/time.js';
import { getEquippedList } from './rpg/state.js';

const para = (...t) => ({ type: 'paragraph', text: t.length === 1 ? t[0] : t });
const head = (text, size = 2) => ({ type: 'heading', text, size });
const row = (...buttons) => ({ type: 'buttons', buttons, align: 'center' });
const cb = (text, data, style) => (style ? { text, callback_data: data, style } : { text, callback_data: data });
const rich = (blocks) => ({ blocks });
const mention = (u) => ({
  type: 'text_mention',
  text: (u && (u.first_name || u.firstName)) || 'User',
  user: {
    id: u.id || u.telegramId,
    is_bot: false,
    first_name: (u && (u.first_name || u.firstName)) || 'User',
    last_name: u && u.last_name,
    username: u && u.username,
  },
});

const JUTSU_HINTS = ['jutsu', 'mind transmission', 'byakugan', 'rasengan', 'chidori'];

function isJutsu(item) {
  const n = String(item.itemName || '').toLowerCase();
  const t = String(item.itemType || '').toLowerCase();
  if (t === 'jutsu') return true;
  return JUTSU_HINTS.some((h) => n.includes(h));
}

function isShinobi(item) {
  const t = String(item.itemType || '').toLowerCase();
  if (t === 'chakra') return false;
  if (String(item.itemName || '').toLowerCase() === 'chakra') return false;
  if (t === 'shinobi' || t === 'character') return true;
  return false;
}

function quoteLines(lines) {
  return {
    type: 'blockquote',
    blocks: lines.map((l) => para(l)),
  };
}

export async function buildInventoryBlocks(user) {
  const uid = user.id || user.telegramId;
  const rowU = await db.select().from(users).where(eq(users.telegramId, uid)).get();
  const items = await db.select().from(inventory).where(eq(inventory.telegramId, uid)).all();

  const shinobi = items.filter((i) => isShinobi(i) && !isJutsu(i));
  // Chakra is stored in the inventory as the 'Chakra' item.
  const chakraItem = items.find((i) => i.itemName === 'Chakra');
  const chakra = chakraItem ? chakraItem.qty : 0;
  const balance = rowU?.balance ?? 0;

  // Live, persisted status for every owned shinobi (Inventory rule #2).
  const blocks = [
    para(mention(user), "'s INVENTORY"),
    head('⚔️ SHINOBI STATUS'),
  ];
  if (shinobi.length) {
    const status = await collectStatus(uid);
    const byName = Object.fromEntries(status.rows.map((r) => [r.name, r]));
    const deadRows = status.rows.filter((r) => r.primary?.key === 'dead' && r.name !== 'Starter Shinobi');
    // Overall player status above the table
    if (deadRows.length) {
      const reviveAt = Math.max(...deadRows.map((r) => Number(r.primary.dueAt) || 0));
      blocks.push(para(`Status: ☠️ dead (${dueText(reviveAt, status.now)})`));
    } else {
      blocks.push(para('Status: ✅ alive'));
    }
    const tableRows = [['Name', 'Status', 'Returns']];
    for (const s of shinobi) {
      const part = byName[s.itemName]
        ? statusParts(byName[s.itemName])
        : { name: s.itemName, status: 'ready', returns: '—' };
      tableRows.push([part.name, part.status, part.returns]);
    }
    blocks.push(table(tableRows));
  } else {
    blocks.push(quoteLines(['❯ (no shinobi yet — recruit at /shinobi_store)']));
  }

  blocks.push(para(`⚡ CHAKRA: ${Number(chakra).toLocaleString('en-US')}`));
  blocks.push(para(`🍥 BALANCE: ${Number(balance).toLocaleString('en-US')}`));
  // Equipped shinobi (max 3) — active skills only apply when equipped
  try {
    const eqList = await getEquippedList(uid);
    if (eqList.length) {
      blocks.push(quoteLines([`👤 EQUIPPED (${eqList.length}/3): ${eqList.join(', ')}`]));
    } else {
      blocks.push(quoteLines(['👤 EQUIPPED: none — use /equip &lt;name&gt;']));
    }
  } catch (_) {
    blocks.push(para('👤 EQUIPPED: —'));
  }
  blocks.push(para(style('❄️ Your shinobi are making progress! Return when their timers finish and continue your journey.')));
  blocks.push(row(
    cb("🌸 Sakura's Healing", 'inv:sakura', 'success'),
    cb("🐌 Katsuyu's Healing", 'inv:katsuyu', 'success'),
  ));
  blocks.push(row(
    cb('🌀 Jutsu', 'inv:jutsu', 'transparent'),
    cb('owned ❄️ gifts', 'inv:gifts', 'transparent'),
  ));
  return blocks;
}

export async function buildOwnedGiftsBlocks(user) {
  const uid = user.id || user.telegramId;
  const items = await db.select().from(inventory).where(eq(inventory.telegramId, uid)).all();
  const gifts = items.filter((i) => String(i.itemType || '').toLowerCase() === 'gift');
  const lines = gifts.length
    ? gifts.map((g) => {
        const q = g.qty && g.qty > 1 ? ` x ${g.qty}` : '';
        return `❯ ${escapeHtml(g.itemName)}${q}`;
      })
    : ['❯ No gifts owned yet'];
  return [
    para(mention(user), "'s GIFTS"),
    quoteLines(lines),
    row(cb('← Back', 'inv:home', 'transparent')),
  ];
}

export async function buildJutsuBlocks(user) {
  const uid = user.id || user.telegramId;
  const items = await db.select().from(inventory).where(eq(inventory.telegramId, uid)).all();
  const jutsu = items.filter(isJutsu);
  const lines = jutsu.length
    ? jutsu.map((j) => {
        const q = j.qty && j.qty > 1 ? ` x ${j.qty}` : '';
        return `❯ ${escapeHtml(j.itemName)}${q}`;
      })
    : ['❯ No jutsu unlocked yet'];

  return [
    para(mention(user), "'s JUTSU"),
    quoteLines(lines),
    row(cb('← Back', 'inv:home', 'transparent')),
  ];
}

/** Plain text fallback (old inventoryText API) */
export async function inventoryText(userId) {
  const rowU = await db.select().from(users).where(eq(users.telegramId, userId)).get();
  const items = await db.select().from(inventory).where(eq(inventory.telegramId, userId)).all();
  const shinobi = items.filter((i) => isShinobi(i) && !isJutsu(i));
  const chakraItem = items.find((i) => i.itemName === 'Chakra');
  const chakra = chakraItem ? chakraItem.qty : 0;
  const lines = shinobi.length
    ? shinobi.map((s) => `❯ ${escapeHtml(s.itemName)}${s.qty > 1 ? ` x ${s.qty}` : ''}`)
    : ['❯ (empty)'];
  return (
    `INVENTORY\n\n⚔️ SHINOBI\n${lines.join('\n')}\n\n` +
    `⚡ CHAKRA: ${chakra}\n🍥 BALANCE: ${rowU?.balance ?? 0}`
  );
}

export async function sendInventory(chatId, user) {
  const blocks = await buildInventoryBlocks(user);
  try {
    await api.sendRichMessage({ chat_id: chatId, rich_message: rich(blocks) });
  } catch (e) {
    console.error('inventory rich failed:', e?.description || e);
    await api.sendMessage({
      chat_id: chatId,
      text: await inventoryText(user.id),
      reply_markup: {
        inline_keyboard: [[{ text: '🌀 Jutsu', callback_data: 'inv:jutsu', style: 'transparent' }]],
      },
    });
  }
}

function sakuraAlert(r) {
  if (r.code === 'ok') {
    const parts = [];
    if (r.revived && r.revived.length) parts.push(`Revived: ${r.revived.join(', ')}.`);
    if (r.exhaustedCleared && r.exhaustedCleared.length) parts.push(`Exhaustion cleared: ${r.exhaustedCleared.join(', ')}.`);
    if (r.cooldownsCleared && r.cooldownsCleared.length) parts.push(`Mission cooldown reset: ${r.cooldownsCleared.join(', ')}.`);
    if (r.katsuyuUnlocked) parts.push("Katsuyu's Healing is unlocked.");
    return `Sakura's Healing used. ${parts.join(' ')}`.trim();
  }
  if (r.code === 'locked') return `Sakura's Healing unlocks at Lv. 4 (now Lv. ${r.level}).`;
  if (r.code === 'cooldown') return `On cooldown until ${dueText(r.until)}.`;
  if (r.code === 'nothing') return 'Nothing to heal — no dead or exhausted shinobi and no mission cooldown.';
  if (r.code === 'not_owned') return 'Sakura is not on your roster.';
  return 'Could not use Sakura\'s Healing.';
}

function katsuyuAlert(r) {
  if (r.code === 'ok') {
    const revived = r.revived ? ` Revived ${r.revived}.` : '';
    return `+${r.chakra} chakra.${revived}`;
  }
  if (r.code === 'locked') return "Katsuyu's Healing unlocks after 3 Sakura heals.";
  if (r.code === 'cooldown') return `On cooldown until ${dueText(r.until)}.`;
  return "Could not use Katsuyu's Healing.";
}

async function buildRestoreBlocks(user, result, timers) {
  const lines = [`+${result.chakra} chakra added.`];
  if (result.revived) lines.push(`${result.revived} revived with 24h protection.`);
  lines.push('Choose one timer to restore:');
  const buttons = timers.map((t) => cb(
    `${t.kind === 'exhaustion' ? '🔥' : '⏳'} ${t.shinobi}`,
    `inv:kr:${t.kind}:${t.shinobi}:${result.healKey}`,
    'transparent',
  ));
  const rows = [];
  for (let i = 0; i < buttons.length; i += 2) rows.push(row(...buttons.slice(i, i + 2)));
  return [
    para(mention(user), "'s HEALING"),
    head("🐌 KATSUYU'S HEALING", 6),
    quoteLines(lines),
    ...rows,
    row(cb('← Back', 'inv:home', 'danger')),
  ];
}

export async function handleInventoryCallback(cq) {
  const data = cq.data || '';
  if (!data.startsWith('inv:')) return false;
  if (!cq.message) {
    await api.answerCallbackQuery({ callback_query_id: cq.id });
    return true;
  }

  try {
    if (data === 'inv:sakura') {
      const r = await sakuraHeal(cq.from.id);
      await api.answerCallbackQuery({
        callback_query_id: cq.id, text: sakuraAlert(r), show_alert: true,
      });
      const blocks = await buildInventoryBlocks(cq.from);
      await api.editMessageText({
        chat_id: cq.message.chat.id,
        message_id: cq.message.message_id,
        rich_message: rich(blocks),
      });
      return true;
    }

    if (data === 'inv:katsuyu') {
      const r = await katsuyuHeal(cq.from.id);
      if (r.code !== 'ok') {
        await api.answerCallbackQuery({
          callback_query_id: cq.id, text: katsuyuAlert(r), show_alert: true,
        });
        return true;
      }
      const timers = await restorableTimers(cq.from.id);
      await api.answerCallbackQuery({
        callback_query_id: cq.id, text: katsuyuAlert(r), show_alert: true,
      });
      const blocks = timers.length
        ? await buildRestoreBlocks(cq.from, r, timers)
        : await buildInventoryBlocks(cq.from);
      await api.editMessageText({
        chat_id: cq.message.chat.id,
        message_id: cq.message.message_id,
        rich_message: rich(blocks),
      });
      return true;
    }

    if (data.startsWith('inv:kr:')) {
      const [, , kind, shinobi, healKey] = data.split(':');
      const r = await katsuyuRestore(cq.from.id, kind, shinobi, healKey);
      const text = r.code === 'ok'
        ? `${shinobi} ${kind === 'exhaustion' ? 'exhaustion' : 'cooldown'} cleared.`
        : r.code === 'duplicate'
          ? 'This heal already restored a timer.'
          : 'That timer is already gone.';
      await api.answerCallbackQuery({ callback_query_id: cq.id, text, show_alert: true });
      const blocks = await buildInventoryBlocks(cq.from);
      await api.editMessageText({
        chat_id: cq.message.chat.id,
        message_id: cq.message.message_id,
        rich_message: rich(blocks),
      });
      return true;
    }

    await api.answerCallbackQuery({ callback_query_id: cq.id });
    let blocks;
    if (data === 'inv:jutsu') blocks = await buildJutsuBlocks(cq.from);
    else if (data === 'inv:gifts') blocks = await buildOwnedGiftsBlocks(cq.from);
    else blocks = await buildInventoryBlocks(cq.from);
    await api.editMessageText({
      chat_id: cq.message.chat.id,
      message_id: cq.message.message_id,
      rich_message: rich(blocks),
    });
  } catch (e) {
    console.error('inv callback failed:', e?.description || e);
    try { await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'Could not use that.', show_alert: true }); } catch (_) {}
  }
  return true;
}
