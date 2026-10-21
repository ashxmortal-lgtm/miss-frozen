/**
 * Hidden Tsunade discovery — /search_tsuna.
 * Requires Naruto + Jiraiya on the roster. Each session lasts 6 hours and
 * costs 600 chakra (charged when the search starts); up to 2 sessions may
 * START per IST day. There is no scheduler and no
 * automatic completion report: the user invokes /search_tsuna again to
 * resolve a finished session. Timestamps are persisted (restart-safe).
 *
 * Discovery roll mirrors the existing Jiraiya formula (activities.jiraiyaFound):
 * escalating odds, guaranteed by the 10th completed search.
 */

import { db } from 'sdk';
import { sql } from 'sdk/db';
import { api } from '../message_api.js';
import { render, style, escapeHtml, mention } from '../texts.js';
import { send } from '../chat.js';
import { getMapPhotoFileId } from '../map/media.js';
import { todayKey } from '../economy.js';
import { dueText, istDateTime, inRemaining } from './time.js';
import {
  ensureShinobiState,
} from './state.js';
import {
  SEARCH_DURATION_SEC, SEARCH_MAX_PER_DAY, SEARCH_CHAKRA_COST, EXHAUSTION_RECOVERY_SEC, tsunadeFound,
} from './levels.js';

/** Storage-channel media supplied for the discovery message. */
const TSUNADE_MEDIA_CHAT_ID = -1003889508991;
const TSUNADE_MEDIA_MESSAGE_ID = 31;

const now = () => Math.floor(Date.now() / 1000);

async function ownedSet(telegramId) {
  const rows = await db.all(sql`
    SELECT item_name FROM inventory
    WHERE telegram_id = ${telegramId} AND item_type = 'shinobi'
  `);
  return new Set((rows || []).map((r) => r.item_name));
}

async function chakraQty(telegramId) {
  const r = await db.get(sql`
    SELECT qty FROM inventory WHERE telegram_id = ${telegramId} AND item_name = 'Chakra'
  `);
  return r ? r.qty : 0;
}

export async function searchRow(telegramId) {
  return db.get(sql`
    SELECT status, started_at AS startedAt, ends_at AS endsAt, day_key AS dayKey,
           day_count AS dayCount, total_searches AS totalSearches, found, found_at AS foundAt
    FROM tsunade_search WHERE telegram_id = ${telegramId}
  `);
}

/**
 * /search_tsuna — start a session or check/resolve a finished one.
 * Returns { body } (HTML body; caller prepends nothing — mention included).
 */
