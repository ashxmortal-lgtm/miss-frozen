/**
 * Pet System V1 persistence + mechanics — source-faithful port of pet.py.
 *
 * Reproduced rules:
 *  - Only the EQUIPPED pet can Feed / Play / Train / Rest.
 *  - Feed / Play / Train need an available Shinobi, who stays busy for the whole
 *    activity (shared `activities` row, kind='pet'); Rest needs no Shinobi.
 *  - Cooldowns are per activity (feed 6h, play 4h, train 8h), fixed when the
 *    activity COMPLETES, and stored on the pet row like the source.
 *  - Energy regenerates lazily: +10 / 2h, +15 / 1h while resting.
 *  - XP caps at 15,000; the level derives from XP.
 *  - BBQ feeding charges the group property fee; no owner = feeding refused.
 * State is SQLite only — no timers, no background loops.
 */

import { db } from 'sdk';
import { sql } from 'sdk/db';
import { once } from '../rpg/state.js';
import {
  PETS, PET_IDS, PET_XP_CAP, PET_NAMETAG_KEY, PET_NAMETAG_MAX_LEN, PET_NAMETAG_PRICE,
  PET_ACTIVITIES, PET_FOOD_MENU, PET_MAX_ENERGY,
  petLevelForXp, petRegenEnergy, petRewardBonusFor, petShinobiXpBonusFor,
  petTimeReductionFor, sanitizePetName, petNameLength,
} from './defs.js';

const now = () => Math.floor(Date.now() / 1000);

let schemaPromise = null;

/** Runtime safety net; `tgcloud migrate` remains the canonical migration. */
export function ensurePetSchema() {
  if (schemaPromise) return schemaPromise;
  schemaPromise = (async () => {
    const ddl = [
      `CREATE TABLE IF NOT EXISTS user_pets (
        telegram_id INTEGER NOT NULL,
        pet_id TEXT NOT NULL,
        pet_name TEXT,
        xp INTEGER NOT NULL DEFAULT 0,
        energy INTEGER NOT NULL DEFAULT 100,
        last_energy_at INTEGER NOT NULL DEFAULT 0,
        equipped INTEGER NOT NULL DEFAULT 0,
        acquired_at INTEGER NOT NULL DEFAULT 0,
        feed_cooldown_until INTEGER NOT NULL DEFAULT 0,
        play_cooldown_until INTEGER NOT NULL DEFAULT 0,
        train_cooldown_until INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (telegram_id, pet_id)
      )`,
      `CREATE TABLE IF NOT EXISTS equipped_pet (
        telegram_id INTEGER PRIMARY KEY,
        pet_id TEXT NOT NULL,
        updated_at INTEGER NOT NULL DEFAULT 0
      )`,
      `CREATE TABLE IF NOT EXISTS pet_activity (
        telegram_id INTEGER NOT NULL,
        pet_id TEXT NOT NULL,
        activity_type TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        started_at INTEGER NOT NULL DEFAULT 0,
        ends_at INTEGER NOT NULL DEFAULT 0,
        cooldown_until INTEGER NOT NULL DEFAULT 0,
        chat_id INTEGER NOT NULL DEFAULT 0,
        shinobi_name TEXT,
        PRIMARY KEY (telegram_id, pet_id)
      )`,
      `CREATE TABLE IF NOT EXISTS pet_stats (
        telegram_id INTEGER PRIMARY KEY,
        feed_count INTEGER NOT NULL DEFAULT 0,
        play_count INTEGER NOT NULL DEFAULT 0,
        train_count INTEGER NOT NULL DEFAULT 0,
        rest_count INTEGER NOT NULL DEFAULT 0,
        reward_triggers INTEGER NOT NULL DEFAULT 0,
        xp_earned INTEGER NOT NULL DEFAULT 0
      )`,
      `CREATE TABLE IF NOT EXISTS special_inventory (
        telegram_id INTEGER NOT NULL,
        item_key TEXT NOT NULL,
        quantity INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (telegram_id, item_key)
      )`,
      `CREATE TABLE IF NOT EXISTS property_ownership (
        group_id INTEGER NOT NULL,
        property_id TEXT NOT NULL,
        ownership_type TEXT NOT NULL DEFAULT 'solo',
        owner_1 INTEGER NOT NULL,
        owner_2 INTEGER,
        share_1 INTEGER NOT NULL DEFAULT 100,
        share_2 INTEGER NOT NULL DEFAULT 0,
        pending_1 INTEGER NOT NULL DEFAULT 0,
        pending_2 INTEGER NOT NULL DEFAULT 0,
        stored_earnings INTEGER NOT NULL DEFAULT 0,
        acquired_at INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (group_id, property_id)
      )`,
      `CREATE TABLE IF NOT EXISTS property_partnership_requests (
        group_id INTEGER NOT NULL,
        property_id TEXT NOT NULL,
        requester_id INTEGER NOT NULL,
        target_id INTEGER NOT NULL,
        created_at INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (group_id, property_id, requester_id, target_id)
      )`,
      `CREATE TABLE IF NOT EXISTS daily_missions (
        user_id INTEGER NOT NULL,
        cycle_date TEXT NOT NULL,
        mission_id TEXT NOT NULL,
        requirement_type TEXT NOT NULL,
        target_count INTEGER NOT NULL DEFAULT 1,
        progress INTEGER NOT NULL DEFAULT 0,
        reward_coins INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'assigned',
        assigned_at INTEGER NOT NULL DEFAULT 0,
        completed_at INTEGER,
        reward_settled INTEGER NOT NULL DEFAULT 0,
        reward_settlement_key TEXT,
        source_chat_id INTEGER,
        last_event_key TEXT,
        mission_name TEXT,
        mission_emoji TEXT,
        mission_description TEXT,
        difficulty TEXT,
        PRIMARY KEY (user_id, cycle_date)
      )`,
    ];
    for (const statement of ddl) {
      try {
        await db.run(sql.raw(statement));
      } catch (e) {
        console.error('[pet schema]', e?.message || e);
      }
    }
    // Additive columns for databases created before this feature shipped.
    for (const statement of [
      'ALTER TABLE user_pets ADD COLUMN pet_name TEXT',
      'ALTER TABLE user_pets ADD COLUMN acquired_at INTEGER NOT NULL DEFAULT 0',
      'ALTER TABLE user_pets ADD COLUMN equipped INTEGER NOT NULL DEFAULT 0',
      'ALTER TABLE user_pets ADD COLUMN feed_cooldown_until INTEGER NOT NULL DEFAULT 0',
      'ALTER TABLE user_pets ADD COLUMN play_cooldown_until INTEGER NOT NULL DEFAULT 0',
      'ALTER TABLE user_pets ADD COLUMN train_cooldown_until INTEGER NOT NULL DEFAULT 0',
      'ALTER TABLE pet_activity ADD COLUMN shinobi_name TEXT',
      'ALTER TABLE activities ADD COLUMN cooldown_sec INTEGER NOT NULL DEFAULT 0',
    ]) {
      try { await db.run(sql.raw(statement)); } catch (_) { /* already exists */ }
    }
  })();
  return schemaPromise;
}

