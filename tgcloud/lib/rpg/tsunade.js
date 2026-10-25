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
import { richHtml } from '../map/rich.js';
import { abilityCheckKeyboard } from '../ability.js';
import { todayKey } from '../economy.js';
import { dueText, istDateTime, istHm, isToday, inRemaining } from './time.js';
import { P, quote } from '../rich.js';
import {
  ensureShinobiState,
} from './state.js';
import {
  SEARCH_DURATION_SEC, SEARCH_MAX_PER_DAY, SEARCH_CHAKRA_COST, EXHAUSTION_RECOVERY_SEC, tsunadeFound,
} from './levels.js';

/** Storage-channel media supplied for the discovery message. */
const TSUNADE_MEDIA_CHAT_ID = -1003889508991;
const TSUNADE_MEDIA_MESSAGE_ID = 31;

/** The discovery line exactly as it is sent (styled on the way out). */
export const TSUNADE_DISCOVERY_TEXT = '🐌 Lady Tsunade was found drinking sake and gambling 🤣';

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

// Bold (math-sans) digits: the requested card prints every time in bold.
const BOLD_DIGITS = ['𝟎', '𝟏', '𝟐', '𝟑', '𝟒', '𝟓', '𝟔', '𝟕', '𝟖', '𝟗'];
const boldDigits = (text) => String(text).replace(/\d/g, (d) => BOLD_DIGITS[Number(d)]);

const SEARCH_PROGRESS_HEADING = '🔎 𝐒𝐄𝐀𝐑𝐂𝐇 𝐈𝐍 𝐏𝐑𝐎𝐆𝐑𝐄𝐒𝐒';

