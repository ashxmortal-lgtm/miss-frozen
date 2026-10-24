import { db } from 'sdk';
import { sql } from 'sdk/db';
import { fmt } from './store.js';
import { escapeHtml, mention } from './texts.js';
import { dueText } from './rpg/time.js';
import {
  getShinobiState, isExhausted, recordPatrolCompletion, resetPatrolStreak,
} from './rpg/state.js';
import { addPendingReward, pendingRewardTotal } from './map/pending.js';
import { jiraiyaFound, sakuraActivityBonus } from './rpg/levels.js';
import {
  petRewardBonus, petShinobiXpMultiplier, petTimeReduction, ensurePetSchema,
  settlePetActivities,
} from './pet/store.js';
import { reducedActivitySeconds, reducedCooldownSeconds } from './pet/defs.js';
import { activityCompleteText } from './pet/text.js';
import { notifyDailyProgress } from './daily.js';
import { restingShinobi, applyBbqRecovery } from './map/bbq.js';

const H = 3600;
export const KINDS = {
  mission: {
    word: 'mission',
    eligible: ['Sasuke', 'Naruto'], choose: 'Sasuke or Naruto',
    duration: 3 * H, cooldown: 6 * H, xpMin: 50, xpMax: 150, chakra: 100,
    min: 300, max: 300,
    done: '𝐌𝐈𝐒𝐒𝐈𝐎𝐍 𝐂𝐎𝐌𝐏𝐋𝐄𝐓𝐄', doneLine: '𝑨 𝒎𝒊𝒔𝒔𝒊𝒐𝒏 𝒘𝒆𝒍𝒍 𝒅𝒐𝒏𝒆, 𝒔𝒉𝒊𝒏𝒐𝒃𝒊.',
    inel: '𝐌𝐈𝐒𝐒𝐈𝐎𝐍 𝐈𝐍𝐄𝐋𝐈𝐆𝐈𝐁𝐋𝐄',
  },
  patrol: {
    word: 'patrol',
    // Sakura may patrol the village but never undertakes missions.
    eligible: ['Naruto', 'Starter Shinobi', 'Hinata', 'Sakura'], choose: 'Naruto, Starter Shinobi, Hinata, or Sakura',
    duration: 1 * H, cooldown: 0, xpMin: 50, xpMax: 150, chakra: 0,   // set to 2 * H for 120 minutes
    min: 100, max: 400,
    done: '𝐏𝐀𝐓𝐑𝐎𝐋 𝐂𝐎𝐌𝐏𝐋𝐄𝐓𝐄', doneLine: '𝑻𝒉𝒆 𝒗𝒊𝒍𝒍𝒂𝒈𝒆 𝒊𝒔 𝒔𝒂𝒇𝒆𝒓 𝒕𝒉𝒂𝒏𝒌𝒔 𝒕𝒐 𝒚𝒐𝒖, 𝒔𝒉𝒊𝒏𝒐𝒃𝒊.',
    inel: '𝐏𝐀𝐓𝐑𝐎𝐋 𝐈𝐍𝐄𝐋𝐈𝐆𝐈𝐁𝐋𝐄',
  },
};

const EMO = {
  Sasuke: '⚔️', Sakura: '🌸', Naruto: '🍥', Itachi: '👁️',
  Hinata: '👁️', Jiraiya: '🐸', 'Starter Shinobi': '🥷',
};

export function bold(s) {
  return Array.from(String(s)).map((ch) => {
    const c = ch.codePointAt(0);
    if (c >= 65 && c <= 90) return String.fromCodePoint(0x1D400 + c - 65);
    if (c >= 97 && c <= 122) return String.fromCodePoint(0x1D41A + c - 97);
    return ch;
  }).join('');
}
const quote = (s) => `<blockquote>${s}</blockquote>`;

// Jiraiya discovery: random, guaranteed within 15 Naruto patrols
// (jiraiyaFound lives in rpg/levels.js). n = completed Naruto patrols.

const NAMES = ['Sasuke', 'Sakura', 'Naruto', 'Itachi', 'Hinata', 'Jiraiya', 'Starter Shinobi'];

