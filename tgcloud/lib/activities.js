import { db } from 'sdk';
import { sql } from 'sdk/db';
import { fmt } from './store.js';
import { escapeHtml, mention } from './texts.js';
import { dueText } from './rpg/time.js';
import {
  getShinobiState, isDead, isExhausted, recordPatrolCompletion, resetPatrolStreak,
} from './rpg/state.js';
import { addPendingReward, pendingRewardTotal } from './map/pending.js';
import { jiraiyaFound, sakuraActivityBonus } from './rpg/levels.js';

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
  const won = a.kind === 'mission'
    ? await db.run(sql`UPDATE activities SET status = 'idle', cooldown_until = ${a.ends_at + c.cooldown} WHERE telegram_id = ${id} AND shinobi = ${a.shinobi} AND status = 'active' AND ends_at <= ${t}`)
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

  const u = await db.get(sql`SELECT xp, first_name FROM users WHERE telegram_id = ${id}`);
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
  const coins = reward(c, a.shinobi, base, xpBefore, sakuraBonus);
  // Random 50–150 XP per finished patrol/mission.
  const xpGain = c.xpMin + Math.floor(Math.random() * (c.xpMax - c.xpMin + 1));
  // Coins go to pending (claim at Hokage Office) — only XP is applied immediately.
  await db.run(sql`UPDATE users SET xp = xp + ${xpGain} WHERE telegram_id = ${id}`);
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
  return {
    id, name: (u && u.first_name) || 'Shinobi', chatId: a.chat_id,
    kind: a.kind, shinobi: a.shinobi, coins, xp: xpGain,
    rankUp: after !== before ? after : null, found, had, exhaustedUntil,
    pendingTotal, username: null,
  };
}

const FOUND = `「𝐋𝐄𝐆𝐄𝐍𝐃𝐀𝐑𝐘 𝐃𝐈𝐒𝐂𝐎𝐕𝐄𝐑𝐘」\n\n🐸 Jiraiya has joined your shinobi roster!\n\n𝑺𝒐𝒎𝒆 𝒑𝒂𝒕𝒓𝒐𝒍𝒔 𝒍𝒆𝒂𝒅 𝒕𝒐 𝒖𝒏𝒆𝒙𝒑𝒆𝒄𝒕𝒆𝒅 𝒎𝒆𝒆𝒕𝒊𝒏𝒈𝒔.\n\n» Check your inventory to see your new shinobi.`;