export async function handleSearchTsuna(message) {
  const user = message.from;
  const id = user.id;
  const own = await ownedSet(id);
  if (!own.has('Naruto') || !own.has('Jiraiya')) {
    return `${mention(user)}\n\n🔎 𝐒𝐄𝐀𝐑𝐂𝐇 𝐋𝐎𝐂𝐊𝐄𝐃\n\nYou need both ${escapeHtml('Naruto Uzumaki')} and ${escapeHtml('Jiraiya')} on your roster to search for Lady Tsunade.`;
  }

  let row = await searchRow(id);
  const t = now();

  // Already discovered — searches are permanently disabled.
  if (row && row.found) {
    return `${mention(user)}\n\n🐌 𝐋𝐀𝐃𝐘 𝐓𝐒𝐔𝐍𝐀𝐃𝐄 𝐈𝐒 𝐇𝐄𝐑𝐄\n\nTsunade has already joined your roster.\nShe trains Sakura at /map → Training Ground.`;
  }

  // Finished session awaiting check → resolve it now (exactly once).
  if (row && row.status === 'active' && row.endsAt <= t) {
    const result = await resolveSearch(id, row, user);
    return result;
  }

  // Active session → status report (works in DM and groups).
  if (row && row.status === 'active') {
    return `${mention(user)}\n\n🔎 𝐒𝐄𝐀𝐑𝐂𝐇 𝐈𝐍 𝐏𝐑𝐎𝐆𝐑𝐄𝐒𝐒\n\nNaruto and Jiraiya are searching for Lady Tsunade.\n\n⏳ completes at ${dueText(row.endsAt, t)}\n(search #${row.totalSearches})\n\n❄️ Check back at ${dueText(row.endsAt, t)} — invoke /search_tsuna again after it finishes.`;
  }

  // Starting a new search is group-only
  if (message.chat && message.chat.type === 'private') {
    return `${mention(user)}\n\n🔎 𝐒𝐄𝐀𝐑𝐂𝐇 𝐆𝐑𝐎𝐔𝐏 𝐎𝐍𝐋𝐘\n\nStarting a Tsunade search works in groups only.\n\n» Use /search_tsuna in a group where I am a member.\nYou can still check an active search status from DM.`;
  }

  // Start a new session — max 2 starts per IST day. Naruto & Jiraiya must
  // not be mid-activity when the search begins.
  for (const n of ['Naruto', 'Jiraiya']) {
    const a = await db.get(sql`
      SELECT status FROM activities WHERE telegram_id = ${id} AND shinobi = ${n} AND status = 'active'
    `);
    if (a) {
      return `${mention(user)}\n\n🔎 ${escapeHtml(n)} is still on an activity.\n\n» Wait for the return, then start the search.`;
    }
  }
  const today = todayKey();
  const dayCount = row && row.dayKey === today ? (row.dayCount || 0) : 0;
  if (dayCount >= SEARCH_MAX_PER_DAY) {
    return `${mention(user)}\n\n⏳ 𝐃𝐀𝐈𝐋𝐘 𝐋𝐈𝐌𝐈𝐓\n\nThe search may be started twice per day.\n\n» Come back tomorrow (next start available after 12:00 AM IST).`;
  }

  // Chakra cost — checked first so the player gets a clear message.
  const haveChakra = await chakraQty(id);
  if (haveChakra < SEARCH_CHAKRA_COST) {
    return `${mention(user)}\n\n「𝐂𝐇𝐀𝐊𝐑𝐀 𝐃𝐄𝐏𝐋𝐄𝐓𝐄𝐃」\n\nRequired: chakra x ${SEARCH_CHAKRA_COST} ⚡\nAvailable: chakra x ${haveChakra} ⚡\n\n» Use /claim or /buy chakra 100.`;
  }

  const startsAt = t;
  const endsAt = t + SEARCH_DURATION_SEC;
  // Guarded claim on the single row per user.
  await db.run(sql`INSERT OR IGNORE INTO tsunade_search (telegram_id) VALUES (${id})`);
  const won = await db.run(sql`
    UPDATE tsunade_search
    SET status = 'active', started_at = ${startsAt}, ends_at = ${endsAt},
        day_key = ${today}, day_count = ${dayCount + 1},
        total_searches = COALESCE(total_searches, 0) + 1
    WHERE telegram_id = ${id} AND (status != 'active' OR ends_at <= ${t})
  `);
  if (won.rowsAffected === 0) {
    row = await searchRow(id);
    return `${mention(user)}\n\n🔎 𝐒𝐄𝐀𝐑𝐂𝐇 𝐈𝐍 𝐏𝐑𝐎𝐆𝐑𝐄𝐒𝐒\n\n⏳ completes at ${dueText(row.endsAt, t)}`;
  }

  // Charge chakra after the session is claimed (so a duplicate request can
  // never pay twice). If the guarded charge fails, roll the session back.
  const paid = await db.run(sql`
    UPDATE inventory SET qty = qty - ${SEARCH_CHAKRA_COST}
    WHERE telegram_id = ${id} AND item_name = 'Chakra' AND qty >= ${SEARCH_CHAKRA_COST}
  `);
  if (paid.rowsAffected === 0) {
    await db.run(sql`
      UPDATE tsunade_search
      SET status = 'done', day_count = MAX(0, COALESCE(day_count, 0) - 1),
          total_searches = MAX(0, COALESCE(total_searches, 0) - 1)
      WHERE telegram_id = ${id} AND status = 'active' AND started_at = ${startsAt}
    `);
    return `${mention(user)}\n\n「𝐂𝐇𝐀𝐊𝐑𝐀 𝐃𝐄𝐏𝐋𝐄𝐓𝐄𝐃」\n\nRequired: chakra x ${SEARCH_CHAKRA_COST} ⚡\nAvailable: chakra x ${await chakraQty(id)} ⚡\n\n» Use /claim or /buy chakra 100.`;
  }

  // Message format (styled by caller via style()):
  // 🔎 𝐒𝐄𝐀𝐑𝐂𝐇 𝐁𝐄𝐆𝐔𝐍
  // ɴᴀʀᴜᴛᴏ ᴀɴᴅ ᴊɪʀᴀɪʏᴀ ʟᴇꜰᴛ konoha village to ꜱᴇᴀʀᴄʜ ꜰᴏʀ ʟᴀᴅʏ ᴛꜱᴜɴᴀᴅᴇ.
  // 🎯 ᴇxᴘᴇᴄᴛᴇᴅ ꜰɪɴɪꜱʜ: 20 ᴏᴄᴛ, 01:45 ɪꜱᴛ (ɪɴ 6ʜ 00ᴍ)
  // ⏳ ᴛɪᴍᴇ ʀᴇᴍᴀɪɴɪɴɢ: 6 ʜᴏᴜʀꜱ
  // Check in again at {exact time}.
  const finishStamp = istDateTime(endsAt);
  return (
    `${mention(user)}\n\n` +
    `🔎 𝐒𝐄𝐀𝐑𝐂𝐇 𝐁𝐄𝐆𝐔𝐍\n` +
    `Naruto and Jiraiya left konoha village to search for Lady Tsunade.\n\n` +
    `🎯 expected finish: ${finishStamp} (${inRemaining(endsAt, t)})\n` +
    `⏳ time remaining: 6 hours\n` +
    `Check in again at ${finishStamp}.`
  );
}

