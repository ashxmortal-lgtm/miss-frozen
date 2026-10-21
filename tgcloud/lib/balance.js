import { db } from 'sdk';
import { sql } from 'sdk/db';
import { fmt } from './store.js';
import { mention } from './texts.js';
import { rankOf } from './activities.js';
import { pendingRewardTotal } from './map/pending.js';

const isGroup = (chat) => chat.type === 'group' || chat.type === 'supergroup';

export async function trackGroup(message) {
  if (!isGroup(message.chat)) return;
  await db.run(sql`
    INSERT OR IGNORE INTO group_members (chat_id, telegram_id)
    VALUES (${message.chat.id}, ${message.from.id})
  `);
}

export async function balanceText(message) {
  const user = message.from;
  const u = await db.get(sql`
    SELECT balance, xp, kills FROM users WHERE telegram_id = ${user.id}
  `);
  const bal = u ? u.balance : 0;
  const xp = u ? u.xp : 0;
  const kills = u && u.kills != null ? u.kills : 0;
  const c = await db.get(sql`
    SELECT qty FROM inventory
    WHERE telegram_id = ${user.id} AND item_name = 'Chakra'
  `);
  const chakra = c ? c.qty : 0;

  let rank = '';
  if (isGroup(message.chat)) {
    const r = await db.get(sql`
      SELECT COUNT(*) AS n
      FROM group_members g
      JOIN users u ON u.telegram_id = g.telegram_id
      WHERE g.chat_id = ${message.chat.id} AND u.balance > ${bal}
    `);
    rank = `  #${(r ? r.n : 0) + 1}`;
  }

  let pending = 0;
  try {
    pending = await pendingRewardTotal(user.id);
  } catch (_) {}

  const pendingLine =
    pending > 0
      ? `\n⏳ Pending rewards: ${fmt(pending)} 🍥\n→ Claim at Hokage Office: /map`
      : '';

  return (
    `🥷🏻 ${mention(user)}\n` +
    `🍥 Coins: ${fmt(bal)}${rank}\n` +
    `🔪 Kills: ${fmt(kills)}\n` +
    `🥷🏻 Shinobi Rank: ${rankOf(xp)[1]}\n` +
    `⚡ Chakra: ${fmt(chakra)}` +
    pendingLine
  );
}
