/**
 * Minimal persistent property layer needed by the reference pet economy.
 * The target previously had no property ownership. This preserves the source
 * BBQ feed fee (150) and Ichiraku owner cut without changing existing shops.
 */

import { db } from 'sdk';
import { sql } from 'sdk/db';
import { once } from './rpg/state.js';
import { escapeHtml, style } from './texts.js';
import { fmt } from './store.js';
import { PET_FEED_FEE, ICHIRAKU_OWNER_CUT_PCT } from './pet/defs.js';
import { ensurePetSchema } from './pet/store.js';

const now = () => Math.floor(Date.now() / 1000);

export const PROPERTIES = {
  bbq: {
    id: 'bbq',
    emoji: '🍖',
    name: 'BBQ',
    price: 100000,
    petFeedFee: PET_FEED_FEE,
    description: 'A recovery facility whose owners earn the pet-feed fee.',
  },
  ichiraku: {
    id: 'ichiraku',
    emoji: '🍜',
    name: 'Ichiraku Ramen Shop',
    price: 100000,
    ownerCutPct: ICHIRAKU_OWNER_CUT_PCT,
    description: 'A ramen shop whose owners earn the configured sale cut.',
  },
};

export function getPropertyDef(propertyId) {
  return PROPERTIES[propertyId] || null;
}

export async function getPropertyOwnership(groupId, propertyId) {
  await ensurePetSchema();
  if (!groupId || groupId >= 0) return null;
  const row = await db.get(sql`
    SELECT group_id, property_id, ownership_type, owner_1, owner_2,
           share_1, share_2, pending_1, pending_2, stored_earnings, acquired_at
    FROM property_ownership
    WHERE group_id = ${groupId} AND property_id = ${propertyId}
  `);
  if (!row) return null;
  return {
    groupId: Number(row.group_id),
    propertyId: row.property_id,
    ownershipType: row.ownership_type,
    owner1: Number(row.owner_1),
    owner2: row.owner_2 == null ? null : Number(row.owner_2),
    share1: Number(row.share_1 || 0),
    share2: Number(row.share_2 || 0),
    pending1: Number(row.pending_1 || 0),
    pending2: Number(row.pending_2 || 0),
    storedEarnings: Number(row.stored_earnings || 0),
    acquiredAt: Number(row.acquired_at || 0),
  };
}

async function logPurchase(userId, label, cost, key) {
  try {
    await db.run(sql`
      INSERT INTO purchases (update_id, telegram_id, item_name, qty, cost)
      VALUES (${null}, ${userId}, ${label}, 1, ${cost})
    `);
  } catch (e) {
    console.error('[property purchase log]', e);
  }
  // Keep the key reserved for callers that need extra diagnostics.
  if (key) return key;
  return null;
}

export async function addPropertyEarnings(groupId, propertyId, amount) {
  const value = Math.max(0, Math.trunc(Number(amount) || 0));
  if (!groupId || groupId >= 0 || value <= 0) return 0;
  const ownership = await getPropertyOwnership(groupId, propertyId);
  if (!ownership) return 0;
  const add1 = Math.floor((value * ownership.share1) / 100);
  const add2 = value - add1;
  // Single statement: pending and total both use their pre-update values.
  await db.run(sql`
    UPDATE property_ownership
    SET pending_1 = pending_1 + ${add1},
        pending_2 = pending_2 + ${add2},
        stored_earnings = stored_earnings + ${value}
    WHERE group_id = ${groupId} AND property_id = ${propertyId}
  `);
  return value;
}

export async function reversePropertyEarnings(groupId, propertyId, amount) {
  const value = Math.max(0, Math.trunc(Number(amount) || 0));
  if (!groupId || groupId >= 0 || value <= 0) return;
  const ownership = await getPropertyOwnership(groupId, propertyId);
  if (!ownership) return;
  const sub1 = Math.floor((value * ownership.share1) / 100);
  const sub2 = value - sub1;
  await db.run(sql`
    UPDATE property_ownership
    SET pending_1 = MAX(0, pending_1 - ${sub1}),
        pending_2 = MAX(0, pending_2 - ${sub2}),
        stored_earnings = MAX(0, stored_earnings - ${value})
    WHERE group_id = ${groupId} AND property_id = ${propertyId}
  `);
}