const RANKS = [
  [0, 'Academy Student', 100], [500, 'Genin', 110], [1500, 'Chūnin', 120],
  [3500, 'Jōnin', 135], [6500, 'Anbu', 150], [10000, 'Kage', 175],
];
export function rankOf(xp) {
  let r = RANKS[0];
  for (const x of RANKS) if (xp >= x[0]) r = x;
  return r;
}

const now = () => Math.floor(Date.now() / 1000);
const rollBase = (c) => c.min + Math.floor(Math.random() * (c.max - c.min + 1));

function dur(sec) {
  const total = Math.max(0, Math.ceil(sec / 60));
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
function hours(sec) {
  const h = sec / 3600;
  return `${h} hour${h === 1 ? '' : 's'}`;
}

// Order: base -> Naruto x3 -> rank multiplier -> Sakura level bonus.
// Naruto's x3 applies to patrol/mission only (never /claim).
// `sakuraBonus` is the already-rolled Sakura patrol/mission bonus (0 = no Sakura).
function reward(c, shinobi, base, xp, sakuraBonus) {
  let coins = base;
  if (shinobi === 'Naruto') coins *= 3;
  coins = Math.floor((coins * rankOf(xp)[2]) / 100);
  coins += sakuraBonus || 0;
  return coins;
}

function canonical(raw) {
  const k = String(raw || '').trim().toLowerCase().replace(/\s+/g, ' ');
  return NAMES.find((n) => n.toLowerCase() === k) || null;
}

async function ensureUser(id) {
  await db.run(sql`INSERT OR IGNORE INTO users (telegram_id, balance) VALUES (${id}, 0)`);
}
async function owned(id) {
  const rows = await db.all(sql`SELECT item_name FROM inventory WHERE telegram_id = ${id}`);
  return new Set(rows.map((r) => r.item_name));
}
async function chakraQty(id) {
  const r = await db.get(sql`SELECT qty FROM inventory WHERE telegram_id = ${id} AND item_name = 'Chakra'`);
  return r ? r.qty : 0;
}

// Pays ONE finished activity. Only the request that flips active -> idle
// gets a result, so rewards are paid once. Returns null if someone else won.
async function finish(a) {
  const c = KINDS[a.kind];
  const id = a.telegram_id;
  const t = now();
  const cooldownSec = Number(a.cooldown_sec || 0) || c.cooldown;
  const won = a.kind === 'mission'
    ? await db.run(sql`UPDATE activities SET status = 'idle', cooldown_until = ${a.ends_at + cooldownSec} WHERE telegram_id = ${id} AND shinobi = ${a.shinobi} AND status = 'active' AND ends_at <= ${t}`)
    : await db.run(sql`UPDATE activities SET status = 'idle' WHERE telegram_id = ${id} AND shinobi = ${a.shinobi} AND status = 'active' AND ends_at <= ${t}`);
  if (won.rowsAffected === 0) return null;

  // Consecutive-patrol exhaustion (2 patrols → 30 min recovery); missions
  // break the chain. Timestamp-based, so restarts never lose it.
  let exhaustedUntil = 0;
  if (a.kind === 'patrol') {
    try {
      const ex = await recordPatrolCompletion(id, a.shinobi);
      if (ex.exhausted) exhaustedUntil = ex.exhaustedUntil;
    } catch (e) { console.error('[patrol exhaustion]', e); }
  } else {
    try { await resetPatrolStreak(id, a.shinobi); } catch (e) { console.error('[streak reset]', e); }
  }

  const u = await db.get(sql`SELECT xp, first_name, username FROM users WHERE telegram_id = ${id}`);
  const xpBefore = u ? u.xp : 0;
  const own = await owned(id);
  const base = a.base_roll > 0 ? a.base_roll : rollBase(c);
  let sakuraBonus = 0;
  if (own.has('Sakura')) {
    let sakuraLevel = 1;
    try {
      const sk = await getShinobiState(id, 'Sakura');
      sakuraLevel = sk && sk.level ? sk.level : 1;
    } catch (e) { console.error('[sakura level]', e); }
    sakuraBonus = sakuraActivityBonus(sakuraLevel);
  }
  let coins = reward(c, a.shinobi, base, xpBefore, sakuraBonus);
  // Axofly Flutter Fortune: additive reward bonus on the finished activity.
  let petBonus = 0;
  try {
    const fortune = await petRewardBonus(id, coins);
    if (fortune.bonus > 0) {
      petBonus = fortune.bonus;
      coins += petBonus;
    }
  } catch (e) { console.error('[pet activity bonus]', e); }
  // Random 50–150 XP per finished patrol/mission; Axofly adds a flat %.
  let xpGain = c.xpMin + Math.floor(Math.random() * (c.xpMax - c.xpMin + 1));
  try {
    const mult = await petShinobiXpMultiplier(id);
    if (mult > 1) xpGain = Math.floor(xpGain * mult);
  } catch (e) { console.error('[pet xp multiplier]', e); }
  // Coins go to pending (claim at Hokage Office) — only XP is applied immediately.
  await db.run(sql`UPDATE users SET xp = xp + ${xpGain} WHERE telegram_id = ${id}`);
  try {
    await notifyDailyProgress(id, `${a.kind}_complete`,
      `activity:${id}:${a.shinobi}:${a.started_at || a.ends_at}`);
  } catch (e) { console.error('[activity daily]', e); }
  try {
    await addPendingReward(id, a.shinobi, coins, a.kind);
  } catch (e) {
    console.error('[pending reward]', e);
  }

  const before = rankOf(xpBefore)[1];
  const after = rankOf(xpBefore + xpGain)[1];

  let found = false;
  let had = false;
  if (a.kind === 'patrol' && a.shinobi === 'Naruto') {
    await db.run(sql`UPDATE users SET naruto_patrols = naruto_patrols + 1 WHERE telegram_id = ${id}`);
    if (own.has('Jiraiya')) {
      had = true;
    } else {
      const cnt = await db.get(sql`SELECT naruto_patrols AS n FROM users WHERE telegram_id = ${id}`);
      if (jiraiyaFound(cnt ? cnt.n : 0)) {
        const g = await db.run(sql`INSERT OR IGNORE INTO inventory (telegram_id, item_type, item_name, qty) VALUES (${id}, 'shinobi', 'Jiraiya', 1)`);
        found = g.rowsAffected > 0;
      }
    }
  }
  let pendingTotal = 0;
  try { pendingTotal = await pendingRewardTotal(id); } catch (_) {}
  // Capycorn shortens the scheduled activity; the stored window is the truth.
  const planned = Number(c.duration) || 0;
  const actual = Math.max(0, Number(a.ends_at || 0) - Number(a.started_at || 0));
  const timeCutPct = planned > 0 && actual > 0 && actual < planned
    ? Math.round(((planned - actual) / planned) * 100)
    : 0;
  return {
    id, name: (u && u.first_name) || 'Shinobi', username: u ? u.username : null,
    chatId: a.chat_id,
    kind: a.kind, shinobi: a.shinobi, coins, petBonus, sakuraBonus,
    xp: xpGain, timeCutPct,
    rankUp: after !== before ? after : null, found, had, exhaustedUntil,
    pendingTotal,
  };
}

const FOUND = `「𝐋𝐄𝐆𝐄𝐍𝐃𝐀𝐑𝐘 𝐃𝐈𝐒𝐂𝐎𝐕𝐄𝐑𝐘」\n\n🐸 Jiraiya has joined your shinobi roster!\n\n𝑺𝒐𝒎𝒆 𝒑𝒂𝒕𝒓𝒐𝒍𝒔 𝒍𝒆𝒂𝒅 𝒕𝒐 𝒖𝒏𝒆𝒙𝒑𝒆𝒄𝒕𝒆𝒅 𝒎𝒆𝒆𝒕𝒊𝒏𝒈𝒔.\n\n» Check your inventory to see your new shinobi.`;

// The returning user is always mentioned (after the heading, never as the
// leading line), so the reward card is unambiguous in a busy group.
function returningMention(r) {
  return mention({ id: r.id, first_name: r.name, username: r.username });
}

// Active boost breakdown — every value is shown in the currency it pays,
// and Capycorn is named only when it actually shortened this activity.
function boostLines(r) {
  const lines = [];
  if (r.sakuraBonus > 0) lines.push(`🌸 Sakura boost: +${fmt(r.sakuraBonus)} 🍥`);
  if (r.petBonus > 0) lines.push(`🦋 Axofly boost: +${fmt(r.petBonus)} 🍥`);
  if (r.timeCutPct > 0) lines.push(`🦄 Capycorn: −${r.timeCutPct}% ${KINDS[r.kind].word} time`);
  return lines;
}

/**
 * The reward card for a finished patrol/mission. Pure so the exact wording is
 * testable; `reminder` renders the background group version (Jiraiya one-liner
 * instead of the extra "next mission" line).
 */
export function rewardCard(r, { reminder = false } = {}) {
  const emo = EMO[r.shinobi] || '🥷';
  const title = r.kind === 'patrol' ? '🏮 𝐓𝐄𝐀𝐌 𝐏𝐀𝐓𝐑𝐎𝐋 𝐑𝐄𝐓𝐔𝐑𝐍𝐄𝐃' : '⚔️ 𝐌𝐈𝐒𝐒𝐈𝐎𝐍 𝐂𝐎𝐌𝐏𝐋𝐄𝐓𝐄';
  let s = `${title}\n\n`;
  if (r.kind === 'patrol') s += `ʜɪᴅᴅᴇɴ ʟᴇᴀғ ᴠɪʟʟᴀɢᴇ ɪs sᴀғᴇ.\n\n`;
  s += `${returningMention(r)}\n`;
  // The shinobi's reward rows are one quote: coin payout, XP and every boost.
  const rows = [
    `${emo} ${bold(r.shinobi)} → +${fmt(r.coins)} 🍥`,
    `⭐ +${r.xp} xᴘ`,
    ...boostLines(r),
  ];
  if (r.rankUp) rows.push(`🏅 Rank up: ${r.rankUp}`);
  s += `${quote(rows.join('\n'))}\n`;
  if (reminder && r.found) s += `\n🐸 Jiraiya joined your roster!\n`;
  // The pending balance gets its own quote — the claim itself is a button now.
  if (r.pendingTotal > 0) s += `\n${quote(`🍥 𝐏𝐞𝐧𝐝𝐢𝐧𝐠 𝐭𝐨𝐭𝐚𝐥: ${fmt(r.pendingTotal)} ᴋᴏɴᴏʜᴀ ᴄᴏɪɴs`)}\n`;
  if (r.exhaustedUntil) s += `\n🔥 ${r.shinobi} is exhausted — ready at ${dueText(r.exhaustedUntil)}.\n`;
  if (!reminder && r.kind === 'mission') s += `\n⏳ Next mission available in: ${hours(KINDS.mission.cooldown)}\n`;
  if (!reminder && r.had) s += `\n𝑱𝒊𝒓𝒂𝒊𝒚𝒂 𝒊𝒔 𝒂𝒍𝒓𝒆𝒂𝒅𝒚 𝒑𝒂𝒓𝒕 𝒐𝒇 𝒚𝒐𝒖𝒓 𝒓𝒐𝒔𝒕𝒆𝒓.\n`;
  return s.replace(/\n+$/, '');
}
function fullText(r) { return rewardCard(r); }
// Group reminder — same card, mention included so the caller need not add it.
function remindText(r) { return rewardCard(r, { reminder: true }); }

// Short DM.
function dmText(r) {
  const emo = EMO[r.shinobi] || '🥷';
  let s = `✅ ${KINDS[r.kind].done}\n\n${emo} ${r.shinobi} returned.\n🍥 +${fmt(r.coins)} (pending)  ·  ✦ XP +${r.xp}`;
  if (r.found) s += `\n🐸 Jiraiya joined your roster!`;
  if (r.exhaustedUntil) s += `\n🔥 Exhausted until ${dueText(r.exhaustedUntil)}.`;
  // The claim itself is the "claim 🍥 reward" button under this DM.
  return s;
}

// Finished activities of ONE user (shown in their own reply).
// Also exported so opening the Gate/Inventory refreshes statuses first.
export async function settleOwn(user) {
  const t = now();
  const due = await db.all(sql`
    SELECT telegram_id, shinobi, kind, started_at, ends_at, base_roll, cooldown_sec, chat_id
    FROM activities
    WHERE telegram_id = ${user.id} AND status = 'active' AND kind <> 'pet' AND ends_at <= ${t}
    ORDER BY ends_at ASC
  `);
  const blocks = [];
  const dms = [];
  for (const a of due) {
    let r = null;
    try {
      r = await finish(a);
    } catch (e) {
      // One broken row must never hide the other returns.
      console.error('[settle own]', e);
      try {
        await db.run(sql`
          UPDATE activities SET status = 'idle'
          WHERE telegram_id = ${a.telegram_id} AND shinobi = ${a.shinobi}
            AND status = 'active' AND ends_at <= ${t}
        `);
      } catch (e2) { console.error('[settle own repair]', e2); }
    }
    if (!r) continue;
    blocks.push(fullText(r));
    if (r.found) blocks.push(FOUND);
    dms.push(dmText(r));
  }
  return { blocks, dms };
}

// Finished activities of ALL users. Called on every incoming message
// (no scheduler), so reminders arrive when the bot is next used.
export async function sweepActivities() {
  try { await ensurePetSchema(); } catch (_) {}
  const t = now();
  // Oldest first: a busy bot can never starve an old return behind newer rows.
  const due = await db.all(sql`
    SELECT telegram_id, shinobi, kind, started_at, ends_at, base_roll, cooldown_sec, chat_id
    FROM activities
    WHERE status = 'active' AND kind <> 'pet' AND ends_at <= ${t}
    ORDER BY ends_at ASC LIMIT 10
  `);
  const out = [];
  for (const a of due) {
    let r = null;
    try {
      r = await finish(a);
    } catch (e) {
      console.error('[sweep activities]', e);
      try {
        await db.run(sql`
          UPDATE activities SET status = 'idle'
          WHERE telegram_id = ${a.telegram_id} AND shinobi = ${a.shinobi}
            AND status = 'active' AND ends_at <= ${t}
        `);
      } catch (e2) { console.error('[sweep repair]', e2); }
    }
    if (!r) continue;
    out.push({ id: r.id, name: r.name, chatId: r.chatId, kind: r.kind, reminder: remindText(r), dm: dmText(r) });
  }
  // Pet activities are stored in pet_activity; settle them lazily here so a
  // Shinobi is freed and XP is paid even if the owner never reopens /pet.
  try {
    const pending = await db.all(sql`
      SELECT DISTINCT telegram_id, chat_id FROM pet_activity
      WHERE status = 'active'
        AND ((ends_at > 0 AND ends_at <= ${t})
          OR (activity_type = 'rest' AND ends_at = 0 AND started_at <= ${t - 30 * 60}))
      LIMIT 10
    `);
    for (const row of pending) {
      const done = await settlePetActivities(row.telegram_id);
      for (const p of done) {
        // One message per settled session: XP and level-up stay combined.
        const body = `🐾 <b>PET ${String(p.activityType || 'activity').toUpperCase()}</b>\n\n`
          + activityCompleteText(p);
        out.push({
          id: row.telegram_id,
          name: 'Shinobi',
          // Pet completions are DM-only (the source sends no group notice).
          chatId: 0,
          kind: 'pet',
          reminder: body,
          dm: body,
        });
      }
    }
  } catch (e) { console.error('[pet sweep]', e); }
  return out;
}

/**
 * Settle ONE shinobi's expired activity. Used as a self-repair before a new
 * dispatch so a row that was never settled cannot keep a shinobi busy forever.
 * The guarded UPDATE inside finish() still pays exactly once.
 */
async function settleRow(telegramId, shinobi) {
  const t = now();
  const a = await db.get(sql`
    SELECT telegram_id, shinobi, kind, started_at, ends_at, base_roll, cooldown_sec, chat_id
    FROM activities
    WHERE telegram_id = ${telegramId} AND shinobi = ${shinobi}
      AND status = 'active' AND kind <> 'pet' AND ends_at <= ${t}
  `);
  if (!a) return null;
  try {
    return await finish(a);
  } catch (e) {
    console.error('[activity settle]', e);
    // Last resort: never leave a shinobi locked on a payout that keeps failing.
    await db.run(sql`
      UPDATE activities SET status = 'idle'
      WHERE telegram_id = ${telegramId} AND shinobi = ${shinobi}
        AND status = 'active' AND ends_at <= ${t}
    `);
    return null;
  }
}

async function dispatch(user, kind, rawName, chatId) {
  const c = KINDS[kind];
  const id = user.id;
  const t = now();
  const shinobi = canonical(rawName);
  if (!shinobi) return { status: 'unknown', name: escapeHtml(String(rawName).trim().slice(0, 30)) };
  if (!c.eligible.includes(shinobi)) return { status: 'not_eligible', shinobi };
  const own = await owned(id);
  if (!own.has(shinobi)) return { status: 'not_owned', shinobi };

  // Physical state guards — persisted timestamps, not memory timers.
  // Death is ACCOUNT-level: it never blocks a shinobi, so it is not checked
  // here. Only exhaustion (and the other busy states below) stop a dispatch.
  const st = await getShinobiState(id, shinobi);
  if (isExhausted(st, t)) return { status: 'exhausted', shinobi, until: st.exhaustedUntil };
  // Naruto & Jiraiya are busy while a Tsunade search session is running.
  if (shinobi === 'Naruto' || shinobi === 'Jiraiya') {
    const s = await db.get(sql`SELECT status, ends_at FROM tsunade_search WHERE telegram_id = ${id}`);
    if (s && s.status === 'active') return { status: 'searching', shinobi, until: s.ends_at };
  }
  // Shinobi recovering at the BBQ / Hot Springs stay busy until the pool is
  // full; the catch-up runs here so they are freed even without opening the map.
  try {
    await applyBbqRecovery(id);
    if ((await restingShinobi(id)).has(shinobi)) return { status: 'busy_rest', shinobi };
  } catch (e) { console.error('[rest busy]', e); }

  await db.run(sql`INSERT OR IGNORE INTO activities (telegram_id, shinobi, kind) VALUES (${id}, ${shinobi}, ${kind})`);
  let row = await db.get(sql`SELECT kind, status, ends_at, cooldown_until FROM activities WHERE telegram_id = ${id} AND shinobi = ${shinobi}`);

  // A finished activity nobody settled yet (for example one that was left
  // behind by the retired shinobi-death system) must never lock the shinobi.
  // Settle it here, then re-read the row instead of reporting a stale busy state.
  if (row.status === 'active' && row.kind !== 'pet' && Number(row.ends_at || 0) <= t) {
    await settleRow(id, shinobi);
    const fresh = await db.get(sql`SELECT kind, status, ends_at, cooldown_until FROM activities WHERE telegram_id = ${id} AND shinobi = ${shinobi}`);
    if (fresh) row = fresh;
  }

  if (row.status === 'active') {
    if (row.kind === 'pet') return { status: 'busy_pet', shinobi, until: row.ends_at };
    const left = Math.max(0, Number(row.ends_at || 0) - t);
    return row.kind === kind
      ? { status: 'already_active', shinobi, left, endsAt: row.ends_at }
      : { status: 'busy', shinobi, other: row.kind, left, endsAt: row.ends_at };
  }
  if (kind === 'mission' && row.cooldown_until > t) {
    return { status: 'cooldown', shinobi, left: row.cooldown_until - t, until: row.cooldown_until };
  }
  if (c.chakra) {
    const q = await chakraQty(id);
    if (q < c.chakra) return { status: 'no_chakra', have: q };
  }

  const roll = rollBase(c);
  // Capycorn Royal Pace: reductions are locked in when this activity starts.
  let duration = c.duration;
  let cooldownSec = c.cooldown;
  try {
    const pace = await petTimeReduction(id);
    duration = reducedActivitySeconds(c.duration, pace.durationFrac);
    cooldownSec = reducedCooldownSeconds(c.cooldown, pace.cooldownFrac);
  } catch (e) { console.error('[pet time reduction]', e); }
  const claim = kind === 'mission'
    ? await db.run(sql`UPDATE activities SET status = 'active', kind = ${kind}, started_at = ${t}, ends_at = ${t + duration}, base_roll = ${roll}, cooldown_sec = ${cooldownSec}, chat_id = ${chatId} WHERE telegram_id = ${id} AND shinobi = ${shinobi} AND status = 'idle' AND cooldown_until <= ${t}`)
    : await db.run(sql`UPDATE activities SET status = 'active', kind = ${kind}, started_at = ${t}, ends_at = ${t + duration}, base_roll = ${roll}, cooldown_sec = ${cooldownSec}, chat_id = ${chatId} WHERE telegram_id = ${id} AND shinobi = ${shinobi} AND status = 'idle'`);
  if (claim.rowsAffected === 0) return { status: 'already_active', shinobi, left: duration };

  const release = () => db.run(sql`UPDATE activities SET status = 'idle' WHERE telegram_id = ${id} AND shinobi = ${shinobi} AND status = 'active' AND started_at = ${t}`);
  if (c.chakra) {
    try {
      const d = await db.run(sql`UPDATE inventory SET qty = qty - ${c.chakra} WHERE telegram_id = ${id} AND item_name = 'Chakra' AND qty >= ${c.chakra}`);
      if (d.rowsAffected === 0) {
        await release();
        return { status: 'no_chakra', have: await chakraQty(id) };
      }
    } catch (e) {
      console.error(e);
      try { await release(); } catch (e2) { console.error(e2); }
      return { status: 'failed' };
    }
  }
  return { status: 'ok', shinobi, endsAt: t + duration };
}

// own = true means the text already contains the user's mention.
function notice(kind, r, user) {
  const c = KINDS[kind];
  const m = mention(user);
  const sh = r.shinobi;
  switch (r.status) {
    case 'ok':
      return kind === 'mission'
        ? { own: true, text: `${quote('⚔️ 𝐌𝐈𝐒𝐒𝐈𝐎𝐍 𝐃𝐈𝐒𝐏𝐀𝐓𝐂𝐇𝐄𝐃')}\n\n🥷 ${m}\n⚔️ ${bold(sh)} has departed for the mission.\n\n⚡ −${c.chakra} chakra\n🎯 Expected completion: ${dueText(r.endsAt)}\n\n❄️ Check back when the mission ends to see its outcome! 🍃` }
        : { own: true, text: `${quote('🥷 𝐏𝐀𝐓𝐑𝐎𝐋 𝐃𝐈𝐒𝐏𝐀𝐓𝐂𝐇𝐄𝐃')}\n\n🥷 ${m}\n${EMO[sh]} ${bold(sh)} has been sent to patrol konoha.\n\n🏃 Expected return: ${dueText(r.endsAt)}\n\n❄️ Come back after his return to check the results and continue your journey!` };
    case 'already_active':
      return kind === 'mission'
        ? { own: true, text: `⚔️ ${m}, ${bold(`${sh} is already on a mission.`)}\n\n🎯 completes at: ${dueText(r.endsAt)}` }
        : { own: true, text: `${quote('🥷 𝐏𝐀𝐓𝐑𝐎𝐋 𝐈𝐍 𝐏𝐑𝐎𝐆𝐑𝐄𝐒𝐒')}\n\n🥷 ${m}\n${EMO[sh]} ${bold(sh)} is still patrolling konoha.\n🏃 returns at: ${dueText(r.endsAt)}` };
    case 'busy_rest':
      return { own: true, text: `♨️ ${m}, ${bold(`${sh} is recovering chakra.`)}\n\n⏳ busy until the chakra pool is full.` };
    case 'busy_pet':
      return { own: true, text: `🐾 ${m}, ${bold(`${sh} is busy with a pet activity.`)}\n\n⏳ free at ${dueText(r.until)}.\n\n» Open /pet to manage your companion.` };
    case 'busy':
      return kind === 'mission'
        ? { own: true, text: `🚪${m}, ${bold(`${sh} is on patrol.`)}\n\n🏃 returns at ${dueText(r.endsAt)}. can't mission until patrol ends.` }
        : { own: true, text: `🚪${m}, ${bold(`${sh} is on mission.`)}\n\n🎯 completes at ${dueText(r.endsAt)}. can't patrol until mission ends.` };
    case 'exhausted':
      return { own: true, text: `🔥 ${m}, ${bold(`${sh} is exhausted.`)}\n\n✅ ready again at ${dueText(r.until)}.\n» Instant recovery is available at /map → BBQ (200 🍥).` };
    case 'searching':
      return { own: true, text: `🔎 ${m}, ${bold(`${sh} is searching for Lady Tsunade.`)}\n\n⏳ the search completes at ${dueText(r.until)}.\n» Check /search_tsuna when it finishes.` };
    case 'not_owned':
      return { own: true, text: `❌ ${m}, ${bold(`you don't own ${sh}.`)}\n\nrecruit this shinobi from\n/shinobi_store first.` };
    case 'not_eligible':
      return { text: `「${c.inel}」\n\n${sh} cannot undertake ${c.word}s.\n\n» Choose ${c.choose} instead.` };
    case 'unknown':
      return { text: `「${c.inel}」\n\n${r.name} cannot undertake ${c.word}s.\n\n» Choose ${c.choose} instead.` };
    case 'cooldown':
      return { text: `「𝐌𝐈𝐒𝐒𝐈𝐎𝐍 𝐂𝐎𝐎𝐋𝐃𝐎𝐖𝐍」\n\n🥷 Shinobi: ${sh}\n⏳ Available at: ${dueText(r.until)}\n\n𝑬𝒗𝒆𝒏 𝒔𝒉𝒊𝒏𝒐𝒃𝒊 𝒏𝒆𝒆𝒅 𝒕𝒊𝒎𝒆 𝒕𝒐 𝒓𝒆𝒄𝒐𝒗𝒆𝒓.` };
    case 'no_chakra':
      return { text: `「𝐂𝐇𝐀𝐊𝐑𝐀 𝐃𝐄𝐏𝐋𝐄𝐓𝐄𝐃」\n\nRequired: chakra x ${c.chakra} ⚡\nAvailable: chakra x ${fmt(r.have)} ⚡\n\n𝑹𝒆𝒔𝒕𝒐𝒓𝒆 𝒚𝒐𝒖𝒓 𝒄𝒉𝒂𝒌𝒓𝒂 𝒃𝒆𝒇𝒐𝒓𝒆 𝒅𝒊𝒔𝒑𝒂𝒕𝒄𝒉.\n\n» Use /claim or /buy chakra 100.` };
    default:
      return { text: `「𝐃𝐈𝐒𝐏𝐀𝐓𝐂𝐇 𝐅𝐀𝐈𝐋𝐄𝐃」\n\nThe ${c.word} couldn't be started. Nothing was changed.\n\n» Try again.` };
  }
}

async function usage(user, kind) {
  const c = KINDS[kind];
  const id = user.id;
  const own = await owned(id);
  const rows = await db.all(sql`SELECT shinobi, kind, status, ends_at, cooldown_until FROM activities WHERE telegram_id = ${id}`);
  const t = now();
  const mine = c.eligible.filter((n) => own.has(n));
  const list = mine.length
    ? mine.map((n) => {
        const r = rows.find((x) => x.shinobi === n);
        if (r && r.status === 'active') {
          const what = r.kind === 'pet' ? 'pet activity' : KINDS[r.kind].word;
          return `🥷 ${n}: on ${what}, ${dur(r.ends_at - t)} left`;
        }
        if (kind === 'mission' && r && r.cooldown_until > t) return `🥷 ${n}: cooldown ${dur(r.cooldown_until - t)}`;
        return `🥷 ${n}: ready`;
      }).join('\n')
    : `You have no eligible shinobi.\nUse /shinobi_store to recruit.`;
  return { text: `「𝐍𝐎 𝐒𝐇𝐈𝐍𝐎𝐁𝐈 𝐒𝐄𝐋𝐄𝐂𝐓𝐄𝐃」\n\nYou need an eligible shinobi for this ${c.word}.\n\n» Choose ${c.choose} to continue.\n\nUse: /${c.word} &lt;shinobi name&gt;\n\n${list}` };
}

// Returns { body, dms, status, shinobi, settled }. dms = short DM texts for
// completed activities; settled = how many return cards the body carries (the
// caller then shows the claim button).
export async function runActivity(user, kind, rawName, chatId) {
  await ensureUser(user.id);
  try { await ensurePetSchema(); } catch (_) {}
  const own = await settleOwn(user);
  const items = own.blocks.map((text) => ({ text }));
  let status = 'usage';
  let shinobi = null;
  if (rawName) {
    const d = await dispatch(user, kind, rawName, chatId);
    status = d.status;
    shinobi = d.shinobi || null;
    items.push(notice(kind, d, user));
  } else {
    items.push(await usage(user, kind));
  }
  const body = items
    .map((it) => it.text)
    .join('\n\n');
  return { body, dms: own.dms, status, shinobi, settled: own.blocks.length };
}