const rowToPet = (row, equippedId) => {
  if (!row) return null;
  const def = PETS[row.pet_id];
  if (!def) return null;
  return {
    petId: row.pet_id,
    def,
    name: row.pet_name || def.name,
    xp: Number(row.xp || 0),
    level: petLevelForXp(Number(row.xp || 0)),
    energy: Number(row.energy ?? PET_MAX_ENERGY),
    lastEnergyAt: Number(row.last_energy_at || 0),
    equipped: row.pet_id === equippedId,
    acquiredAt: Number(row.acquired_at || 0),
    cooldowns: {
      feed: Number(row.feed_cooldown_until || 0),
      play: Number(row.play_cooldown_until || 0),
      train: Number(row.train_cooldown_until || 0),
    },
  };
};

async function equippedId(userId) {
  const row = await db.get(sql`SELECT pet_id FROM equipped_pet WHERE telegram_id = ${userId}`);
  return row ? row.pet_id : null;
}

async function rawPets(userId) {
  const rows = await db.all(sql`
    SELECT telegram_id, pet_id, pet_name, xp, energy, last_energy_at, equipped, acquired_at,
           feed_cooldown_until, play_cooldown_until, train_cooldown_until
    FROM user_pets WHERE telegram_id = ${userId}
    ORDER BY acquired_at ASC, pet_id ASC
  `);
  const eq = await equippedId(userId);
  return (rows || []).map((row) => rowToPet(row, eq)).filter(Boolean);
}

