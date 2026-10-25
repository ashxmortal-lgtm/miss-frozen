import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { render, style } from '../tgcloud/lib/texts.js';
import { listCommands, PET_COMMANDS, ALIASES } from '../tgcloud/lib/command_registry.js';
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
  return { ...new Function('api', 'OWNER_ID', 'BOT_USERNAME', 'listCommands', 'PET_COMMANDS',
    `${source}; return { buildWelcomeBlocks, buildUserHelpBlocks, handleWelcomeCallback };`)(    api, 999, 'missfrozen_bot', listCommands, PET_COMMANDS), calls };
}

test('welcome links the bot name, uses the Help hint and keeps primary actions', async () => {
  const blocks = await welcome().buildWelcomeBlocks(user);
  assert.equal(blocks[0].text[0].type, 'text_mention');
  const text = JSON.stringify(blocks);
  assert.match(text, /ᴡᴇʟᴄᴏᴍᴇ! ❄️/);
  assert.match(text, /"text":"ᴄʜᴇᴄᴋ ᴛʜɪꜱ","url":"https:\/\/t.me\/frozenblooded\/22"/);
  // "𝑴𝒊𝒔𝒔 𝑭𝒓❄️𝒛𝒆𝒏" is embedded with the bot link everywhere it appears.
  const botLinks = text.match(/"text":"𝑴𝒊𝒔𝒔 𝑭𝒓❄️𝒛𝒆𝒏","url":"https:\/\/t.me\/missfrozen_bot"/g) || [];
  assert.equal(botLinks.length, 2, 'bot name linked in the intro and the add-to-group line');
  // The old "EXPLORE /help FOR GAMES" line is replaced by the Help-button hint.
  assert.match(text, /ᴛᴀᴘ ᴛʜᴇ 𝐇𝐄𝐋𝐏 ʙᴜᴛᴛᴏɴ ᴛᴏ ᴇxᴘʟᴏʀᴇ ɢᴀᴍᴇꜱ, ᴄᴏᴍᴍᴀɴᴅꜱ & ʀᴇᴡᴀʀᴅꜱ! ❄️/);
  assert.doesNotMatch(text, /ᴇxᴘʟᴏʀᴇ \/help/);
  assert.doesNotMatch(text, /mini profile|ʏᴏᴜʀ ᴍɪɴɪ/);
  const buttons = blocks.filter((b) => b.type === 'buttons').flatMap((b) => b.buttons);
  assert.deepEqual(buttons.map((b) => b.text), ['Add to grp', 'Help', 'Contact ❄️ owner']);
  assert.equal(buttons[1].callback_data, 'wel:help');
  assert.equal(buttons[2].callback_data, 'si:menu:42');

  // Requested: the intro line and the HELP hint share one quote.
  const intro = blocks.find((b) => b.type === 'blockquote'
    && JSON.stringify(b).includes('ɴᴀʀᴜᴛᴏ-ɪɴꜱᴘɪʀᴇᴅ'));
  assert.ok(intro, 'the intro lines are quoted');
  assert.equal(intro.blocks.length, 2);
  assert.match(JSON.stringify(intro), /ᴛᴀᴘ ᴛʜᴇ 𝐇𝐄𝐋𝐏 ʙᴜᴛᴛᴏɴ/);
  assert.ok(!JSON.stringify(intro).includes('ᴄʜᴇᴄᴋ ᴛʜɪꜱ'), 'the learn-how-to-play line stays outside');
});

const HELP_BLOCK_ONE = [
  '/claim', '/balance', '/profile', '/inventory', '/shinobi_store', '/gift_store',
  '/buy', '/mission', '/patrol', '/map', '/ability',
];
const HELP_BLOCK_TWO = [
  '/kill', '/rob', '/protect', '/transfer', '/leaderboard', '/equip', '/unequip', '/redeem',
];
const HELP_FOOTER = ['/start', '/help', '/owner'];

function helpScreens() {
  const source = read('tgcloud/lib/welcome_ui.js')
    .replace(/^import .*;\n/gm, '').replaceAll('export ', '');
  return new Function('api', 'OWNER_ID', 'BOT_USERNAME', 'listCommands', 'PET_COMMANDS',
    `${source}; return { gameBlocks, petsBlocks, jutsuBlocks, funBlocks, moreGamesBlocks };`)(
    {}, 999, 'missfrozen_bot', listCommands, PET_COMMANDS);
}

