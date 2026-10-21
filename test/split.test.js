import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(root, p));
function walk(dir) {
  const out = [];
  for (const i of fs.readdirSync(path.join(root, dir))) {
    const p = `${dir}/${i}`;
    if (fs.statSync(path.join(root, p)).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}
const runtime = [...walk('tgcloud'), ...walk('web')].filter((f) => f.endsWith('.js') && !f.includes('source_snapshot'));

test('MissFrozen identity: app id, username, Mini App URL', () => {
  const cfg = read('tgcloud/lib/config.js');
  assert.match(cfg, /app8888370613/);
  assert.match(cfg, /missfrozen_bot/);
  assert.match(cfg, /https:\/\/app8888370613\.tgcloud\.ai\//);
  assert.doesNotMatch(cfg, /app8868570312|exfrozen_bot/);
  assert.match(read('web/js/contract.js'), /missfrozen_bot/);
});

test('gaming commands registered; study commands absent', () => {
  const reg = read('tgcloud/lib/command_registry.js');
  for (const c of ['/games', '/xoxo', '/rps', '/map', '/mission', '/patrol', '/shinobi_store', '/buy', '/inventory', '/claim', '/balance', '/profile', '/leaderboard', '/lb', '/transfer', '/gift_store', '/gift', '/hug', '/slap', '/punch', '/pat', '/mt', '/kill', '/rob', '/protect', '/byakugan', '/search_tsuna', '/redeem', '/addcoins', '/create_cc', '/eco', '/start', '/help', '/owner', '/stats', '/backup', '/ow_announce']) {
    assert.ok(reg.includes(`'${c}'`), `registry missing ${c}`);
  }
  for (const c of ['/study', '/tracker', '/studytime', '/todo', '/duel', '/report', '/reminder', '/hnc', '/imfrozen', '/announce', '/topic', '/qu']) {
    assert.ok(!reg.includes(`'${c}'`), `registry must not contain ${c}`);
  }
  const msg = read('tgcloud/handlers/message.js');
  assert.doesNotMatch(msg, /study\/|handleStudyCommand|handleTopicCommand|buildHncMenu/);
  assert.match(msg, /xoxo_cancel|cancel_xoxo/);
  assert.match(read('tgcloud/lib/economy_handler.js'), /cmd === 'claim' \|\| cmd === 'daily'/);
});

test('/eco authorized by live Telegram group-admin status; no /imfrozen', () => {
  const ga = read('tgcloud/lib/groupadmin.js');
  assert.match(ga, /cmd !== '\/eco'/);
  assert.match(ga, /liveAdmin\(chatId, userId\)\) === true/);
  assert.match(ga, /getChatMember/);
  assert.match(ga, /userId === OWNER_ID/);
  assert.doesNotMatch(ga, /groupAdmins|adminConfirmations|handleImfrozen|'imf:/);
  const schema = read('tgcloud/schema.js');
  assert.ok(!schema.includes("table('group_admins'"));
  assert.ok(schema.includes("table('group_settings'"));
});

test('/announce is not registered; /ow_announce owner broadcast remains', () => {
  const ann = read('tgcloud/lib/announce.js');
  assert.match(ann, /cmd !== '\/ow_announce'/);
  assert.doesNotMatch(ann, /cmd !== '\/announce'/);
});

test('no Game/Study chooser; gaming help is direct; no admin welcome', () => {
  const w = read('tgcloud/lib/welcome_ui.js');
  assert.doesNotMatch(w, /Choose mode|Study ❄️ mode|ADMIN WELCOME|buildStudyStatsBlocks/);
  assert.match(w, /gameBlocks\(fromWelcome\)/);
});

test('schema has gaming tables, no study tables, no deprecations', () => {
  const s = read('tgcloud/schema.js');
  for (const t of ['users', 'inventory', 'purchases', 'activities', 'shinobi_state', 'game_lobbies', 'coupons', 'group_settings', 'known_groups', 'support_conversations', 'map_mission_selection']) {
    assert.ok(s.includes(`table('${t}'`), `schema missing ${t}`);
  }
  for (const t of ['study_goals', 'study_todos', 'study_duels', 'biology_tracker', 'study_reminders', 'quiz_topic_suggestions', 'group_admins']) {
    assert.ok(!s.includes(`table('${t}'`), `schema must not contain study table ${t}`);
  }
  assert.doesNotMatch(s, /\.deprecated\(/);
  assert.doesNotMatch(s, /study_coins/);
});

test('Mini App endpoint: gaming actions only, initData-authenticated', () => {
  const ep = read('tgcloud/endpoints/miniapp.js');
  assert.match(ep, /ctx\?\.initData\?\.user/);
  assert.match(ep, /action === 'purchase'/);
  assert.match(ep, /action === 'claim'/);
  assert.doesNotMatch(ep, /tracker_toggle|todo_update|study_report|study:/);
  assert.ok(exists('tgcloud/endpoints/getProfile.js'));
  const contract = read('web/js/contract.js');
  assert.doesNotMatch(contract, /tracker|mini_todo/);
});

test('no study callbacks/modules in runtime tree; no secrets', () => {
  for (const f of runtime) {
    const c = read(f);
    assert.doesNotMatch(c, /from\s+['"][^'"]*study\/|from\s+['"][^'"]*(hnc\.js|topic\.js|compose\.js|suggest\.js)/, f);
    assert.doesNotMatch(c, /\b\d{6,}:[A-Za-z0-9_-]{20,}\b/, `possible bot token in ${f}`);
    assert.doesNotMatch(c, /TGCLOUD_TOKEN\s*=\s*['"][^'"]+['"]/, f);
  }
  assert.ok(!exists('tgcloud/lib/study'));
  assert.ok(!exists('.env'));
});

test('deployment targets only app8888370613 with its own secret', () => {
  const wf = read('.github/workflows/deploy.yml');
  assert.match(wf, /TGCLOUD_TOKEN_MISSFROZEN/);
  assert.match(wf, /app8888370613/);
  assert.doesNotMatch(wf, /app8868570312|TGCLOUD_TOKEN_EXFROZEN/);
});