export async function getPetActivity(userId, petId) {
  const row = await db.get(sql`
    SELECT telegram_id, pet_id, activity_type, status, started_at, ends_at,
           cooldown_until, chat_id, shinobi_name
    FROM pet_activity WHERE telegram_id = ${userId} AND pet_id = ${petId}
  `);
  if (!row) return null;
  return {
    userId: Number(row.telegram_id),
    petId: row.pet_id,
    activityType: row.activity_type,
    status: row.status,
    startedAt: Number(row.started_at || 0),
    endsAt: Number(row.ends_at || 0),
    cooldownUntil: Number(row.cooldown_until || 0),
    chatId: Number(row.chat_id || 0),
    shinobiName: row.shinobi_name || null,
  };
}

async function isBusy(userId, petId) {
  const activity = await getPetActivity(userId, petId);
  if (!activity || activity.status !== 'active') return false;
  if (activity.activityType === 'rest') return true;
  return activity.endsAt === 0 || activity.endsAt > now();
}

/** Lazy energy clocks: normal +10/2h, resting +15/1h. */
async function applyEnergyRegen(userId) {
  const pets = await rawPets(userId);
  const t = now();
  const out = [];
  for (const pet of pets) {
    const activity = await getPetActivity(userId, pet.petId);
    const resting = !!activity && activity.activityType === 'rest' && activity.status === 'active';
    const regen = petRegenEnergy(pet.energy, pet.lastEnergyAt, resting, t);
    if (regen.energy !== pet.energy || regen.lastEnergyAt !== pet.lastEnergyAt) {
      await db.run(sql`
        UPDATE user_pets SET energy = ${regen.energy}, last_energy_at = ${regen.lastEnergyAt}
        WHERE telegram_id = ${userId} AND pet_id = ${pet.petId}
      `);
    }
    out.push({ ...pet, energy: regen.energy, lastEnergyAt: regen.lastEnergyAt });
  }
  return out;
}

async function bumpStats(userId, fields) {
  await db.run(sql`INSERT OR IGNORE INTO pet_stats (telegram_id) VALUES (${userId})`);
  for (const [key, value] of Object.entries(fields)) {
    if (!value) continue;
    const amount = Math.trunc(value);
    if (key === 'feed') {
      await db.run(sql`UPDATE pet_stats SET feed_count = feed_count + ${amount} WHERE telegram_id = ${userId}`);
    } else if (key === 'play') {
      await db.run(sql`UPDATE pet_stats SET play_count = play_count + ${amount} WHERE telegram_id = ${userId}`);
    } else if (key === 'train') {
      await db.run(sql`UPDATE pet_stats SET train_count = train_count + ${amount} WHERE telegram_id = ${userId}`);
    } else if (key === 'rest') {
      await db.run(sql`UPDATE pet_stats SET rest_count = rest_count + ${amount} WHERE telegram_id = ${userId}`);
    } else if (key === 'rewardTriggers') {
      await db.run(sql`UPDATE pet_stats SET reward_triggers = reward_triggers + ${amount} WHERE telegram_id = ${userId}`);
    } else if (key === 'xpEarned') {
      await db.run(sql`UPDATE pet_stats SET xp_earned = xp_earned + ${amount} WHERE telegram_id = ${userId}`);
    }
  }
}

export async function getPetStats(userId) {
  const row = await db.get(sql`
    SELECT feed_count, play_count, train_count, rest_count, reward_triggers, xp_earned
    FROM pet_stats WHERE telegram_id = ${userId}
  `);
  return {
    feedCount: Number(row?.feed_count || 0),
    playCount: Number(row?.play_count || 0),
    trainCount: Number(row?.train_count || 0),
    restCount: Number(row?.rest_count || 0),
    rewardTriggers: Number(row?.reward_triggers || 0),
    xpEarned: Number(row?.xp_earned || 0),
  };
}

async function xpOf(userId, petId) {
  const row = await db.get(sql`
    SELECT xp FROM user_pets WHERE telegram_id = ${userId} AND pet_id = ${petId}
  `);
  return Number(row?.xp || 0);
}

/** Add XP with the source cap; returns the amount actually granted. */
async function grantPetXp(userId, petId, amount) {
  const before = await xpOf(userId, petId);
  const after = Math.min(PET_XP_CAP, before + Math.max(0, Math.trunc(amount)));
  if (after === before) return 0;
  await db.run(sql`
    UPDATE user_pets SET xp = ${after} WHERE telegram_id = ${userId} AND pet_id = ${petId}
  `);
  await bumpStats(userId, { xpEarned: after - before });
  return after - before;
}

/**
 * Finish due timed activities: award XP, fix the per-activity cooldown at the
 * completion stamp, free the Shinobi and delete the activity row. The guarded
 * DELETE means exactly one caller settles a given activity.
 */
