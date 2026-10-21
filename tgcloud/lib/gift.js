import { db } from 'sdk';
import { api } from './message_api.js';
import { eq, and } from 'sdk/db';
import { users, inventory } from '../schema.js';

export const GIFTS = [
  { id: 1,  emoji: '🌹', name: "Konan's Rose",            price: 100  },
  { id: 2,  emoji: '🍜', name: 'Ichiraku Ramen',          price: 150  },
  { id: 3,  emoji: '🥜', name: "Anya's Peanuts",          price: 200  },
  { id: 4,  emoji: '🐕', name: "Akamaru (Kiba's Puppy)",  price: 250  },
  { id: 5,  emoji: '🦋', name: "Konan's Paper Butterfly", price: 400  },
  { id: 6,  emoji: '👒', name: 'Straw Hat',               price: 600  },
  { id: 7,  emoji: '🌀', name: 'Rasengan',                price: 700  },
  { id: 8,  emoji: '⚡', name: 'Chidori',                 price: 800  },
  { id: 9,  emoji: '💍', name: 'Akatsuki Ring',           price: 1000 },
  { id: 10, emoji: '👁️', name: 'Sharingan',               price: 1200 },
  { id: 11, emoji: '⭐', name: 'Starlight Anya',          price: 1800 },
  { id: 12, emoji: '⚔️', name: "Zoro's Swords",           price: 3000 },
];
const byId = Object.fromEntries(GIFTS.map((g) => [g.id, g]));
const giftNames = new Set(GIFTS.map((g) => `${g.emoji} ${g.name}`));

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const para = (...t) => ({ type: 'paragraph', text: t.length === 1 ? t[0] : t });
const head = (text) => ({ type: 'heading', text, size: 2 });
const divider = { type: 'divider' };
const row = (...buttons) => ({ type: 'buttons', buttons, align: 'center' });
const cb = (text, data, style) => (style ? { text, callback_data: data, style } : { text, callback_data: data });
const rich = (blocks) => ({ blocks });

export function catalogBlocks() {
  return [
    {
      type: 'heading',
      size: 1,
      text: "WELCOME TO INO'S GIFT STORE",
    },
    {
      type: 'details',
      summary: '🎁 Gift list',
      blocks: [
        { type: 'paragraph', text: "1. 🌹 Konan's Rose — 100 🍥" },
        { type: 'paragraph', text: '2. 🍜 Ichiraku Ramen — 150 🍥' },
        { type: 'paragraph', text: "3. 🥜 Anya's Peanuts — 200 🍥" },
        { type: 'paragraph', text: "4. 🐕 Akamaru (Kiba's Puppy) — 250 🍥" },
        { type: 'paragraph', text: "5. 🦋 Konan's Paper Butterfly — 400 🍥" },
        { type: 'paragraph', text: '6. 👒 Straw Hat — 600 🍥' },
        { type: 'paragraph', text: '7. 🌀 Rasengan — 700 🍥' },
        { type: 'paragraph', text: '8. ⚡ Chidori — 800 🍥' },
        { type: 'paragraph', text: '9. 💍 Akatsuki Ring — 1,000 🍥' },
        { type: 'paragraph', text: '10. 👁️ Sharingan — 1,200 🍥' },
        { type: 'paragraph', text: '11. ⭐ Starlight Anya — 1,800 🍥' },
        { type: 'paragraph', text: "12. ⚔️ Zoro's Swords — 3,000 🍥" },
      ],
    },
    { type: 'divider' },
    {
      type: 'heading',
      size: 4,
      text: '🛍️ How to send a gift',
    },
    {
      type: 'blockquote',
      blocks: [
        { type: 'paragraph', text: "Reply to a user's message, then send:" },
        { type: 'paragraph', text: '/gift number' },
      ],
    },
    row(cb('🎁 My gifts', 'gift:mine', 'primary')),
  ];
}

function catalogPlain() {
  return [
    "🌸 Welcome to Ino's Gift Store 💐",
    '',
    '🎁 Gift list',
    ...GIFTS.map((g) => `${g.id}. ${g.emoji} ${g.name} — ${g.price.toLocaleString('en-US')} 🍥`),
    '',
    '🛍️ How to send a gift',
    "Reply to a user's message, then send:",
    '/gift number',
  ].join('\n');
}