/** "2h 26m" / "26m" / "45s" — no "in" prefix, the card labels it itself. */
function searchTimeLeft(endsAt, t) {
  const total = Math.max(0, Math.floor(endsAt - t));
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m`;
  return `${total % 60}s`;
}

/**
 * "SEARCH IN PROGRESS" card — the heading stays outside, the divider and every
 * line below it are quoted (requested layout):
 *
 *   🔎 𝐒𝐄𝐀𝐑𝐂𝐇 𝐈𝐍 𝐏𝐑𝐎𝐆𝐑𝐄𝐒𝐒
 *   ───────────────
 *   > 🍥 ɴᴀʀᴜᴛᴏ ᴀɴᴅ 🐸 ᴊɪʀᴀɪʏᴀ ᴀʀᴇ ᴏɴ ᴛʜᴇ ʜᴜɴᴛ ꜰᴏʀ ʟᴀᴅʏ ᴛꜱᴜɴᴀᴅᴇ!
 *   > ⏳ 𝐂𝐎𝐌𝐏𝐋𝐄𝐓𝐄𝐒 𝐀𝐓 𝟏𝟒:𝟑𝟎 𝐈𝐒𝐓
 *   > 🕒 ᴛɪᴍᴇ ʟᴇꜰᴛ: 𝟐ʜ 𝟐𝟲ᴍ
 */
export function searchProgressContent(row, t = now()) {
  // "IST" stays in bold uppercase (style() would small-cap plain ASCII).
  const stamp = isToday(row.endsAt, t)
    ? istHm(row.endsAt)
    : istDateTime(row.endsAt).replace(/ IST$/, '');
  const finish = `${boldDigits(stamp)} 𝐈𝐒𝐓`;
  const left = boldDigits(searchTimeLeft(row.endsAt, t));
  const lines = [
    '🍥 Naruto and 🐸 Jiraiya are on the hunt for Lady Tsunade!',
    `⏳ 𝐂𝐎𝐌𝐏𝐋𝐄𝐓𝐄𝐒 𝐀𝐓 ${finish}`,
    `🕒 time left: ${left}`,
  ];
  return {
    blocks: [P(SEARCH_PROGRESS_HEADING), { type: 'divider' }, quote(lines.join('\n'))],
    // Classic fallback: same words, no rich divider.
    text: `${SEARCH_PROGRESS_HEADING}\n\n<blockquote>${style(lines.join('\n\n'))}</blockquote>`,
  };
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
 * Returns an HTML body string, or { blocks, text } for the rich in-progress
 * card (the caller sends the blocks and keeps `text` as the classic fallback).
 */
export async function handleSearchTsuna(message) {
  const user = message.from;
  const id = user.id;
  const own = await ownedSet(id);
  if (!own.has('Naruto') || !own.has('Jiraiya')) {
    return `🔎 𝐒𝐄𝐀𝐑𝐂𝐇 𝐋𝐎𝐂𝐊𝐄𝐃\n\nYou need both ${escapeHtml('Naruto Uzumaki')} and ${escapeHtml('Jiraiya')} on your roster to search for Lady Tsunade.`;
  }

  let row = await searchRow(id);
  const t = now();

  // Already discovered — searches are permanently disabled.
  if (row && row.found) {
    return `🐌 𝐋𝐀𝐃𝐘 𝐓𝐒𝐔𝐍𝐀𝐃𝐄 𝐈𝐒 𝐇𝐄𝐑𝐄\n\nTsunade has already joined your roster.\nShe trains Sakura at /map → Training Ground.`;
  }

  // Finished session awaiting check → resolve it now (exactly once).
  if (row && row.status === 'active' && row.endsAt <= t) {
    const result = await resolveSearch(id, row, user);
    return result;
  }

  // Active session → the rich status card (works in DM and groups).
  if (row && row.status === 'active') {
    return searchProgressContent(row, t);
  }

  // Starting a new search is group-only
  if (message.chat && message.chat.type === 'private') {
    return `🔎 𝐒𝐄𝐀𝐑𝐂𝐇 𝐆𝐑𝐎𝐔𝐏 𝐎𝐍𝐋𝐘\n\nStarting a Tsunade search works in groups only.\n\n» Use /search_tsuna in a group where I am a member.\nYou can still check an active search status from DM.`;
  }

  // Start a new session — max 2 starts per IST day. Naruto & Jiraiya must
  // not be mid-activity when the search begins.
  for (const n of ['Naruto', 'Jiraiya']) {
    const a = await db.get(sql`
      SELECT status FROM activities WHERE telegram_id = ${id} AND shinobi = ${n} AND status = 'active'
    `);
    if (a) {
      return `🔎 ${escapeHtml(n)} is still on an activity.\n\n» Wait for the return, then start the search.`;
    }
  }
  const today = todayKey();
  const dayCount = row && row.dayKey === today ? (row.dayCount || 0) : 0;
  if (dayCount >= SEARCH_MAX_PER_DAY) {
    return `⏳ 𝐃𝐀𝐈𝐋𝐘 𝐋𝐈𝐌𝐈𝐓\n\nThe search may be started twice per day.\n\n» Come back tomorrow (next start available after 12:00 AM IST).`;
  }

  // Chakra cost — checked first so the player gets a clear message.
  const haveChakra = await chakraQty(id);
  if (haveChakra < SEARCH_CHAKRA_COST) {
    return `「𝐂𝐇𝐀𝐊𝐑𝐀 𝐃𝐄𝐏𝐋𝐄𝐓𝐄𝐃」\n\nRequired: chakra x ${SEARCH_CHAKRA_COST} ⚡\nAvailable: chakra x ${haveChakra} ⚡\n\n» Use /claim or /buy chakra 100.`;
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
    return searchProgressContent(row, t);
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
    return `「𝐂𝐇𝐀𝐊𝐑𝐀 𝐃𝐄𝐏𝐋𝐄𝐓𝐄𝐃」\n\nRequired: chakra x ${SEARCH_CHAKRA_COST} ⚡\nAvailable: chakra x ${await chakraQty(id)} ⚡\n\n» Use /claim or /buy chakra 100.`;
  }

  // Message format (styled by caller via style()):
  // 🔎 𝐒𝐄𝐀𝐑𝐂𝐇 𝐁𝐄𝐆𝐔𝐍
  // ɴᴀʀᴜᴛᴏ ᴀɴᴅ ᴊɪʀᴀɪʏᴀ ʟᴇꜰᴛ konoha village to ꜱᴇᴀʀᴄʜ ꜰᴏʀ ʟᴀᴅʏ ᴛꜱᴜɴᴀᴅᴇ.
  // 🎯 ᴇxᴘᴇᴄᴛᴇᴅ ꜰɪɴɪꜱʜ: 20 ᴏᴄᴛ, 01:45 ɪꜱᴛ (ɪɴ 6ʜ 00ᴍ)
  // ⏳ ᴛɪᴍᴇ ʀᴇᴍᴀɪɴɪɴɢ: 6 ʜᴏᴜʀꜱ
  // Check in again at {exact time}.
  const finishStamp = istDateTime(endsAt);
  return (
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
    return `🔎 the search is still in progress.`;
  }

  const attempts = row.totalSearches || 1;
  const found = tsunadeFound(attempts);

  if (!found) {
    // Post-search states: Jiraiya exhausted; Naruto available. No owned
    // Tsunade exists, so no Tsunade exhaustion is created.
    await exhaustJiraiya(id);
    return `🔎 𝐒𝐄𝐀𝐑𝐂𝐇 𝐑𝐄𝐒𝐔𝐋𝐓\n\nNaruto and Jiraiya returned empty-handed — no sign of Lady Tsunade.\n(search #${attempts} of 10)\n\n🐸 Jiraiya is exhausted — ready at ${dueText(now() + EXHAUSTION_RECOVERY_SEC)}.\n🍥 Naruto is available again.`;
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

  await sendTsunadeDiscovery(id, user || { id, first_name: 'Shinobi' });
  return `🐌 Lady Tsunade was found drinking sake and gambling 🤣\n\n🐸 Jiraiya is exhausted — ready at ${dueText(now() + EXHAUSTION_RECOVERY_SEC)}.\n🐌 Tsunade is exhausted — ready at ${dueText(now() + EXHAUSTION_RECOVERY_SEC)}.\n🍥 Naruto is available again.`;
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

/** Rich-message media id used for the embedded figure. */
const TSUNADE_PHOTO_ID = 'tsunade_photo';

/**
 * Discovery message: the storage-channel photo embedded in a rich message
 * (`<figure>` + `media`, exactly like /map) with the `Check ❄️ ability` button
 * for Tsunade's guide post. The single `<p>` keeps the caption on one line with
 * no paragraph margins — the same compact layout as the Jiraiya discovery.
 */
export function tsunadeDiscoveryRich(user, fileId = null) {
  const caption = render(user, TSUNADE_DISCOVERY_TEXT);
  const body = `<p>${String(caption).split('\n').join('<br/>')}</p>`;
  const figure = fileId
    ? `<figure><img src="tg://photo?id=${TSUNADE_PHOTO_ID}"/></figure>`
    : '';
  return {
    html: `${figure}${richHtml(body, abilityCheckKeyboard('Tsunade'))}`,
    ...(fileId ? { media: [{ id: TSUNADE_PHOTO_ID, media: { type: 'photo', media: fileId } }] } : {}),
  };
}

const log = (label, e) => console.error(`[${label}]`, e?.description || e?.message || e);

/**
 * Discovery media post (storage channel copy strategy, same as map photos).
 * Exported so the owner preview (`/testT`) sends the identical message.
 *
 * Per chat: rich message with the embedded photo + rich click button, then the
 * same rich message without the photo, then a classic photo with an inline
 * button, then plain text. Returns true when something was delivered.
 */
export async function sendTsunadeDiscovery(chatId, user) {
  const text = render(user, TSUNADE_DISCOVERY_TEXT);
  const keyboard = abilityCheckKeyboard('Tsunade');
  const button = keyboard ? { reply_markup: keyboard } : {};
  const fileId = await getMapPhotoFileId(chatId, TSUNADE_MEDIA_MESSAGE_ID);

  if (fileId) {
    try {
      await api.sendRichMessage({
        chat_id: chatId,
        rich_message: tsunadeDiscoveryRich(user, fileId),
      });
      return true;
    } catch (e) {
      log('tsunade rich media', e);
    }
  }
  try {
    await api.sendRichMessage({
      chat_id: chatId,
      rich_message: tsunadeDiscoveryRich(user),
    });
    return true;
  } catch (e) {
    log('tsunade rich', e);
  }
  if (fileId) {
    try {
      await api.sendPhoto({
        chat_id: chatId,
        photo: fileId,
        caption: style(text),
        parse_mode: 'HTML',
        ...button,
      });
      return true;
    } catch (e) {
      log('tsunade media', e);
    }
  }
  try {
    await send(chatId, { text, parse_mode: 'HTML', ...button });
    return true;
  } catch (e) {
    log('tsunade discovery', e);
  }
  return false;
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
