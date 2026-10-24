/**
 * Map keyboards — centered rows, labels per product spec.
 */

function btn(text, data) {
  return { text, callback_data: data, style: 'transparent' };
}

/** Embed user_id so only the opener can press the button. */
export function guard(prefix, userId) {
  return `${prefix}:${userId}`;
}

/** /map entry — choose which village to visit. */
export function villageKeyboard(userId) {
  return {
    inline_keyboard: [
      [btn('🍃 Hidden Leaf Village', guard('map_village_leaf', userId))],
      [btn('🏜️ Hidden Sand Village', guard('map_village_sand', userId))],
    ],
  };
}

/**
 * Location menu: compact 3–3–2 rows, followed by Close.
 * Omit the rich button style here to use Telegram's compact, rounded neutral
 * surface (dark grey in dark mode), rather than transparent text controls.
 * Other map screens keep their existing styling.
 */
export function mapKeyboard(userId) {
  const locationButton = (text, data) => ({ ...btn(text, data), style: '' });
  return {
    inline_keyboard: [
      [
        locationButton('🏯 Hokage', guard('map_loc_hokage', userId)),
        locationButton('🍜 Ramen', guard('map_loc_ichiraku', userId)),
        locationButton('🍖 BBQ', guard('map_loc_bbq', userId)),
      ],
      [
        locationButton('🥷 Training', guard('map_loc_training', userId)),
        locationButton('🚪 Gate', guard('map_loc_gate', userId)),
        locationButton('🏪 Store', guard('map_loc_store', userId)),
      ],
      [
        locationButton('♨️ Hot Springs', guard('map_loc_hotsprings', userId)),
        locationButton('🗺️ Change Map', guard('map_change', userId)),
      ],
      [locationButton('❌ Close', guard('map_close', userId))],
    ],
  };
}

export function backToMapRow(userId) {
  return [btn('⬅️ Back', guard('map_home', userId))];
}

/** Hokage Office */
export function hokageKeyboard(userId) {
  return {
    inline_keyboard: [
      [
        btn('🏯 Shinobi Mission', guard('map_mission_hub', userId)),
        btn('🎯 Daily Quest', guard('map_daily', userId)),
      ],
      [btn('🎁 Claim All Rewards', guard('map_claim_rewards', userId))],
      backToMapRow(userId),
    ],
  };
}

/**
 * Gate — roster + dispatch entry.
 * `exhausted > 0` adds the BBQ shortcut, which opens the recovery selection
 * window (and, once paid, the patrol picker) without leaving the map.
 */
export function gateKeyboard(userId, { exhausted = 0 } = {}) {
  const rows = [[btn('🚀 Send Available on Patrol', guard('map_patrol_pick', userId))]];
  if (exhausted > 0) rows.push([btn('🍖 Visit BBQ and recover', guard('map_bbq_heal', userId))]);
  rows.push(backToMapRow(userId));
  return { inline_keyboard: rows };
}

export function ichirakuKeyboard(userId) {
  return {
    inline_keyboard: [
      [
        btn('🍜 Ramen', guard('map_ichi_cat_ramen', userId)),
        btn('⚡ Field Meals', guard('map_ichi_cat_field', userId)),
      ],
      [btn('🍱 Pet Food', guard('map_pet_food', userId))],
      backToMapRow(userId),
    ],
  };
}

/** BBQ — chakra recovery + instant exhaustion recovery + pet actions. */
export function bbqKeyboard(userId) {
  return {
    inline_keyboard: [
      [
        btn('🔥 Join BBQ', guard('map_bbq_select', userId)),
        btn('🍱 Feed pet', guard('map_pet_feed', userId)),
      ],
      [btn('⚡ Instant shinobi recovery', guard('map_bbq_heal', userId))],
      [
        btn('🎾 Play with pet', guard('map_pet_play', userId)),
        btn('⬅️ Back', guard('map_home', userId)),
      ],
    ],
  };
}

/** Training Ground — Tsunade trains Sakura, Jiraiya trains Naruto. */
export function trainingKeyboard(userId) {
  return {
    inline_keyboard: [
      [btn('🌸 Sakura Training (Tsunade)', guard('map_train_sakura', userId))],
      [btn('🍥 Naruto Training (Jiraiya)', guard('map_train_naruto', userId))],
      [btn('🐾 Train Pet', guard('map_pet_train', userId))],
      backToMapRow(userId),
    ],
  };
}

/** Hot Springs — relax shinobi (chakra) + rest pet. */
export function hotspringsKeyboard(userId) {
  return {
    inline_keyboard: [
      [
        btn('♨️ Relax shinobis', guard('map_hot_relax', userId)),
        btn('😴 Rest pet', guard('map_pet_rest', userId)),
      ],
      [
        btn('🔄 Recall shinobis', guard('map_hot_recall', userId)),
        btn('⬅️ Back', guard('map_home', userId)),
      ],
    ],
  };
}

/** Stores hub */
export function storeKeyboard(userId) {
  return {
    inline_keyboard: [
      [
        btn('🥷 Shinobi Store', guard('map_open_shinobi_store', userId)),
        btn('🎁 Gift Store', guard('map_open_gift_store', userId)),
      ],
      [
        btn('🐾 Pet Store', guard('map_pet_store', userId)),
        btn('🏠 Property', guard('map_prop_store', userId)),
      ],
      backToMapRow(userId),
    ],
  };
}

export function mapCaption(mentionHtml) {
  return `${mentionHtml}\n\n🗺️ <b>Konoha Map</b>\nChoose a location.`;
}

export function locationCaption(locKey, mentionHtml) {
  const titles = {
    hokage: '🏯 Hokage Office',
    ichiraku: '🍜 Ichiraku Ramen',
    bbq: '🍖 BBQ',
    gate: '🚪 Village Gate',
    training: '🥷 Training Ground',
    hotsprings: '♨️ Hot Springs',
    store: '🏪 Stores',
  };
  return `${mentionHtml}\n\n<b>${titles[locKey] || 'Map'}</b>`;
}