export async function showCatalog(chatId) {
  try {
    await api.sendRichMessage({ chat_id: chatId, rich_message: rich(catalogBlocks()) });
  } catch (e) {
    console.error('gift_store rich failed:', e?.description || e);
    // retry without details (some runtimes reject details)
    try {
      const flat = [
        head("🌸 Welcome to Ino's Gift Store 💐"),
        ...GIFTS.map((g) => para(`${g.id}. ${g.emoji} ${g.name} — ${g.price.toLocaleString('en-US')} 🍥`)),
        divider,
        head('🛍️ How to send a gift'),
        {
          type: 'blockquote',
          blocks: [
            para("Reply to a user's message, then send:"),
            para('/gift number'),
          ],
        },
        row(cb('🎁 My gifts', 'gift:mine', 'primary')),
      ];
      await api.sendRichMessage({ chat_id: chatId, rich_message: rich(flat) });
    } catch (e2) {
      console.error('gift_store flat rich failed:', e2?.description || e2);
      await api.sendMessage({
        chat_id: chatId,
        text: catalogPlain(),
        reply_markup: {
          inline_keyboard: [[{ text: '🎁 My gifts', callback_data: 'gift:mine' }]],
        },
      });
    }
  }
}

async function myGiftsBlocks(userId) {
  const rows = await db.select().from(inventory).where(eq(inventory.telegramId, userId)).all();
  const gifts = rows.filter((r) => r.itemType === 'gift' || giftNames.has(r.itemName));
  const blocks = [
    head('🎁 My gifts'),
  ];
  if (!gifts.length) {
    blocks.push(para('You have not received any gifts yet.'));
  } else {
    for (const g of gifts) {
      const q = g.qty || 1;
      const line = q > 1 ? `${g.itemName} x ${q}` : g.itemName;
      blocks.push(para(line));
    }
  }
  blocks.push(divider);
  blocks.push(row(cb('← Back', 'gift:store', 'primary')));
  return blocks;
}

export async function handleGiftCallback(cq) {
  const data = cq.data || '';
  if (!data.startsWith('gift:')) return false;
  await api.answerCallbackQuery({ callback_query_id: cq.id });
  if (!cq.message) return true;

  try {
    if (data === 'gift:mine') {
      const blocks = await myGiftsBlocks(cq.from.id);
      await api.editMessageText({
        chat_id: cq.message.chat.id,
        message_id: cq.message.message_id,
        rich_message: rich(blocks),
      });
    } else if (data === 'gift:store') {
      await api.editMessageText({
        chat_id: cq.message.chat.id,
        message_id: cq.message.message_id,
        rich_message: rich(catalogBlocks()),
      });
    }
  } catch (e) {
    console.error('gift callback failed:', e?.description || e);
    if (data === 'gift:mine') {
      try {
        await api.sendRichMessage({
          chat_id: cq.from.id,
          rich_message: rich(await myGiftsBlocks(cq.from.id)),
        });
      } catch (_) {}
    }
  }
  return true;
}

async function getBalance(uid) {
  const u = await db.select().from(users).where(eq(users.telegramId, uid)).get();
  return u ? u.balance : 0;
}

async function deduct(uid, amount) {
  const u = await db.select().from(users).where(eq(users.telegramId, uid)).get();
  if (!u || u.balance < amount) return false;
  await db.update(users).set({ balance: u.balance - amount }).where(eq(users.telegramId, uid)).run();
  return true;
}

async function addGiftToInventory(uid, gift) {
  const itemName = `${gift.emoji} ${gift.name}`;
  const existing = await db.select().from(inventory)
    .where(and(eq(inventory.telegramId, uid), eq(inventory.itemName, itemName))).get();
  if (existing) {
    await db.update(inventory)
      .set({ qty: (existing.qty || 1) + 1 })
      .where(eq(inventory.id, existing.id)).run();
    return (existing.qty || 1) + 1;
  }
  await db.insert(inventory).values({
    telegramId: uid, itemType: 'gift', itemName, qty: 1,
  }).run();
  return 1;
}

