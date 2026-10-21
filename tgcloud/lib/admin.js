import { db } from 'sdk';
import { eq } from 'sdk/db';
import { users } from '../schema.js';
import { getBalance } from './economy.js';
import { mention } from './texts.js';
import { fmt } from './store.js';
export { OWNER_ID } from './config.js';


// Remember each user's @username so the owner can target them by name.
export async function touchUser(user) {
  await db.run('INSERT OR IGNORE INTO users (telegram_id, balance) VALUES (:id, 0)', { ':id': user.id });
  await db.run('UPDATE users SET username = :u WHERE telegram_id = :id',
    { ':u': user.username ? user.username.toLowerCase() : null, ':id': user.id });
}

const USAGE =
  `Use one of these:\n` +
  `Reply to a user: /addcoins 500\n` +
  `By ID: /addcoins 123456789 500\n` +
  `By username: /addcoins @name 500`;

// Returns the message body to send.
export async function addCoins(message, text) {
  const args = text.trim().split(/\s+/).slice(1);
  const replied = message.reply_to_message?.from;
  let targetId = null;
  let targetName = 'User';
  let amountRaw;

  if (replied && args.length === 1) {
    if (replied.is_bot) return `❌ Can't add coins to a bot.`;
    targetId = replied.id;
    targetName = replied.first_name;
    amountRaw = args[0];
  } else if (args.length === 2) {
    const t = args[0];
    amountRaw = args[1];
    if (/^\d{1,15}$/.test(t)) {
      targetId = Number(t);
    } else if (/^@?[A-Za-z0-9_]{3,32}$/.test(t)) {
      const row = await db.select().from(users)
        .where(eq(users.username, t.replace('@', '').toLowerCase())).get();
      if (!row) {
        return `❌ User not found. They must use the bot once first, or use their ID.`;
      }
      targetId = row.telegramId;
    }
  }

  if (targetId === null) return `❌ Wrong format.\n\n${USAGE}`;
  if (!/^\d{1,9}$/.test(amountRaw) || Number(amountRaw) === 0) {
    return `❌ Amount must be a whole number from 1 to 999999999.\n\n${USAGE}`;
  }
  const amount = Number(amountRaw);

  await db.run('INSERT OR IGNORE INTO users (telegram_id, balance) VALUES (:id, 0)', { ':id': targetId });
  await db.run('UPDATE users SET balance = balance + :a WHERE telegram_id = :id',
    { ':a': amount, ':id': targetId });
  const balance = await getBalance(targetId);

  return `✅ 𝐊𝐎𝐍𝐎𝐇𝐀 𝐂𝐎𝐈𝐍𝐒 𝐀𝐃𝐃𝐄𝐃\n\n` +
    `User: ${mention({ id: targetId, first_name: targetName })}\n` +
    `Added: ${fmt(amount)} 🍥\n` +
    `Balance: ${fmt(balance)} 🍥`;
}
