import assert from 'node:assert/strict';
import fs from 'node:fs';
import { api as sdkApi } from 'sdk';
import { jutsuScreenBlocks, jutsuCommandLines } from '../../tgcloud/lib/inventory.js';
import { formatBalanceText } from '../../tgcloud/lib/balance.js';
import { catalogBlocks, catalogTableRows } from '../../tgcloud/lib/gift.js';
import { ABILITY_URL } from '../../tgcloud/lib/ability.js';
import { healUnlocks, sakuraHealUnlocked } from '../../tgcloud/lib/rpg/training.js';
import {
  rememberInbound, replyParametersFor, forgetReplyTargets,
} from '../../tgcloud/lib/reply_target.js';
import { api } from '../../tgcloud/lib/message_api.js';
import { send } from '../../tgcloud/lib/chat.js';

const root = new URL('../../', import.meta.url);
const read = (rel) => fs.readFileSync(new URL(rel, root), 'utf8');

const buttonsOf = (blocks) => blocks.filter((b) => b?.type === 'buttons').flatMap((b) => b.buttons || []);
const quoteText = (block) => (block?.blocks || []).map((b) => b.text).join('\n');

// ---------- /inventory · JUTSU screen ----------
const heals = (blocks) => buttonsOf(blocks)
  .filter((b) => b.callback_data === 'inv:sakura' || b.callback_data === 'inv:katsuyu')
  .map(({ text, style }) => [text, style]);

// Nothing owned: no commands block, both skills locked (red).
const empty = jutsuScreenBlocks([], { sakura: false, katsuyu: false });
assert.equal(empty[0].text, '🌀 JUTSU');
assert.match(quoteText(empty[1]), /No jutsu unlocked yet/);
assert.ok(!empty.some((b) => b?.text === '⚡ COMMANDS'), 'no command list without jutsu');
assert.deepEqual(heals(empty), [["🌸 Sakura's Healing", 'danger'], ["🐌 Katsuyu's Healing", 'danger']]);
assert.equal(buttonsOf(empty).find((b) => b.text === '← Back').callback_data, 'inv:home');

// Owned jutsu lists /mt and /byakugan; unlocks turn the buttons green.
const owned = [
  { itemType: 'jutsu', itemName: 'Mind Transmission Jutsu', qty: 1 },
  { itemType: 'shinobi', itemName: 'Hinata', qty: 1 },
  { itemType: 'shinobi', itemName: 'Sasuke', qty: 1 },
];
const unlocked = jutsuScreenBlocks(owned, { sakura: true, katsuyu: true });
const cmdIndex = unlocked.findIndex((b) => b?.text === '⚡ COMMANDS');
assert.ok(cmdIndex > 0, 'commands section appears when a jutsu command is owned');
const cmdText = quoteText(unlocked[cmdIndex + 1]);
assert.match(cmdText, /^\/mt  —  /m);
assert.match(cmdText, /^\/byakugan  —  /m);
assert.deepEqual(heals(unlocked), [["🌸 Sakura's Healing", 'success'], ["🐌 Katsuyu's Healing", 'success']]);

// Only owned commands are listed.
assert.deepEqual(jutsuCommandLines([{ itemType: 'shinobi', itemName: 'Hinata' }]).map((l) => l.split('  —  ')[0]), ['/byakugan']);
assert.deepEqual(jutsuCommandLines([{ itemType: 'jutsu', itemName: 'Mind Transmission Jutsu' }]).map((l) => l.split('  —  ')[0]), ['/mt']);
assert.deepEqual(jutsuCommandLines([{ itemType: 'shinobi', itemName: 'Sasuke' }]), []);