export async function settlePetActivities(userId) {
  const t = now();
  const rows = await db.all(sql`
    SELECT telegram_id, pet_id, activity_type, started_at, ends_at, shinobi_name
    FROM pet_activity
    WHERE telegram_id = ${userId} AND status = 'active' AND ends_at > 0 AND ends_at <= ${t}
  `);
  const finished = [];
  for (const row of rows) {
    const cfg = PET_ACTIVITIES[row.activity_type];
    const def = PETS[row.pet_id];
    if (!cfg || !def) continue;
    const won = await db.run(sql`
      DELETE FROM pet_activity
      WHERE telegram_id = ${userId} AND pet_id = ${row.pet_id}
        AND status = 'active' AND started_at = ${row.started_at}
    `);
    if (won.rowsAffected === 0) continue;

    const beforeXp = await xpOf(userId, row.pet_id);
    const xp = await grantPetXp(userId, row.pet_id, cfg.xp);
    const afterXp = beforeXp + xp;
    const statKey = { feed: 'feed', play: 'play', train: 'train' }[row.activity_type];
    if (statKey) await bumpStats(userId, { [statKey]: 1 });
    if (statKey) {
      // Daily pet missions progress on COMPLETION (spec §5), once per activity.
      try {
        const { notifyDailyProgress, getDailyMission } = await import('../daily.js');
        // A background completion never assigns the day's mission by itself;
        // it only progresses one the player already has.
        if (await getDailyMission(userId)) {
          await notifyDailyProgress(
            userId, `pet_${row.activity_type}`,
            `pet_settle:${userId}:${row.pet_id}:${row.started_at}`,
          );
        }
      } catch (e) { console.error('[pet daily]', e); }
    }

    let cooldownUntil = 0;
    if (cfg.cooldownHours > 0) {
      // Source fixes the cooldown at completion processing time (`now + hours`).
      cooldownUntil = t + cfg.cooldownHours * 3600;
      if (cfg.key === 'feed') {
        await db.run(sql`
          UPDATE user_pets SET feed_cooldown_until = ${cooldownUntil}
          WHERE telegram_id = ${userId} AND pet_id = ${row.pet_id}
        `);
      } else if (cfg.key === 'play') {
        await db.run(sql`
          UPDATE user_pets SET play_cooldown_until = ${cooldownUntil}
          WHERE telegram_id = ${userId} AND pet_id = ${row.pet_id}
        `);
      } else {
        await db.run(sql`
          UPDATE user_pets SET train_cooldown_until = ${cooldownUntil}
          WHERE telegram_id = ${userId} AND pet_id = ${row.pet_id}
        `);
      }
    }

    if (row.shinobi_name) {
      try {
        await db.run(sql`
          UPDATE activities SET status = 'idle'
          WHERE telegram_id = ${userId} AND shinobi = ${row.shinobi_name}
            AND kind = 'pet' AND status = 'active'
        `);
      } catch (e) { console.error('[pet free shinobi]', e); }
    }
    finished.push({
      petId: row.pet_id,
      petName: def.name,
      activityType: row.activity_type,
      shinobiName: row.shinobi_name || null,
      xp,
      cooldownUntil,
      levelUp: petLevelForXp(afterXp) > petLevelForXp(beforeXp),
      level: petLevelForXp(afterXp),
    });
  }
  return finished;
}

export async function listPets(userId) {
  await ensurePetSchema();
  await settlePetActivities(userId);
  const pets = await applyEnergyRegen(userId);
  for (const pet of pets) pet.activity = await getPetActivity(userId, pet.petId);
  return pets;
}

export async function getPet(userId, petId) {
  const id = String(petId || '').toLowerCase();
  if (!PETS[id]) return null;
  const pets = await listPets(userId);
  return pets.find((p) => p.petId === id) || null;
}

