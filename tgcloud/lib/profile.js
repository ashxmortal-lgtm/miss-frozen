/**
 * /profile — shinobi rank, coins, chakra, roster, and streak from existing data.
 */
import { db } from 'sdk';
import { sql } from 'sdk/db';
import { fmt } from './store.js';
import { mention, style } from './texts.js';
import { rankOf } from './activities.js';
import { botAvatarDataUri } from './bot_avatar.js';
import { getEquippedList, getEquipped, getAllShinobiState, isDead } from './rpg/state.js';
import { dueText } from './rpg/time.js';

const EMO = {
  Sasuke: '⚔️',
  Sakura: '🌸',
  Naruto: '🍥',
  Itachi: '👁️',
  Hinata: '👁️',
  Jiraiya: '🐸',
  'Starter Shinobi': '🥷',
};

const RANKS = [
  [0, 'Academy Student'],
  [500, 'Genin'],
  [1500, 'Chūnin'],
  [3500, 'Jōnin'],
  [6500, 'Anbu'],
  [10000, 'Kage'],
];

/** Return only the caller's profile fields, shared by /profile and the Mini App. */
export async function profileData(user) {
  const id = user.id;
  const u = await db.get(sql`
    SELECT balance, xp, kills, claim_streak, last_claim_date, naruto_patrols
    FROM users WHERE telegram_id = ${id}
  `);
  const bal = u ? u.balance : 0;
  const xp = u ? u.xp : 0;
  const kills = u ? (u.kills || 0) : 0;
  const streak = u ? (u.claim_streak || 0) : 0;
  const lastClaim = u && u.last_claim_date ? u.last_claim_date : '—';
  const narutoPatrols = u ? (u.naruto_patrols || 0) : 0;
  const rank = rankOf(xp);

  const chakraRow = await db.get(sql`
    SELECT qty FROM inventory
    WHERE telegram_id = ${id} AND item_name = 'Chakra'
  `);
  const chakra = chakraRow ? chakraRow.qty : 0;

  const shinobi = await db.all(sql`
    SELECT item_name, qty FROM inventory
    WHERE telegram_id = ${id} AND item_type = 'shinobi'
    ORDER BY item_name
  `);
  const jutsu = await db.all(sql`
    SELECT item_name FROM inventory
    WHERE telegram_id = ${id} AND item_type = 'jutsu'
    ORDER BY item_name
  `);

  let nextLabel = 'max rank';
  let nextXp = null;
  for (const [need, name] of RANKS) {
    if (xp < need) {
      nextLabel = name;
      nextXp = need;
      break;
    }
  }
  const progress = nextXp != null
    ? `${fmt(xp)} / ${fmt(nextXp)} XP → ${nextLabel}`
    : `${fmt(xp)} XP (Kage)`;

  // Present death as the user's status, not as a particular roster shinobi.
  let life = { alive: true, label: 'Alive', equipped: 'Starter Shinobi' };
  try {
    const equipped = await getEquipped(id);
    const states = await getAllShinobiState(id);
    const t = Math.floor(Date.now() / 1000);
    const deadUntil = Math.max(0, ...Object.values(states).filter((st) => isDead(st, t)).map((st) => Number(st.deadUntil) || 0));
    life = deadUntil > t
      ? { alive: false, label: `Dead · revives ${dueText(deadUntil, t)}`, equipped }
      : { alive: true, label: 'Alive', equipped };
  } catch (_) { /* keep default */ }
  let botAvatar = '';
  try { botAvatar = await botAvatarDataUri(); } catch (_) { /* optional */ }

  let equippedList = [];
  try {
    const { getEquippedList } = await import('./rpg/state.js');
    equippedList = await getEquippedList(id);
  } catch (_) {}
  let globalRank = 1;
  try {
    const gr = await db.get(sql`
      SELECT COUNT(*) AS n FROM users WHERE xp > ${xp}
    `);
    globalRank = (gr ? Number(gr.n) : 0) + 1;
  } catch (_) {}

  return {
    life,
    botAvatar,
    displayName: [user.first_name, user.last_name].filter(Boolean).join(' ') || 'Shinobi',
    username: user.username || '',
    rank: rank[1],
    globalRank,
    equippedList,
    xp,
    xpText: progress,
    balance: bal,
    chakra,
    kills,
    streak,
    lastClaim,
    narutoPatrols,
    roster: shinobi.map((s) => ({
      name: s.item_name,
      emoji: EMO[s.item_name] || '🥷',
      qty: s.qty,
    })),
    jutsu: jutsu.map((j) => j.item_name),
  };
}

export async function profileText(user, message = null) {
  const profile = await profileData(user);
  // Fancy small-caps-ish labels as requested
  const rank = String(profile.rank || 'Genin').toUpperCase();
  const xpLine = profile.xpText || `${fmt(profile.xp)} XP`;
  let grpRankLine = '';
  if (message && (message.chat?.type === 'group' || message.chat?.type === 'supergroup')) {
    try {
      const gr = await db.get(sql`
        SELECT COUNT(*) AS n FROM group_members g
        JOIN users u ON u.telegram_id = g.telegram_id
        WHERE g.chat_id = ${message.chat.id} AND u.xp > ${profile.xp}
      `);
      const grpRank = (gr ? Number(gr.n) : 0) + 1;
      grpRankLine = `\n💭 ɢʀᴘ ʀᴀɴᴋ : ${grpRank}`;
    } catch (_) {}
  }
  const stats = [
    `🥷 ʀᴀɴᴋ: ${rank}`,
    `✨ xᴘ: ${xpLine}`,
    `🍥 ᴄᴏɪɴꜱ: ${fmt(profile.balance)}`,
    `⚡ ᴄʜᴀᴋʀᴀ: ${fmt(profile.chakra)}`,
    `🔪 ᴋɪʟʟꜱ: ${fmt(profile.kills)}`,
    `🔥 ᴄʟᴀɪᴍ ꜱᴛʀᴇᴀᴋ: ${fmt(profile.streak)} (ʟᴀꜱᴛ: ${profile.lastClaim})`,
    `📊 global rank: ${profile.globalRank}`,
  ].join('\n') + grpRankLine;

  return style(
    `${mention(user)}'s profile:\n` +
    `─────────────────\n` +
    `<blockquote>${stats}</blockquote>\n` +
    `─────────────────`,
  );
}