function fullText(r) {
  const emo = EMO[r.shinobi] || '🥷';
  const title = r.kind === 'patrol' ? '🏮 𝐓𝐄𝐀𝐌 𝐏𝐀𝐓𝐑𝐎𝐋 𝐑𝐄𝐓𝐔𝐑𝐍𝐄𝐃' : '⚔️ 𝐌𝐈𝐒𝐒𝐈𝐎𝐍 𝐂𝐎𝐌𝐏𝐋𝐄𝐓𝐄';
  let s = `${title}\n\n`;
  if (r.kind === 'patrol') s += `ʜɪᴅᴅᴇɴ ʟᴇᴀғ ᴠɪʟʟᴀɢᴇ ɪs sᴀғᴇ.\n\n`;
  s += `${emo} ${bold(r.shinobi)} → +${fmt(r.coins)} 🍥\n`;
  s += `⭐ +${r.xp} xᴘ\n`;
  if (r.rankUp) s += `🏅 Rank up: ${r.rankUp}\n`;
  if (r.pendingTotal > 0) s += `\n🍥 𝐏𝐞𝐧𝐝𝐢𝐧𝐠 𝐭𝐨𝐭𝐚𝐥: ${fmt(r.pendingTotal)} ᴋᴏɴᴏʜᴀ ᴄᴏɪɴs\n`;
  if (r.exhaustedUntil) s += `\n🔥 ${r.shinobi} is exhausted — ready at ${dueText(r.exhaustedUntil)}.\n`;
  if (r.kind === 'mission') s += `\n⏳ Next mission available in: ${hours(KINDS.mission.cooldown)}\n`;
  if (r.had) s += `\n𝑱𝒊𝒓𝒂𝒊𝒚𝒂 𝒊𝒔 𝒂𝒍𝒓𝒆𝒂𝒅𝒚 𝒑𝒂𝒓𝒕 𝒐𝒇 𝒚𝒐𝒖𝒓 𝒓𝒐𝒔𝒕𝒆𝒓.\n`;
  s += `\n💰 ᴄʟᴀɪᴍ ᴀᴛ ᴛʜᴇ ʜᴏᴋᴀɢᴇ ᴏғғɪᴄᴇ — /map → 🏯 → 💰 ᴄʟᴀɪᴍ ʀᴇᴡᴀʀᴅ.`;
  return s;
}
// Group reminder (the mention is added by the caller).
function remindText(r) {
  const emo = EMO[r.shinobi] || '🥷';
  const title = r.kind === 'patrol' ? '🏮 𝐓𝐄𝐀𝐌 𝐏𝐀𝐓𝐑𝐎𝐋 𝐑𝐄𝐓𝐔𝐑𝐍𝐄𝐃' : '⚔️ 𝐌𝐈𝐒𝐒𝐈𝐎𝐍 𝐂𝐎𝐌𝐏𝐋𝐄𝐓𝐄';
  let s = `${title}\n\n`;
  if (r.kind === 'patrol') s += `ʜɪᴅᴅᴇɴ ʟᴇᴀғ ᴠɪʟʟᴀɢᴇ ɪs sᴀғᴇ.\n\n`;
  s += `${emo} ${bold(r.shinobi)} → +${fmt(r.coins)} 🍥\n`;
  s += `⭐ +${r.xp} xᴘ\n`;
  if (r.rankUp) s += `🏅 Rank up: ${r.rankUp}\n`;
  if (r.found) s += `🐸 Jiraiya joined your roster!\n`;
  if (r.pendingTotal > 0) s += `\n🍥 𝐏𝐞𝐧𝐝𝐢𝐧𝐠 𝐭𝐨𝐭𝐚𝐥: ${fmt(r.pendingTotal)} ᴋᴏɴᴏʜᴀ ᴄᴏɪɴs\n`;
  if (r.exhaustedUntil) s += `🔥 ${r.shinobi} is exhausted — ready at ${dueText(r.exhaustedUntil)}.\n`;
  s += `\n💰 ᴄʟᴀɪᴍ ᴀᴛ ᴛʜᴇ ʜᴏᴋᴀɢᴇ ᴏғғɪᴄᴇ — /map → 🏯 → 💰 ᴄʟᴀɪᴍ ʀᴇᴡᴀʀᴅ.`;
  return s;
}
// Short DM.
function dmText(r) {
  const emo = EMO[r.shinobi] || '🥷';
  let s = `✅ ${KINDS[r.kind].done}\n\n${emo} ${r.shinobi} returned.\n🍥 +${fmt(r.coins)} (pending)  ·  ✦ XP +${r.xp}`;
  if (r.found) s += `\n🐸 Jiraiya joined your roster!`;
  if (r.exhaustedUntil) s += `\n🔥 Exhausted until ${dueText(r.exhaustedUntil)}.`;
  s += `\n\n💰 Claim at Hokage Office: /map → 🏯`;
  return s;
}