export async function buyPet(userId, petId, idempotencyKey) {
  await ensurePetSchema();
  const id = String(petId || '').toLowerCase();
  const def = PETS[id];
  if (!def) return { code: 'invalid' };
  if (await getPet(userId, id)) return { code: 'already_owned' };
  if (idempotencyKey && !(await once(`pet_buy:${userId}:${id}:${idempotencyKey}`))) {
    return { code: 'duplicate' };
  }
  await db.run(sql`INSERT OR IGNORE INTO users (telegram_id, balance) VALUES (${userId}, 0)`);
  const paid = await db.run(sql`
    UPDATE users SET balance = balance - ${def.price}
    WHERE telegram_id = ${userId} AND balance >= ${def.price}
  `);
  if (paid.rowsAffected === 0) {
    const row = await db.get(sql`SELECT balance FROM users WHERE telegram_id = ${userId}`);
    return { code: 'insufficient', balance: Number(row?.balance || 0), price: def.price };
  }
  const t = now();
  const inserted = await db.run(sql`
    INSERT OR IGNORE INTO user_pets
      (telegram_id, pet_id, pet_name, xp, energy, last_energy_at, equipped, acquired_at)
    VALUES (${userId}, ${id}, NULL, 0, ${PET_MAX_ENERGY}, ${t}, 0, ${t})
  `);
  if (inserted.rowsAffected === 0) {
    await db.run(sql`UPDATE users SET balance = balance + ${def.price} WHERE telegram_id = ${userId}`);
    return { code: 'already_owned' };
  }
  await db.run(sql`INSERT OR IGNORE INTO pet_stats (telegram_id) VALUES (${userId})`);
  try {
    await db.run(sql`
      INSERT INTO purchases (update_id, telegram_id, item_name, qty, cost)
      VALUES (${null}, ${userId}, ${`Pet: ${def.name}`}, 1, ${def.price})
    `);
  } catch (e) { console.error('[pet purchase log]', e); }
  // The source never auto-equips; the owner must run /equip_pet.
  return { code: 'ok', pet: await getPet(userId, id), price: def.price };
}

export async function equipPet(userId, petId) {
  await ensurePetSchema();
  const id = String(petId || '').toLowerCase();
  if (!PETS[id]) return { code: 'invalid' };
  const pet = await getPet(userId, id);
  if (!pet) return { code: 'not_owned' };
  if (await equippedId(userId) === id) return { code: 'already_equipped', pet };
  await db.run(sql`
    UPDATE user_pets SET equipped = CASE WHEN pet_id = ${id} THEN 1 ELSE 0 END
    WHERE telegram_id = ${userId}
  `);
  await db.run(sql`
    INSERT INTO equipped_pet (telegram_id, pet_id, updated_at)
    VALUES (${userId}, ${id}, ${now()})
    ON CONFLICT(telegram_id) DO UPDATE SET pet_id = excluded.pet_id, updated_at = excluded.updated_at
  `);
  return { code: 'ok', pet: await getPet(userId, id) };
}

/** Equipped pet only, exactly like the source `get_active_pet`. */
export async function getEquippedPet(userId) {
  await ensurePetSchema();
  const id = await equippedId(userId);
  if (!id) return null;
  const pets = await listPets(userId);
  return pets.find((p) => p.petId === id) || null;
}

const SHINOBI_NAMES = new Set([
  'Sasuke', 'Sakura', 'Naruto', 'Itachi', 'Hinata', 'Jiraiya',
  'Tsunade', 'Starter Shinobi',
]);

/** Owned Shinobi names from the shared inventory. */
export async function ownedShinobi(userId) {
  const rows = await db.all(sql`
    SELECT item_name FROM inventory WHERE telegram_id = ${userId} AND qty > 0
  `);
  const names = (rows || []).map((r) => r.item_name).filter((n) => SHINOBI_NAMES.has(n));
  return [...new Set(names)].sort((a, b) => {
    if (a === 'Starter Shinobi') return -1;
    if (b === 'Starter Shinobi') return 1;
    return a.localeCompare(b);
  });
}

/** Null when the Shinobi can take a pet activity, else a short reason. */
export async function shinobiAvailability(userId, shinobi) {
  const { getShinobiState, isDead, isExhausted } = await import('../rpg/state.js');
  const owned = await db.get(sql`
    SELECT 1 AS ok FROM inventory
    WHERE telegram_id = ${userId} AND item_name = ${shinobi} AND qty > 0
  `);
  if (!owned) return 'not_owned';
  const t = now();
  const state = await getShinobiState(userId, shinobi);
  if (isDead(state, t)) return 'dead';
  if (isExhausted(state, t)) return 'exhausted';
  if (shinobi === 'Naruto' || shinobi === 'Jiraiya') {
    try {
      const search = await db.get(sql`SELECT status FROM tsunade_search WHERE telegram_id = ${userId}`);
      if (search?.status === 'active') return 'searching';
    } catch (_) { /* optional table */ }
  }
  const act = await db.get(sql`
    SELECT kind, status FROM activities
    WHERE telegram_id = ${userId} AND shinobi = ${shinobi}
  `);
  if (act?.status === 'active') return act.kind === 'pet' ? 'pet_busy' : `on_${act.kind}`;
  return null;
}