const commandOf = (block) => String(block.text).trim().split(/\s+/)[0];

test('/help quotes the requested command blocks around rich dividers', async () => {
  const blocks = await welcome().buildUserHelpBlocks(user);
  const quotes = blocks.filter((b) => b.type === 'blockquote');
  assert.equal(quotes.length, 2, 'two quoted command blocks');
  assert.deepEqual(quotes[0].blocks.map(commandOf), HELP_BLOCK_ONE);
  assert.deepEqual(quotes[1].blocks.map(commandOf), HELP_BLOCK_TWO);

  // quote → divider → quote → divider → /start /help /owner
  assert.deepEqual(blocks.map((b) => b.type),
    ['heading', 'blockquote', 'divider', 'blockquote', 'divider',
      'paragraph', 'paragraph', 'paragraph', 'buttons', 'buttons']);
  const footer = blocks.slice(5, 8).map(commandOf);
  assert.deepEqual(footer, HELP_FOOTER);
  assert.doesNotMatch(JSON.stringify(blocks), /"type":"code"/);
});

test('/help buttons follow the PETS · JUTSU · FUN / MORE ❄️ GAMES · BACK layout', async () => {
  const fromWelcome = await welcome().buildUserHelpBlocks(user, true);
  const rows = fromWelcome.filter((b) => b.type === 'buttons').map((b) => b.buttons.map((x) => x.text));
  assert.deepEqual(rows, [['PETS', 'JUTSU', 'FUN'], ['MORE ❄️ GAMES', 'BACK']]);
  const data = fromWelcome.filter((b) => b.type === 'buttons').flatMap((b) => b.buttons.map((x) => x.callback_data));
  assert.deepEqual(data, ['hp:pets:w', 'hp:jutsu:w', 'hp:fun:w', 'hp:more:w', 'wel:back']);

  // Opened from /help (not from the welcome) Back returns to the help home.
  const fromCommand = await welcome().buildUserHelpBlocks(user);
  const commandData = fromCommand.filter((b) => b.type === 'buttons').flatMap((b) => b.buttons.map((x) => x.callback_data));
  assert.equal(commandData.at(-1), 'hp:main');
});

test('help keeps every command exactly once and never repeats an alias', () => {
  const built = helpScreens();
  const screens = {
    main: built.gameBlocks(false),
    pets: built.petsBlocks(false),
    jutsu: built.jutsuBlocks(false),
    fun: built.funBlocks(false),
    more: built.moreGamesBlocks(false),
  };
  const seen = new Map();
  const collect = (blocks) => {
    for (const block of blocks) {
      const paragraphs = block.type === 'blockquote' ? block.blocks : [block];
      for (const paragraph of paragraphs) {
        if (!paragraph || paragraph.type !== 'paragraph' || typeof paragraph.text !== 'string') continue;
        const cmd = commandOf(paragraph);
        if (!/^\/[a-z_]+$/i.test(cmd)) continue;
        seen.set(cmd, (seen.get(cmd) || 0) + 1);
      }
    }
  };
  for (const blocks of Object.values(screens)) collect(blocks);

  const expected = listCommands('user').filter((c) => !c.hidden).map((c) => c.cmd);
  assert.deepEqual([...seen.keys()].sort(), [...expected].sort(), 'every registered command is listed');
  assert.deepEqual([...seen].filter(([, n]) => n > 1), [], 'no command is listed twice');

  // Aliases still work but never get their own help line.
  for (const alias of Object.keys(ALIASES)) {
    assert.equal(seen.has(alias), false, `${alias} must not have its own help line`);
  }
  const text = JSON.stringify(screens);
  for (const alias of Object.keys(ALIASES)) {
    assert.match(text, new RegExp(alias.replace('/', '\\/')), `${alias} should be named as an alias`);
  }
});