// The main inventory menu no longer carries the healing buttons.
const inventorySource = read('tgcloud/lib/inventory.js');
const mainScreen = inventorySource.slice(
  inventorySource.indexOf('export async function buildInventoryBlocks'),
  inventorySource.indexOf('export async function buildOwnedGiftsBlocks'),
);
assert.doesNotMatch(mainScreen, /inv:sakura|inv:katsuyu/, 'heals moved out of the main menu');
assert.match(mainScreen, /cb\('🌀 Jutsu', 'inv:jutsu'/);

// Unlock flags only move forward (green stays green).
assert.equal(sakuraHealUnlocked(3), false);
assert.equal(sakuraHealUnlocked(4), true);
assert.deepEqual(healUnlocks(1, 0), { sakura: false, katsuyu: false });
assert.deepEqual(healUnlocks(4, 2), { sakura: true, katsuyu: false });
assert.deepEqual(healUnlocks(4, 3), { sakura: true, katsuyu: true });
assert.deepEqual(healUnlocks(4, 99), { sakura: true, katsuyu: true });

// ---------- /balance card ----------
const card = formatBalanceText({
  mentionHtml: '<a href="tg://user?id=7">Tester</a>',
  balance: 101556, kills: 1, rankName: 'Academy Student', chakra: 300,
});
assert.equal(
  card,
  '<a href="tg://user?id=7">Tester</a>\'ꜱ ʙᴀʟᴀɴᴄᴇ\n\n<blockquote>' +
  '🍥 ᴄᴏɪɴꜱ: 101,556\n🔪 ᴋɪʟʟꜱ: 1\n🥷🏻 ꜱʜɪɴᴏʙɪ ʀᴀɴᴋ: Academy Student\n⚡ ᴄʜᴀᴋʀᴀ: 300' +
  '</blockquote>',
);
const ranked = formatBalanceText({
  mentionHtml: 'T', balance: 5, kills: 0, rankName: 'Genin', chakra: 0, rank: '#2', pending: 40,
});
assert.match(ranked, /🍥 ᴄᴏɪɴꜱ: 5 {2}#2\n/);
assert.match(ranked, /\n⏳ ᴘᴇɴᴅɪɴɢ ʀᴇᴡᴀʀᴅꜱ: 40 🍥\n→ ᴄʟᴀɪᴍ ᴀᴛ ʜᴏᴋᴀɢᴇ ᴏꜰꜰɪᴄᴇ: \/map/);
const quoteBody = ranked.slice(ranked.indexOf('<blockquote>') + 12, ranked.indexOf('</blockquote>'));
assert.ok(!quoteBody.includes('\n\n'), 'one row per line, no blank spacer rows');
assert.match(ranked, /^T'ꜱ ʙᴀʟᴀɴᴄᴇ\n\n<blockquote>[\s\S]*<\/blockquote>$/);

// ---------- /gift_store rich table ----------
const rows = catalogTableRows();
assert.equal(rows.length, 13);
assert.deepEqual(rows[0], ['#', 'Gift', 'Price']);
assert.deepEqual(rows[1], ['1', "🌹 Konan's Rose", '100 🍥']);
assert.equal(rows[12][2], '3,000 🍥');
const catalog = catalogBlocks();
const tableBlock = catalog.find((b) => b?.type === 'table');
assert.ok(tableBlock, 'catalog is a rich table now');
assert.equal(tableBlock.is_bordered, true);
assert.equal(tableBlock.is_compact, true);
assert.deepEqual(tableBlock.cells[0], [{ text: '#' }, { text: 'Gift' }, { text: 'Price' }]);
assert.equal(tableBlock.cells.length, 13);
assert.ok(!catalog.some((b) => b?.type === 'details'), 'collapsible list replaced');
assert.ok(catalog.some((b) => b?.type === 'buttons' && b.buttons[0].callback_data === 'gift:mine'));

// ---------- /ability link ----------
assert.equal(ABILITY_URL, 'https://t.me/frozenblooded/8');
assert.match(read('tgcloud/lib/ability.js'), /https:\/\/t\.me\/frozenblooded\/8/);
assert.match(read('tgcloud/lib/rich.js'), /url: ABILITY_URL/, 'rich ability button shares the link');
assert.ok(!/frozenblooded\/27/.test(read('tgcloud/lib/ability.js') + read('tgcloud/lib/rich.js')));

// ---------- replies to the triggering command ----------
const sent = [];
sdkApi.sendMessage = async (payload) => { sent.push(payload); return { message_id: sent.length }; };
sdkApi.sendRichMessage = async (payload) => { sent.push(payload); return { message_id: sent.length }; };

forgetReplyTargets();
rememberInbound({ chat: { id: 42 }, message_id: 777, text: '/balance' });
await api.sendMessage({ chat_id: 42, text: 'hi' });
assert.deepEqual(sent.at(-1).reply_parameters, { message_id: 777, allow_sending_without_reply: true });

// Another chat is never replied to.
await api.sendMessage({ chat_id: 43, text: 'hi' });
assert.equal(sent.at(-1).reply_parameters, undefined);

// Background sends opt out and the flag never reaches the Bot API.
await api.sendMessage({ chat_id: 42, text: 'reminder', disable_reply_target: true });
assert.equal(sent.at(-1).reply_parameters, undefined);
assert.ok(!('disable_reply_target' in sent.at(-1)));

// Rich sends answer too; explicit reply_parameters are respected; ephemeral is skipped.
await api.sendRichMessage({ chat_id: 42, rich_message: { blocks: [] } });
assert.deepEqual(sent.at(-1).reply_parameters, { message_id: 777, allow_sending_without_reply: true });
await api.sendMessage({ chat_id: 42, text: 'x', reply_parameters: { message_id: 5 } });
assert.deepEqual(sent.at(-1).reply_parameters, { message_id: 5 });
await api.sendMessage({ chat_id: 42, text: 'x', ephemeral_message_parameters: { receiver_user_id: 9 } });
assert.equal(sent.at(-1).reply_parameters, undefined);

// /balance keeps the classic path (mention + blank lines) and still replies.
rememberInbound({ chat: { id: 42 }, message_id: 901, text: '/balance' });
await send(42, { text: '<blockquote>🍥 a\n\n🔪 b</blockquote>', parse_mode: 'HTML', classic: true });
assert.match(sent.at(-1).text, /^<blockquote>/);
assert.ok(!('classic' in sent.at(-1)), 'the classic flag never reaches the Bot API');
assert.deepEqual(sent.at(-1).reply_parameters, { message_id: 901, allow_sending_without_reply: true });

// Edits are not replies.
assert.equal(replyParametersFor(42) !== null, true);
assert.equal(replyParametersFor(42, Date.now() + 61_000), null);
forgetReplyTargets();
await api.sendMessage({ chat_id: 42, text: 'no target' });
assert.equal(sent.at(-1).reply_parameters, undefined);

console.log('ui updates: OK');