/**
 * Start Feed / Play / Train / Rest for the equipped pet.
 * `shinobi` is required for feed/play/train; `locationKey` enforces the map gate.
 */
export async function startPetActivity(userId, petId, type, options = {}) {
  await ensurePetSchema();
  const cfg = PET_ACTIVITIES[String(type || '').toLowerCase()];
  if (!cfg) return { code: 'invalid_activity' };
  const chatId = Number(options.chatId || 0);
  const t = now();
  await settlePetActivities(userId);
  const pet = await getPet(userId, petId);
  if (!pet) return { code: 'no_pet' };
  if (!pet.equipped) return { code: 'not_equipped' };
  if (options.locationKey && options.locationKey !== cfg.location) {
    return { code: 'wrong_location', location: cfg.location };
  }
  if (await isBusy(userId, pet.petId)) {
    const current = await getPetActivity(userId, pet.petId);
    return { code: 'busy', activity: current?.activityType || null };
  }
  const cdUntil = Number(pet.cooldowns?.[cfg.key] || 0);
  if (cdUntil > t) {
    return { code: 'cooldown', remaining: cdUntil - t, until: cdUntil };
  }
  if (cfg.energyCost > pet.energy) {
    return { code: 'no_energy', energy: pet.energy, needed: cfg.energyCost };
  }

  const needsShinobi = cfg.key !== 'rest';
  const shinobi = needsShinobi ? String(options.shinobi || '').trim() : null;
  if (needsShinobi && !shinobi) return { code: 'no_shinobi' };
  if (needsShinobi) {
    const reason = await shinobiAvailability(userId, shinobi);
    if (reason === 'pet_busy') return { code: 'shinobi_busy', reason };
    if (reason) return { code: 'shinobi_unavailable', reason };
  }

  const endsAt = cfg.durationMinutes == null ? 0 : t + cfg.durationMinutes * 60;

  // Reserve the Shinobi first (guarded flip), then claim the single pet slot.
  if (needsShinobi) {
    await db.run(sql`
      INSERT OR IGNORE INTO activities (telegram_id, shinobi, kind) VALUES (${userId}, ${shinobi}, 'pet')
    `);
    const claimed = await db.run(sql`
      UPDATE activities SET status = 'active', kind = 'pet', started_at = ${t},
        ends_at = ${endsAt}, base_roll = 0, chat_id = ${chatId}
      WHERE telegram_id = ${userId} AND shinobi = ${shinobi} AND status = 'idle'
    `);
    if (claimed.rowsAffected === 0) return { code: 'shinobi_busy', reason: 'busy' };
  }

  const releaseShinobi = async () => {
    if (!needsShinobi) return;
    await db.run(sql`
      UPDATE activities SET status = 'idle'
      WHERE telegram_id = ${userId} AND shinobi = ${shinobi}
        AND kind = 'pet' AND status = 'active' AND started_at = ${t}
    `);
  };

  const claimedPet = await db.run(sql`
    INSERT OR IGNORE INTO pet_activity
      (telegram_id, pet_id, activity_type, status, started_at, ends_at, cooldown_until,
       chat_id, shinobi_name)
    VALUES (${userId}, ${pet.petId}, ${cfg.key}, 'active', ${t}, ${endsAt}, 0,
            ${chatId}, ${shinobi})
  `);
  if (claimedPet.rowsAffected === 0) {
    await releaseShinobi();
    return { code: 'busy' };
  }

  const newEnergy = pet.energy - cfg.energyCost;
  if (cfg.energyCost > 0) {
    const spent = await db.run(sql`
      UPDATE user_pets SET energy = energy - ${cfg.energyCost}, last_energy_at = ${t}
      WHERE telegram_id = ${userId} AND pet_id = ${pet.petId} AND energy >= ${cfg.energyCost}
    `);
    if (spent.rowsAffected === 0) {
      await db.run(sql`
        DELETE FROM pet_activity WHERE telegram_id = ${userId} AND pet_id = ${pet.petId}
      `);
      await releaseShinobi();
      return { code: 'no_energy', energy: await currentEnergy(userId, pet.petId), needed: cfg.energyCost };
    }
  } else {
    await db.run(sql`
      UPDATE user_pets SET last_energy_at = ${t}
      WHERE telegram_id = ${userId} AND pet_id = ${pet.petId}
    `);
  }

  if (cfg.key === 'rest') await bumpStats(userId, { rest: 1 });
  return {
    code: 'ok',
    type: cfg.key,
    until: endsAt,
    energy: newEnergy,
    energyCost: cfg.energyCost,
    shinobi: shinobi || null,
    eventKey: `pet_act:${userId}:${pet.petId}:${cfg.key}:${t}`,
  };
}

