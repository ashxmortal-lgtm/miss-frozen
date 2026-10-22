import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { render, style } from '../tgcloud/lib/texts.js';
import { listCommands } from '../tgcloud/lib/command_registry.js';
const read = (p) => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const user = { id: 42, first_name: 'Shinobi' };

// Execute the actual block builders with platform imports replaced by small mocks.
function welcome() {
  const source = read('tgcloud/lib/welcome_ui.js')
    .replace(/^import .*;\n/gm, '').replaceAll('export ', '');
  const calls = [];
  const api = {
    getMe: async () => ({ username: 'missfrozen_bot' }),
    answerCallbackQuery: async () => {},
    editMessageText: async (payload) => calls.push(payload),
  };
  return { ...new Function('api', 'OWNER_ID', 'BOT_USERNAME', 'listCommands',
    `${source}; return { buildWelcomeBlocks, buildUserHelpBlocks, handleWelcomeCallback };`)(
    api, 999, 'missfrozen_bot', listCommands), calls };
}

test('welcome has requested tutorial link and unchanged primary actions', async () => {
  const blocks = await welcome().buildWelcomeBlocks(user);
  assert.equal(blocks[0].text[0].type, 'text_mention');
  const text = JSON.stringify(blocks);
  assert.match(text, /ᴡᴇʟᴄᴏᴍᴇ! ❄️/);
  assert.match(text, /"text":"ᴄʜᴇᴄᴋ ᴛʜɪꜱ","url":"https:\/\/t.me\/frozenblooded\/22"/);
  assert.doesNotMatch(text, /mini profile|ʏᴏᴜʀ ᴍɪɴɪ/);
  const buttons = blocks.filter((b) => b.type === 'buttons').flatMap((b) => b.buttons);
  assert.deepEqual(buttons.map((b) => b.text), ['Add to grp', 'Help', 'Contact ❄️ owner']);
  assert.equal(buttons[1].callback_data, 'wel:help');
  assert.equal(buttons[2].callback_data, 'si:menu:42');
});

test('game help includes profile and all primary user commands without code formatting', async () => {
  const blocks = await welcome().buildUserHelpBlocks(user);
  const text = JSON.stringify(blocks);
  for (const cmd of ['/profile', '/inventory', '/balance', '/ability', '/buy', '/redeem', '/claim']) {
    assert.ok(blocks.some((b) => typeof b.text === 'string' && b.text.startsWith(cmd + ' ')), cmd);
  }
  assert.doesNotMatch(text, /"type":"code"/);
  assert.match(style('/profile — Your profile'), /^\/profile/);
});

test('help callbacks enable automatic command detection for every screen', async () => {
  const ui = welcome();
  for (const data of ['wel:help', 'hp:game', 'hp:extras', 'hp:more']) {
    await ui.handleWelcomeCallback({ id: 'cb', data, from: user, message: { chat: { id: 42 }, message_id: 1 } });
  }
  assert.equal(ui.calls.length, 4);
  for (const call of ui.calls) assert.notEqual(call.rich_message.skip_entity_detection, true);
});

test('generic replies no longer prepend mentions; explicitly authored mentions survive', () => {
  assert.equal(render(user, '/help'), '/help');
  assert.equal(render(user, '<a href="tg://user?id=42">Shinobi</a>'), '<a href="tg://user?id=42">Shinobi</a>');
});

test('private store navigation uses rich table content on every edit', async () => {
  const source = read('tgcloud/lib/economy_handler.js');
  const functionText = source.slice(source.indexOf('async function editStoreScreen'), source.indexOf('export async function handleEconomyCallback'));
  const seen = [];
  const edit = new Function('editRichOr', 'storeContent', `${functionText}; return editStoreScreen;`)(
    async (_msg, _user, blocks) => seen.push(blocks),
    async (screen, ownerId, options) => [{ type: 'table', screen, ownerId, options }],
  );
  for (const screen of ['main', 'chakra', 'main', 'jutsu', 'main']) {
    await edit({ chat: { type: 'private' } }, user, screen);
  }
  assert.equal(seen.length, 5);
  for (const blocks of seen) {
    assert.equal(blocks[0].type, 'table');
    assert.equal(blocks[0].options.includeMiniApp, true);
  }
  assert.match(read('tgcloud/lib/rich.js'), /Check shinobi abilities.*lv:ab:/);
  assert.match(read('tgcloud/lib/store.js'), /Check shinobi abilities.*lv:ab:/);
});

test('profile keeps live values quoted and inventory removes only redundant copy', () => {
  const profile = read('tgcloud/lib/profile.js');
  assert.match(profile, /<blockquote>\$\{stats\}<\/blockquote>/);
  assert.match(profile, /next\[1\]/);
  assert.match(profile, /profile\.globalRank/);
  const inventory = read('tgcloud/lib/inventory.js');
  assert.doesNotMatch(inventory, /head\('⚔️ SHINOBI STATUS'\)|Your shinobi are making progress!/);
  assert.match(inventory, /table\(/);
});

test('claim routes to Mini App rather than claiming in chat; group link is handled', () => {
  const source = read('tgcloud/lib/economy_handler.js');
  const branch = source.slice(source.indexOf("} else if (cmd === 'claim'"), source.indexOf("} else if (cmd === 'balance'"));
  assert.doesNotMatch(branch, /claimDaily\(/);
  assert.match(branch, /web_app: \{ url: MINI_APP_URL \}/);
  assert.match(branch, /start=mini_claim/);
  assert.match(read('tgcloud/handlers/message.js'), /if \(key === 'mini_claim'\)/);
});

test('profile presentation interpolates actual stats, next rank, and a single mention', async () => {
  const source = read('tgcloud/lib/profile.js');
  const renderer = source.slice(source.indexOf('export async function profileText')).replace('export ', '');
  const profileText = new Function('profileData', 'RANKS', 'fmt', 'mention', 'style',
    `${renderer}; return profileText;`)(
    async () => ({ rank: 'Genin', xp: 750, balance: 1234, chakra: 80, kills: 7, streak: 2, globalRank: 8 }),
    [[0, 'Academy Student'], [500, 'Genin'], [1500, 'Chūnin']],
    String, () => '<a href="tg://user?id=42">Shinobi</a>', style,
  );
  const text = await profileText(user);
  assert.equal((text.match(/tg:\/\/user/g) || []).length, 1);
  assert.match(text, /750 \/ 1500/);
  assert.match(text, /1234/);
  assert.match(text, /#8/);
  assert.match(text, /<blockquote>[\s\S]*<\/blockquote>/);
});