export async function handleGiftCommand(message) {
  const text = message.text || '';
  if (!text.startsWith('/')) return false;
  const head0 = text.split(/\s+/)[0];
  const [rawCmd, atBot] = head0.slice(1).split('@');
  const cmd = rawCmd.toLowerCase();
  if (cmd !== 'gift' && cmd !== 'gift_store') return false;
  if (atBot) {
    try {
      const me = await api.getMe();
      if (atBot.toLowerCase() !== String(me.username || '').toLowerCase()) return true;
    } catch (_) {}
  }

  const from = message.from;
  if (!from || from.is_bot) return true;

  if (cmd === 'gift_store') {
    await showCatalog(message.chat.id);
    return true;
  }

  const rest = text.replace(/^\/gift(@\w+)?\s*/i, '').trim();
  if (!rest) {
    await showCatalog(message.chat.id);
    return true;
  }

  const mNum = rest.match(/^(\d+)\s*$/);
  if (!mNum) {
    await api.sendMessage({
      chat_id: message.chat.id,
      text: "⚠️ Reply to a user's message and send: /gift <number>\nCatalog: /gift_store",
      reply_parameters: { message_id: message.message_id },
    });
    return true;
  }
  const giftId = Number(mNum[1]);
  const rt = message.reply_to_message;
  if (!rt?.from || rt.from.is_bot) {
    await api.sendMessage({
      chat_id: message.chat.id,
      text: "⚠️ Reply to a user's message, then send /gift <number>\nCatalog: /gift_store",
      reply_parameters: { message_id: message.message_id },
    });
    return true;
  }
  const targetUser = rt.from;

  const gift = byId[giftId];
  if (!gift) {
    await api.sendMessage({
      chat_id: message.chat.id,
      text: `⚠️ Invalid gift id. See /gift_store (1–${GIFTS.length}).`,
      reply_parameters: { message_id: message.message_id },
    });
    return true;
  }
  if (targetUser.id === from.id) {
    await api.sendMessage({
      chat_id: message.chat.id,
      text: '⚠️ You cannot gift yourself.',
      reply_parameters: { message_id: message.message_id },
    });
    return true;
  }

  const bal = await getBalance(from.id);
  if (bal < gift.price) {
    await api.sendMessage({
      chat_id: message.chat.id,
      text: `❌ Not enough coins. Need ${gift.price} 🍥 · You have ${bal} 🍥`,
      reply_parameters: { message_id: message.message_id },
    });
    return true;
  }
  if (!(await deduct(from.id, gift.price))) {
    await api.sendMessage({ chat_id: message.chat.id, text: '❌ Payment failed.' });
    return true;
  }

  const qty = await addGiftToInventory(targetUser.id, gift);
  const label = qty > 1 ? `${gift.emoji} ${gift.name} x ${qty}` : `${gift.emoji} ${gift.name}`;
  const fromName = from.first_name || 'Someone';
  const toName = targetUser.first_name || 'User';

  try {
    await api.sendMessage({
      chat_id: message.chat.id,
      text:
        `🎁 <a href="tg://user?id=${from.id}">${esc(fromName)}</a> sent ` +
        `<b>${esc(gift.emoji + ' ' + gift.name)}</b> to ` +
        `<a href="tg://user?id=${targetUser.id}">${esc(toName)}</a>!\n` +
        `Inventory: <b>${esc(label)}</b>`,
      parse_mode: 'HTML',
    });
  } catch (_) {
    await api.sendMessage({
      chat_id: message.chat.id,
      text: `🎁 ${fromName} sent ${gift.emoji} ${gift.name} to ${toName}! (${label})`,
    });
  }
  try {
    await api.sendMessage({
      chat_id: targetUser.id,
      text:
        `🎁 You received <b>${esc(gift.emoji + ' ' + gift.name)}</b> from ` +
        `<a href="tg://user?id=${from.id}">${esc(fromName)}</a>!\n` +
        `You now have: <b>${esc(label)}</b>`,
      parse_mode: 'HTML',
    });
  } catch (_) {}
  return true;
}