async function currentEnergy(userId, petId) {
  const pets = await applyEnergyRegen(userId);
  const pet = pets.find((p) => p.petId === petId);
  return pet ? pet.energy : 0;
}

/** End Rest (the only activity without a timer). */
export async function cancelPetActivity(userId, petId) {
  await ensurePetSchema();
  await settlePetActivities(userId);
  const pet = await getPet(userId, petId);
  if (!pet) return { code: 'no_pet' };
  const activity = await getPetActivity(userId, pet.petId);
  if (!activity || activity.status !== 'active') return { code: 'no_activity' };
  await applyEnergyRegen(userId);
  const won = await db.run(sql`
    DELETE FROM pet_activity
    WHERE telegram_id = ${userId} AND pet_id = ${pet.petId} AND status = 'active'
  `);
  if (won.rowsAffected === 0) return { code: 'no_activity' };
  if (activity.shinobiName) {
    await db.run(sql`
      UPDATE activities SET status = 'idle'
      WHERE telegram_id = ${userId} AND shinobi = ${activity.shinobiName}
        AND kind = 'pet' AND status = 'active'
    `);
  }
  return { code: 'ok', activityType: activity.activityType };
}

export const stopPetRest = cancelPetActivity;

export async function renamePet(userId, petId, newName) {
  await ensurePetSchema();
  const pet = await getPet(userId, petId);
  if (!pet) return { code: 'no_pet' };
  const clean = sanitizePetName(newName);
  if (!clean) return { code: 'invalid_name' };
  if (petNameLength(clean) > PET_NAMETAG_MAX_LEN) return { code: 'invalid_name' };
  const consumed = await db.run(sql`
    UPDATE special_inventory SET quantity = quantity - 1
    WHERE telegram_id = ${userId} AND item_key = ${PET_NAMETAG_KEY} AND quantity > 0
  `);
  if (consumed.rowsAffected === 0) return { code: 'no_nametag' };
  await db.run(sql`
    UPDATE user_pets SET pet_name = ${clean}
    WHERE telegram_id = ${userId} AND pet_id = ${pet.petId}
  `);
  return { code: 'ok', name: clean };
}

/** Buy one Pet Nametag (3,000 🍥). Duplicate taps are charged once. */
export async function buyPetNametag(userId, idempotencyKey) {
  await ensurePetSchema();
  if (idempotencyKey && !(await once(`pet_nametag:${userId}:${idempotencyKey}`))) {
    return { code: 'duplicate' };
  }
  await db.run(sql`INSERT OR IGNORE INTO users (telegram_id, balance) VALUES (${userId}, 0)`);
  const paid = await db.run(sql`
    UPDATE users SET balance = balance - ${PET_NAMETAG_PRICE}
    WHERE telegram_id = ${userId} AND balance >= ${PET_NAMETAG_PRICE}
  `);
  if (paid.rowsAffected === 0) {
    const row = await db.get(sql`SELECT balance FROM users WHERE telegram_id = ${userId}`);
    return { code: 'insufficient', balance: Number(row?.balance || 0), price: PET_NAMETAG_PRICE };
  }
  try {
    await grantSpecialItem(userId, PET_NAMETAG_KEY, 1);
  } catch (e) {
    console.error('[pet nametag]', e);
    await db.run(sql`UPDATE users SET balance = balance + ${PET_NAMETAG_PRICE} WHERE telegram_id = ${userId}`);
    return { code: 'failed' };
  }
  try {
    await db.run(sql`
      INSERT INTO purchases (update_id, telegram_id, item_name, qty, cost)
      VALUES (${null}, ${userId}, 'Pet Nametag', 1, ${PET_NAMETAG_PRICE})
    `);
  } catch (e) { console.error('[pet nametag log]', e); }
  return { code: 'ok', price: PET_NAMETAG_PRICE };
}

export async function grantSpecialItem(userId, itemKey, qty = 1) {
  await ensurePetSchema();
  await db.run(sql`
    INSERT INTO special_inventory (telegram_id, item_key, quantity)
    VALUES (${userId}, ${itemKey}, ${Math.trunc(qty)})
    ON CONFLICT(telegram_id, item_key) DO UPDATE SET quantity = quantity + ${Math.trunc(qty)}
  `);
}