export async function creditIchirakuOwners(groupId, amount) {
  const value = Math.max(0, Math.trunc(Number(amount) || 0));
  if (value <= 0) return 0;
  const ownership = await getPropertyOwnership(groupId, 'ichiraku');
  if (!ownership) return 0;
  const def = PROPERTIES.ichiraku;
  const cut = Math.max(0, Math.floor((value * (def.ownerCutPct ?? ICHIRAKU_OWNER_CUT_PCT)) / 100));
  if (cut <= 0) return 0;
  try {
    await addPropertyEarnings(groupId, 'ichiraku', cut);
    return cut;
  } catch (e) {
    console.error('[ichiraku owner cut]', e);
    return 0;
  }
}

/** Charge the BBQ feed fee only when the group owns the property. */
export async function chargePetFeed(groupId, userId, idempotencyKey) {
  await ensurePetSchema();
  if (!groupId || groupId >= 0) return { code: 'no_property', fee: PET_FEED_FEE };
  const ownership = await getPropertyOwnership(groupId, 'bbq');
  if (!ownership) return { code: 'no_property', fee: PET_FEED_FEE };
  const fee = Math.max(0, Math.trunc(Number(PROPERTIES.bbq.petFeedFee) || 0));
  if (fee <= 0) return { code: 'ok', fee: 0 };
  if (idempotencyKey && !(await once(`pet_feed_fee:${idempotencyKey}`))) {
    return { code: 'duplicate', fee };
  }
  await db.run(sql`INSERT OR IGNORE INTO users (telegram_id, balance) VALUES (${userId}, 0)`);
  const paid = await db.run(sql`
    UPDATE users SET balance = balance - ${fee}
    WHERE telegram_id = ${userId} AND balance >= ${fee}
  `);
  if (paid.rowsAffected === 0) return { code: 'insufficient', fee };
  await logPurchase(userId, 'Pet feed at BBQ', fee, idempotencyKey);
  try {
    await addPropertyEarnings(groupId, 'bbq', fee);
  } catch (e) {
    console.error('[pet feed owner credit]', e);
    await db.run(sql`UPDATE users SET balance = balance + ${fee} WHERE telegram_id = ${userId}`);
    return { code: 'failed', fee };
  }
  return { code: 'ok', fee };
}

export async function refundPetFeed(groupId, userId, fee) {
  const value = Math.max(0, Math.trunc(Number(fee) || 0));
  if (value <= 0) return;
  try {
    await db.run(sql`UPDATE users SET balance = balance + ${value} WHERE telegram_id = ${userId}`);
    await reversePropertyEarnings(groupId, 'bbq', value);
  } catch (e) {
    console.error('[pet feed refund]', e);
  }
}

export async function buyPropertySolo(groupId, userId, propertyId, idempotencyKey) {
  await ensurePetSchema();
  const def = getPropertyDef(propertyId);
  if (!def) return { code: 'invalid' };
  if (!groupId || groupId >= 0) return { code: 'group_only' };
  if (await getPropertyOwnership(groupId, propertyId)) return { code: 'owned' };
  if (idempotencyKey && !(await once(`property_buy:${idempotencyKey}`))) {
    return { code: 'duplicate' };
  }
  await db.run(sql`INSERT OR IGNORE INTO users (telegram_id, balance) VALUES (${userId}, 0)`);
  const paid = await db.run(sql`
    UPDATE users SET balance = balance - ${def.price}
    WHERE telegram_id = ${userId} AND balance >= ${def.price}
  `);
  if (paid.rowsAffected === 0) {
    const bal = await db.get(sql`SELECT balance FROM users WHERE telegram_id = ${userId}`);
    return { code: 'insufficient', balance: Number(bal?.balance || 0), price: def.price };
  }
  const inserted = await db.run(sql`
    INSERT OR IGNORE INTO property_ownership
      (group_id, property_id, ownership_type, owner_1, owner_2, share_1, share_2,
       pending_1, pending_2, stored_earnings, acquired_at)
    VALUES (${groupId}, ${propertyId}, 'solo', ${userId}, NULL, 100, 0, 0, 0, 0, ${now()})
  `);
  if (inserted.rowsAffected === 0) {
    await db.run(sql`UPDATE users SET balance = balance + ${def.price} WHERE telegram_id = ${userId}`);
    return { code: 'owned' };
  }
  await logPurchase(userId, `Property: ${def.name}`, def.price, idempotencyKey);
  return { code: 'ok', property: def };
}