/**
 * Resolve a finished session exactly once (status flip guards duplicates):
 * roll discovery, apply post-search states (Jiraiya + discovered Tsunade
 * exhausted; Naruto available), and return the result body.
 */
async function resolveSearch(id, row, user) {
  const won = await db.run(sql`
    UPDATE tsunade_search SET status = 'done'
    WHERE telegram_id = ${id} AND status = 'active' AND ends_at <= ${now()}
  `);
  if (won.rowsAffected === 0) {
    return `${mention(user)}\n\n🔎 the search is still in progress.`;
  }

  const attempts = row.totalSearches || 1;
  const found = tsunadeFound(attempts);

  if (!found) {
    // Post-search states: Jiraiya exhausted; Naruto available. No owned
    // Tsunade exists, so no Tsunade exhaustion is created.
    await exhaustJiraiya(id);
    return `${mention(user)}\n\n🔎 𝐒𝐄𝐀𝐑𝐂𝐇 𝐑𝐄𝐒𝐔𝐋𝐓\n\nNaruto and Jiraiya returned empty-handed — no sign of Lady Tsunade.\n(search #${attempts} of 10)\n\n🐸 Jiraiya is exhausted — ready at ${dueText(now() + EXHAUSTION_RECOVERY_SEC)}.\n🍥 Naruto is available again.`;
  }

  // Discovery: grant Tsunade (hidden — never sold in the Shinobi Store).
  await db.run(sql`
    INSERT OR IGNORE INTO inventory (telegram_id, item_type, item_name, qty)
    VALUES (${id}, 'shinobi', 'Tsunade', 1)
  `);
  await db.run(sql`
    UPDATE tsunade_search SET found = 1, found_at = ${now()} WHERE telegram_id = ${id}
  `);
  await exhaustJiraiya(id);
  await exhaustTsunade(id);

  await sendDiscoveryMessage(id, user || { id, first_name: 'Shinobi' });
  return `${mention(user)}\n\n🐌 Lady Tsunade was found drinking sake and gambling 🤣\n\n🐸 Jiraiya is exhausted — ready at ${dueText(now() + EXHAUSTION_RECOVERY_SEC)}.\n🐌 Tsunade is exhausted — ready at ${dueText(now() + EXHAUSTION_RECOVERY_SEC)}.\n🍥 Naruto is available again.`;
}

async function exhaustJiraiya(id) {
  await ensureShinobiState(id, 'Jiraiya');
  await db.run(sql`
    UPDATE shinobi_state SET exhausted_until = ${now() + EXHAUSTION_RECOVERY_SEC}, patrol_streak = 0
    WHERE telegram_id = ${id} AND shinobi = 'Jiraiya'
  `);
}

async function exhaustTsunade(id) {
  await ensureShinobiState(id, 'Tsunade');
  await db.run(sql`
    UPDATE shinobi_state SET exhausted_until = ${now() + EXHAUSTION_RECOVERY_SEC}, patrol_streak = 0
    WHERE telegram_id = ${id} AND shinobi = 'Tsunade'
  `);
}

/** Discovery media post (storage channel copy strategy, same as map photos). */
async function sendDiscoveryMessage(chatId, user) {
  const text = render(user, '🐌 Lady Tsunade was found drinking sake and gambling 🤣');
  const fileId = await getMapPhotoFileId(chatId, TSUNADE_MEDIA_MESSAGE_ID);
  if (fileId) {
    try {
      await api.sendPhoto({
        chat_id: chatId,
        photo: fileId,
        caption: style(text),
        parse_mode: 'HTML',
      });
      return;
    } catch (e) {
      console.error('[tsunade media]', e?.description || e);
    }
  }
  try {
    await send(chatId, { text, parse_mode: 'HTML' });
  } catch (e) {
    console.error('[tsunade discovery]', e?.description || e);
  }
}

export async function sweepTsunadeSearches() {
  const t = now();
  const due = await db.all(sql`
    SELECT telegram_id, total_searches, status, ends_at FROM tsunade_search
    WHERE status = 'active' AND ends_at <= ${t} LIMIT 10
  `);
  for (const row of due || []) {
    try {
      const u = await db.get(sql`SELECT first_name, username FROM users WHERE telegram_id = ${row.telegram_id}`);
      const user = { id: row.telegram_id, first_name: u?.first_name || 'Shinobi', username: u?.username };
      const report = await resolveSearch(row.telegram_id, { totalSearches: row.total_searches || 1 }, user);
      if (report) {
        await send(row.telegram_id, { text: style(report), parse_mode: 'HTML' });
      }
    } catch (e) {
      console.error('[sweepTsunadeSearches]', e);
    }
  }
}
