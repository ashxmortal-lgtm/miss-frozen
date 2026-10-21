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

/** Home map — 4 rows as specified. */
export function mapKeyboard(userId) {
  return {
    inline_keyboard: [
      [
        btn('🏯 Hokage Office', guard('map_loc_hokage', userId)),
        btn('🍖 BBQ', guard('map_loc_bbq', userId)),
      ],
      [
        btn('🍜 Ichiraku Ramen', guard('map_loc_ichiraku', userId)),
        btn('🚪 Gate', guard('map_loc_gate', userId)),
      ],
      [
        btn('🥷 Training Ground', guard('map_loc_training', userId)),
        btn('🏪 Stores', guard('map_loc_store', userId)),
      ],
      [btn('♨️ Hot Springs', guard('map_loc_hotsprings', userId))],
      [btn('❌ Close', guard('map_close', userId))],
    ],
  };
}

export function backToMapRow(userId) {
  return [btn('← Back', guard('map_home', userId))];
}

/** Hokage Office */
export function hokageKeyboard(userId) {
  return {
    inline_keyboard: [
      [
        btn('Shinobi Mission', guard('map_mission_hub', userId)),
        btn('Daily Quest', guard('map_daily', userId)),
      ],
      [btn('Claim All Rewards', guard('map_claim_rewards', userId))],
      backToMapRow(userId),
    ],
  };
}

/** Gate — roster + dispatch entry */
export function gateKeyboard(userId) {
  return {
    inline_keyboard: [
      [btn('Send Available on Patrol', guard('map_patrol_pick', userId))],
      backToMapRow(userId),
    ],
  };
}

export function ichirakuKeyboard(userId) {
  return {
    inline_keyboard: [
      [
        btn('🍜 Ramen', guard('map_ichi_cat_ramen', userId)),
        btn('⚡ Field Meals', guard('map_ichi_cat_field', userId)),
      ],
      backToMapRow(userId),
    ],
  };
}

/** BBQ — chakra recovery + instant exhaustion recovery */
export function bbqKeyboard(userId) {
  return {
    inline_keyboard: [
      [
        btn('Send to BBQ', guard('map_bbq_select', userId)),
        btn('Recall', guard('map_bbq_recall', userId)),
      ],
      [btn('🔥 Heal Exhaustion (200 🍥 each)', guard('map_bbq_heal', userId))],
      backToMapRow(userId),
    ],
  };
}

/** Training Ground — Tsunade trains Sakura, Jiraiya trains Naruto. */
export function trainingKeyboard(userId) {
  return {
    inline_keyboard: [
      [btn('🌸 Sakura Training (Tsunade)', guard('map_train_sakura', userId))],
      [btn('🍥 Naruto Training (Jiraiya)', guard('map_train_naruto', userId))],
      backToMapRow(userId),
    ],
  };
}

export function hotspringsKeyboard(userId) {
  return {
    inline_keyboard: [backToMapRow(userId)],
  };
}

/** Stores hub */
export function storeKeyboard(userId) {
  return {
    inline_keyboard: [
      [
        btn('Shinobi Store', guard('map_open_shinobi_store', userId)),
        btn('Gift Store', guard('map_open_gift_store', userId)),
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