export async function specialItemQty(userId, itemKey) {
  await ensurePetSchema();
  const row = await db.get(sql`
    SELECT quantity FROM special_inventory WHERE telegram_id = ${userId} AND item_key = ${itemKey}
  `);
  return Number(row?.quantity || 0);
}

export async function buyPetFood(userId, foodKey, idempotencyKey, chatId = 0) {
  await ensurePetSchema();
  const def = PET_FOOD_MENU[foodKey];
  if (!def) return { code: 'invalid' };
  const pet = await getEquippedPet(userId);
  if (!pet) return { code: 'no_pet' };
  if (idempotencyKey && !(await once(`pet_food:${userId}:${idempotencyKey}`))) {
    return { code: 'duplicate' };
  }
  await db.run(sql`INSERT OR IGNORE INTO users (telegram_id, balance) VALUES (${userId}, 0)`);
  const paid = await db.run(sql`
    UPDATE users SET balance = balance - ${def.cost}
    WHERE telegram_id = ${userId} AND balance >= ${def.cost}
  `);
  if (paid.rowsAffected === 0) {
    const row = await db.get(sql`SELECT balance FROM users WHERE telegram_id = ${userId}`);
    return { code: 'insufficient', balance: Number(row?.balance || 0), cost: def.cost };
  }
  try {
    await db.run(sql`
      INSERT INTO purchases (update_id, telegram_id, item_name, qty, cost)
      VALUES (${null}, ${userId}, ${`Pet food: ${def.name}`}, 1, ${def.cost})
    `);
  } catch (e) { console.error('[pet food log]', e); }
  const beforeLevel = pet.level;
  let gained;
  try {
    gained = await grantPetXp(userId, pet.petId, def.petXp);
  } catch (e) {
    console.error('[pet food xp]', e);
    await db.run(sql`UPDATE users SET balance = balance + ${def.cost} WHERE telegram_id = ${userId}`);
    return { code: 'failed' };
  }
  const after = await getPet(userId, pet.petId);
  try {
    const { creditIchirakuOwners } = await import('../property.js');
    await creditIchirakuOwners(chatId, def.cost);
  } catch (e) { console.error('[ichiraku pet-food cut]', e); }
  return {
    code: 'ok', petXp: gained, name: def.name, emoji: def.emoji,
    level: after.level, levelUp: after.level > beforeLevel,
  };
}

/** Axofly: additive coins from a positive base reward. */
export async function petRewardBonus(userId, baseReward) {
  const pet = await getEquippedPet(userId);
  if (!pet || pet.petId !== 'axofly') return { bonus: 0, triggered: false, pet };
  const result = petRewardBonusFor(baseReward, pet.petId, pet.level);
  if (result.bonus > 0) await bumpStats(userId, { rewardTriggers: 1 });
  return { ...result, pet };
}

/** Axofly: Shinobi XP multiplier (callers floor like the source `int()`). */
export async function petShinobiXpMultiplier(userId) {
  const pet = await getEquippedPet(userId);
  if (!pet) return 1;
  return 1 + petShinobiXpBonusFor(pet.petId, pet.level);
}

/** Capycorn: reductions applied when a mission/patrol is scheduled. */
export async function petTimeReduction(userId) {
  const pet = await getEquippedPet(userId);
  if (!pet) return { durationFrac: 0, cooldownFrac: 0, pet: null };
  return { ...petTimeReductionFor(pet.petId, pet.level), pet };
}

/** Human-readable ability lines for the equipped pet. */
export function petAbilityLines(pet) {
  if (!pet) return [];
  const { def, level } = pet;
  if (pet.petId === 'axofly') {
    const boost = def.rewardBoost[level] || [0, 0];
    return [
      `Trigger chance: ${Math.round(boost[0] * 100)}%`,
      `Reward bonus: +${Math.round(boost[1] * 100)}%`,
      `Shinobi XP: +${Math.round((def.shinobiXpBonus[level] || 0) * 100)}%`,
    ];
  }
  const cut = def.timeReduction[level] || [0, 0];
  return [
    `Mission/Patrol duration: −${Math.round(cut[0] * 100)}%`,
    `Mission/Patrol cooldown: −${Math.round(cut[1] * 100)}%`,
  ];
}

export { PET_IDS, PETS, PET_ACTIVITIES, PET_FOOD_MENU };
