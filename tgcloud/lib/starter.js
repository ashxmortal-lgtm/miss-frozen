import { db } from 'sdk';
import { sql } from 'sdk/db';

export const STARTER_NOTICE =
  `🎁 𝐒𝐓𝐀𝐑𝐓𝐄𝐑 𝐒𝐇𝐈𝐍𝐎𝐁𝐈\n\nStarter Shinobi joined your roster for free.\nUse /patrol to send it out.`;

// Free, permanent, never sold. The unique inventory index makes it
// grant only once per user. Returns true only on the first grant.
export async function grantStarter(user) {
  await db.run(sql`INSERT OR IGNORE INTO users (telegram_id, balance) VALUES (${user.id}, 0)`);
  const g = await db.run(sql`INSERT OR IGNORE INTO inventory (telegram_id, item_type, item_name, qty) VALUES (${user.id}, 'shinobi', 'Starter Shinobi', 1)`);
  return g.rowsAffected > 0;
}
