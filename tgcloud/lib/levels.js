import { db } from 'sdk';
import { sql } from 'sdk/db';
import { render } from './texts.js';
import { P, quote, table, row, btn } from './rich.js';

// [kills needed, rob %, title]
const ITACHI = [
  [0, 20, 'anbu itachi'],
  [25, 30, 'sharingan itachi'],
  [75, 40, 'mangekyō itachi'],
  [150, 55, 'akatsuki itachi'],
  [300, 70, 'uchiha prodigy'],
];

async function data(user) {
  const rows = await db.all(sql`SELECT item_name FROM inventory WHERE telegram_id = ${user.id} AND item_name IN ('Itachi', 'Sakura')`);
  const own = new Set(rows.map((r) => r.item_name));
  const u = await db.get(sql`SELECT kills FROM users WHERE telegram_id = ${user.id}`);
  const kills = u ? u.kills : 0;
  let lv = 0;
  ITACHI.forEach((l, i) => { if (kills >= l[0]) lv = i; });
  const current = own.has('Itachi')
    ? `📈 current: lv. ${lv + 1} — ${ITACHI[lv][2]}`
    : `📈 current: itachi not owned`;
  const next = lv < ITACHI.length - 1
    ? `⏳ next level at ${ITACHI[lv + 1][0]} kills`
    : `✅ all itachi milestones complete`;
  const sakura = `📈 current: ${own.has('Sakura') ? 'training not available yet' : 'sakura not owned'}`;
  return { kills, current, next, sakura };
}

export async function levelUpData(user) {
  const d = await data(user);
  return {
    kills: d.kills,
    current: d.current,
    next: d.next,
    sakura: d.sakura,
    itachiMilestones: ITACHI.map(([kills, robGain, title], index) => ({
      level: index + 1,
      kills,
      robGain,
      title,
    })),
  };
}

// Classic fallback.
export async function levelsText(user) {
  const d = await data(user);
  const t = ['level | kill count | rob gain']
    .concat(ITACHI.map((l, i) => `lv. ${i + 1} | ${l[0]} kills | ${l[1]}%`)).join('\n');
  return render(user,
    `⬆️ 𝐋𝐕𝐋 𝐔𝐏𝐒\n\n🩸 𝐈𝐓𝐀𝐂𝐇𝐈\n<blockquote>${t}</blockquote>\n` +
    `${d.current}\n🔪 kill count: ${d.kills}\n${d.next}\n\n` +
    `🌸 𝐒𝐀𝐊𝐔𝐑𝐀 𝐓𝐑𝐀𝐈𝐍𝐈𝐍𝐆 (via tsunade)\n${d.sakura}\n✅ sessions: —\n\n` +
    `<blockquote>🐌 𝐊𝐚𝐭𝐬𝐮𝐲𝐮'𝐬 𝐇𝐞𝐚𝐥𝐢𝐧𝐠 (tsunade)\n✅ unlock when — sakura reached lv.4</blockquote>\n` +
    `─────────────────⟢\nonly shinobi with level systems are listed here.`);
}

// Rich version.
export async function levelsContent(user) {
  const d = await data(user);
  return [
    P('⬆️ 𝐋𝐕𝐋 𝐔𝐏𝐒'),
    P('🩸 𝐈𝐓𝐀𝐂𝐇𝐈'),
    table([['level', 'kill count', 'rob gain'],
      ...ITACHI.map((l, i) => [`lv. ${i + 1}`, `${l[0]} kills`, `${l[1]}%`])]),
    P(d.current), P(`🔪 kill count: ${d.kills}`), P(d.next),
    P('🌸 𝐒𝐀𝐊𝐔𝐑𝐀 𝐓𝐑𝐀𝐈𝐍𝐈𝐍𝐆 (via tsunade)'),
    P(d.sakura), P('✅ sessions: —'),
    quote(`🐌 𝐊𝐚𝐭𝐬𝐮𝐲𝐮'𝐬 𝐇𝐞𝐚𝐥𝐢𝐧𝐠 (tsunade)\n✅ unlock when — sakura reached lv.4`),
    P('─────────────────⟢'),
    P('only shinobi with level systems are listed here.'),
    row(btn('Back', { callback_data: `lv:ab:${user.id}` })),
  ];
}