export async function claimPropertyEarnings(groupId, userId, propertyId) {
  const ownership = await getPropertyOwnership(groupId, propertyId);
  if (!ownership) return { code: 'not_found', amount: 0 };
  let claim = 0;
  let first = false;
  if (userId === ownership.owner1) (claim = ownership.pending1), (first = true);
  else if (ownership.owner2 != null && userId === ownership.owner2) claim = ownership.pending2;
  else return { code: 'not_owner', amount: 0 };
  if (claim <= 0) return { code: 'nothing', amount: 0 };

  const won = first
    ? await db.run(sql`
        UPDATE property_ownership
        SET pending_1 = pending_1 - ${claim}, stored_earnings = MAX(0, stored_earnings - ${claim})
        WHERE group_id = ${groupId} AND property_id = ${propertyId} AND pending_1 >= ${claim}
      `)
    : await db.run(sql`
        UPDATE property_ownership
        SET pending_2 = pending_2 - ${claim}, stored_earnings = MAX(0, stored_earnings - ${claim})
        WHERE group_id = ${groupId} AND property_id = ${propertyId} AND pending_2 >= ${claim}
      `);
  if (won.rowsAffected === 0) return { code: 'nothing', amount: 0 };

  await db.run(sql`INSERT OR IGNORE INTO users (telegram_id, balance) VALUES (${userId}, 0)`);
  await db.run(sql`UPDATE users SET balance = balance + ${claim} WHERE telegram_id = ${userId}`);
  await logPurchase(userId, `Property earnings: ${propertyId}`, claim, null);
  return { code: 'ok', amount: claim };
}

export function propertyStoreText(groupId) {
  const lines = [
    '<b>🏠 PROPERTY STORE</b>',
    groupId < 0
      ? 'Properties are owned by this group. Owners receive configured service cuts.'
      : 'Properties can only be bought inside a group.',
    '',
  ];
  for (const def of Object.values(PROPERTIES)) {
    lines.push(`${def.emoji} <b>${escapeHtml(def.name)}</b> — ${fmt(def.price)} 🍥`);
    lines.push(escapeHtml(def.description));
    if (def.petFeedFee) lines.push(`Pet feed fee: ${fmt(def.petFeedFee)} 🍥`);
    lines.push('');
  }
  return lines.join('\n');
}

export async function propertyStoreKeyboard(groupId, userId) {
  const rows = [];
  for (const def of Object.values(PROPERTIES)) {
    const owner = await getPropertyOwnership(groupId, def.id);
    if (!owner) {
      rows.push([{
        text: `Buy ${def.name} — ${fmt(def.price)} 🍥`,
        callback_data: `map_prop_buy:${def.id}:${userId}`,
        style: 'primary',
      }]);
    } else {
      const mine = userId === owner.owner1 ? owner.pending1
        : (owner.owner2 != null && userId === owner.owner2 ? owner.pending2 : 0);
      rows.push([{
        text: `💰 ${def.name} earnings — ${fmt(mine)} 🍥`,
        callback_data: `map_prop_claim:${def.id}:${userId}`,
        style: mine > 0 ? 'success' : 'transparent',
      }]);
    }
  }
  rows.push([{ text: '⬅️ Back', callback_data: `map_loc_store:${userId}`, style: 'danger' }]);
  return { inline_keyboard: rows };
}

export async function propertyStoreBody(groupId, userId) {
  const blocks = [`<p><b>🏠 PROPERTY STORE</b></p>`];
  if (groupId >= 0) blocks.push('<p>Properties can only be bought inside a group.</p>');
  for (const def of Object.values(PROPERTIES)) {
    const owner = await getPropertyOwnership(groupId, def.id);
    if (!owner) {
      blocks.push(`<p>${def.emoji} <b>${escapeHtml(def.name)}</b> — ${fmt(def.price)} 🍥</p>`);
      blocks.push(`<p>${escapeHtml(def.description)}</p>`);
    } else {
      const mine = userId === owner.owner1 ? owner.pending1
        : (owner.owner2 != null && userId === owner.owner2 ? owner.pending2 : 0);
      blocks.push(`<p>${def.emoji} <b>${escapeHtml(def.name)}</b> — owned</p>`);
      blocks.push(`<p>Owner earnings available to you: ${fmt(mine)} 🍥</p>`);
    }
  }
  return blocks.join('');
}

export { style };