// Finished activities of ONE user (shown in their own reply).
// Also exported so opening the Gate/Inventory refreshes statuses first.
export async function settleOwn(user) {
  const t = now();
  const due = await db.all(sql`SELECT telegram_id, shinobi, kind, ends_at, base_roll, chat_id FROM activities WHERE telegram_id = ${user.id} AND status = 'active' AND ends_at <= ${t}`);
  const blocks = [];
  const dms = [];
  for (const a of due) {
    const r = await finish(a);
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
  const t = now();
  const due = await db.all(sql`SELECT telegram_id, shinobi, kind, ends_at, base_roll, chat_id FROM activities WHERE status = 'active' AND ends_at <= ${t} LIMIT 10`);
  const out = [];
  for (const a of due) {
    const r = await finish(a);
    if (!r) continue;
    out.push({ id: r.id, name: r.name, chatId: r.chatId, reminder: remindText(r), dm: dmText(r) });
  }
  return out;
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
  const st = await getShinobiState(id, shinobi);
  if (isDead(st, t)) return { status: 'dead', shinobi, until: st.deadUntil };
  if (isExhausted(st, t)) return { status: 'exhausted', shinobi, until: st.exhaustedUntil };
  // Naruto & Jiraiya are busy while a Tsunade search session is running.
  if (shinobi === 'Naruto' || shinobi === 'Jiraiya') {
    const s = await db.get(sql`SELECT status, ends_at FROM tsunade_search WHERE telegram_id = ${id}`);
    if (s && s.status === 'active') return { status: 'searching', shinobi, until: s.ends_at };
  }

  await db.run(sql`INSERT OR IGNORE INTO activities (telegram_id, shinobi, kind) VALUES (${id}, ${shinobi}, ${kind})`);
  const row = await db.get(sql`SELECT kind, status, ends_at, cooldown_until FROM activities WHERE telegram_id = ${id} AND shinobi = ${shinobi}`);

  if (row.status === 'active') {
    return row.kind === kind
      ? { status: 'already_active', shinobi, left: row.ends_at - t, endsAt: row.ends_at }
      : { status: 'busy', shinobi, other: row.kind, left: row.ends_at - t, endsAt: row.ends_at };
  }
  if (kind === 'mission' && row.cooldown_until > t) {
    return { status: 'cooldown', shinobi, left: row.cooldown_until - t, until: row.cooldown_until };
  }
  if (c.chakra) {
    const q = await chakraQty(id);
    if (q < c.chakra) return { status: 'no_chakra', have: q };
  }

  const roll = rollBase(c);
  const claim = kind === 'mission'
    ? await db.run(sql`UPDATE activities SET status = 'active', kind = ${kind}, started_at = ${t}, ends_at = ${t + c.duration}, base_roll = ${roll}, chat_id = ${chatId} WHERE telegram_id = ${id} AND shinobi = ${shinobi} AND status = 'idle' AND cooldown_until <= ${t}`)
    : await db.run(sql`UPDATE activities SET status = 'active', kind = ${kind}, started_at = ${t}, ends_at = ${t + c.duration}, base_roll = ${roll}, chat_id = ${chatId} WHERE telegram_id = ${id} AND shinobi = ${shinobi} AND status = 'idle'`);
  if (claim.rowsAffected === 0) return { status: 'already_active', shinobi, left: c.duration };

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
  return { status: 'ok', shinobi, endsAt: t + c.duration };
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
    case 'busy':
      return kind === 'mission'
        ? { own: true, text: `🚪${m}, ${bold(`${sh} is on patrol.`)}\n\n🏃 returns at ${dueText(r.endsAt)}. can't mission until patrol ends.` }
        : { own: true, text: `🚪${m}, ${bold(`${sh} is on mission.`)}\n\n🎯 completes at ${dueText(r.endsAt)}. can't patrol until mission ends.` };
    case 'dead':
      return { own: true, text: `☠️ ${m}, ${bold(`${sh} is dead.`)}\n\n🕊️ revives automatically at ${dueText(r.until)}.` };
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
        if (r && r.status === 'active') return `🥷 ${n}: on ${KINDS[r.kind].word}, ${dur(r.ends_at - t)} left`;
        if (kind === 'mission' && r && r.cooldown_until > t) return `🥷 ${n}: cooldown ${dur(r.cooldown_until - t)}`;
        return `🥷 ${n}: ready`;
      }).join('\n')
    : `You have no eligible shinobi.\nUse /shinobi_store to recruit.`;
  return { text: `「𝐍𝐎 𝐒𝐇𝐈𝐍𝐎𝐁𝐈 𝐒𝐄𝐋𝐄𝐂𝐓𝐄𝐃」\n\nYou need an eligible shinobi for this ${c.word}.\n\n» Choose ${c.choose} to continue.\n\nUse: /${c.word} &lt;shinobi name&gt;\n\n${list}` };
}

// Returns { body, dms, status, shinobi }. dms = short DM texts for completed activities.
export async function runActivity(user, kind, rawName, chatId) {
  await ensureUser(user.id);
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
    .map((it, i) => (i === 0 && !it.own ? `${mention(user)}\n\n${it.text}` : it.text))
    .join('\n\n');
  return { body, dms: own.dms, status, shinobi };
}