test('PETS, JUTSU and FUN screens list their own commands only', () => {
  const built = helpScreens();
  const pets = built.petsBlocks(false).filter((b) => b.type === 'blockquote')
    .flatMap((b) => b.blocks.map(commandOf));
  assert.deepEqual(pets, PET_COMMANDS);

  // No pet command leaks into the main /help message.
  const mainCommands = JSON.stringify(built.gameBlocks(false));
  for (const cmd of PET_COMMANDS) {
    assert.equal(mainCommands.includes(`\\"${cmd} `), false, `${cmd} is behind the PETS button`);
  }

  const jutsu = built.jutsuBlocks(false).filter((b) => b.type === 'blockquote')
    .flatMap((b) => b.blocks.map(commandOf));
  assert.deepEqual(jutsu, ['/mt', '/byakugan']);
  assert.equal(jutsu.includes('/search_tsuna'), false,
    '/search_tsuna is removed from the JUTSU section (it stays a hidden command)');

  const fun = built.funBlocks(false).filter((b) => b.type === 'blockquote')
    .flatMap((b) => b.blocks.map(commandOf));
  assert.deepEqual(fun, ['/gift', '/hug', '/slap', '/punch', '/pat']);

  const more = built.moreGamesBlocks(false).filter((b) => b.type === 'blockquote')
    .flatMap((b) => b.blocks.map(commandOf));
  for (const cmd of ['/games', '/xoxo', '/rps', '/xoxo_stats', '/rps_stats']) {
    assert.ok(more.includes(cmd), cmd);
  }

  // Every sub-screen can go back to the help home.
  for (const blocks of [built.petsBlocks(true), built.jutsuBlocks(true), built.funBlocks(true), built.moreGamesBlocks(true)]) {
    const back = blocks.filter((b) => b.type === 'buttons').flatMap((b) => b.buttons);
    assert.equal(back.at(-1).callback_data, 'hp:main:w');
  }
});

test('help callbacks enable automatic command detection for every screen', async () => {
  const ui = welcome();
  for (const data of ['wel:help', 'hp:main', 'hp:pets', 'hp:jutsu', 'hp:fun', 'hp:more', 'hp:extras']) {
    await ui.handleWelcomeCallback({ id: 'cb', data, from: user, message: { chat: { id: 42 }, message_id: 1 } });
  }
  assert.equal(ui.calls.length, 7);
  for (const call of ui.calls) assert.notEqual(call.rich_message.skip_entity_detection, true);
});

test('help edit falls back to plain text that still lists commands and buttons', async () => {
  const source = read('tgcloud/lib/welcome_ui.js')
    .replace(/^import .*;\n/gm, '').replaceAll('export ', '');
  const calls = [];
  const api = {
    getMe: async () => ({ username: 'missfrozen_bot' }),
    answerCallbackQuery: async () => {},
    editMessageText: async (payload) => {
      if (payload.rich_message) throw new Error('rich messages unsupported');
      calls.push(payload);
    },
  };
  const ui = new Function('api', 'OWNER_ID', 'BOT_USERNAME', 'listCommands', 'PET_COMMANDS',
    `${source}; return { handleWelcomeCallback };`)(api, 999, 'missfrozen_bot', listCommands, PET_COMMANDS);

  await ui.handleWelcomeCallback({ id: 'cb', data: 'hp:pets', from: user, message: { chat: { id: 42 }, message_id: 1 } });
  assert.equal(calls.length, 1);
  assert.match(calls[0].text, /\/pet_store/);
  assert.match(calls[0].text, /Buy with/);
  const buttons = calls[0].reply_markup.inline_keyboard.flat();
  assert.deepEqual(buttons.map((b) => b.callback_data), ['hp:main']);
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
  assert.match(branch, /replyClaimPrompt\(message, cmd\)/);

  // DM: Mini App button · group: link that opens the bot DM (the text asks for it).
  const prompt = source.slice(source.indexOf('async function replyClaimPrompt'), source.indexOf('// Everything that touches coins'));
  assert.match(prompt, /web_app: \{ url: MINI_APP_URL \}/);
  // The group button lives in claim_reminder.js and is shared with the daily
  // reminder so /claim and the reminder can never drift.
  assert.match(prompt, /reply_markup: \{ inline_keyboard: \[\[\{ \.\.\.CLAIM_GROUP_BUTTON \}\]\] \}/);
  const reminders = read('tgcloud/lib/claim_reminder.js');
  assert.match(reminders, /\?start=mini_claim/);
  assert.match(reminders, /export const CLAIM_GROUP_BUTTON/);
  assert.match(prompt, /message\.chat\.type === 'private'/);
  assert.match(prompt, /CLAIM_ALREADY_TEXT/);
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
