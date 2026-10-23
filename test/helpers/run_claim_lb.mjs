// /claim · /daily prompts and the /lb boards: claim lives in the Mini App, and
// the Global leaderboard button edits the same message instead of sending a
// second one.
import assert from 'node:assert/strict';
import { api, BotApiError } from 'sdk';
import { db } from './sdk_db_stub.mjs';
import { style } from '../../tgcloud/lib/texts.js';
import { todayKey } from '../../tgcloud/lib/economy.js';
import {
  CLAIM_DM_TEXT, CLAIM_ALREADY_TEXT, CLAIM_GROUP_TEXT,
  handleEconomyCommand, handleEconomyCallback,
} from '../../tgcloud/lib/economy_handler.js';

for (const text of [
  `CREATE TABLE IF NOT EXISTS users (
    telegram_id INTEGER PRIMARY KEY, balance INTEGER DEFAULT 0, xp INTEGER DEFAULT 0,
    kills INTEGER DEFAULT 0, username TEXT, first_name TEXT, equipped TEXT,
    last_claim_date TEXT, claim_streak INTEGER DEFAULT 0, naruto_patrols INTEGER DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS group_members (
    chat_id INTEGER, telegram_id INTEGER, PRIMARY KEY (chat_id, telegram_id))`,
]) await db.run({ text, params: [] });

const U = 42;
const GROUP = -1001;
const sent = [];
const edits = [];
const answers = [];
let failRichEdits = false;

api.sendMessage = async (payload) => { sent.push(payload); return { message_id: sent.length }; };
api.sendRichMessage = async (payload) => { sent.push(payload); return { message_id: 100 + sent.length }; };
api.editMessageText = async (payload) => {
  if (failRichEdits && payload.rich_message) {
    throw Object.assign(new BotApiError('rich messages unsupported'), { code: 400 });
  }
  edits.push(payload);
  return {};
};
api.answerCallbackQuery = async (payload) => { answers.push(payload); return {}; };

const htmlOf = (payload) => String(payload.rich_message?.html ?? '');
// Rich HTML wraps every paragraph; compare the visible lines instead.
const linesOf = (value) => String(value)
  .replace(/<\/p>/g, '\n')
  .replace(/<[^>]+>/g, '')
  .split('\n').map((line) => line.trim()).filter(Boolean);
const blocksOf = (payload) => payload.rich_message?.blocks || [];
const allText = (blocks) => blocks.map((b) => {
  if (typeof b.text === 'string') return b.text;
  if (Array.isArray(b.cells)) {
    return b.cells.flat().map((c) => (typeof c === 'string' ? c : c?.text ?? '')).join(' ');
  }
  return '';
}).join('\n');
const buttonsOf = (blocks) => blocks.filter((b) => b.type === 'buttons').flatMap((b) => b.buttons);

const message = (text, type = 'private') => ({
  text,
  message_id: 7,
  chat: { id: type === 'private' ? U : GROUP, type },
  from: { id: U, first_name: 'Shinobi', username: 'shin' },
});

await db.run({
  text: `INSERT OR IGNORE INTO users (telegram_id, balance, first_name) VALUES (?, 0, 'Shinobi')`,
  params: [U],
});

// ---- /claim in DM ---------------------------------------------------------------
sent.length = 0;
await handleEconomyCommand(message('/claim'));
const dmClaim = sent.at(-1);
assert.ok(htmlOf(dmClaim).includes(style(CLAIM_DM_TEXT)), `DM claim text: ${htmlOf(dmClaim)}`);
assert.match(htmlOf(dmClaim), /<tg-button[^>]*type="web_app"[^>]*url="https:\/\/app8888370613\.tgcloud\.ai\/"/);

sent.length = 0;
await handleEconomyCommand(message('/daily'));
assert.ok(htmlOf(sent.at(-1)).includes(style(CLAIM_DM_TEXT)), '/daily shares the DM prompt');

// ---- /claim · /daily in a group -------------------------------------------------
sent.length = 0;
await handleEconomyCommand(message('/claim', 'group'));
const groupClaim = sent.at(-1);
assert.ok(htmlOf(groupClaim).includes(style(CLAIM_GROUP_TEXT.claim)), `group claim text: ${htmlOf(groupClaim)}`);
assert.ok(htmlOf(groupClaim).includes('https://t.me/missfrozen_bot?start=mini_claim'));
assert.doesNotMatch(htmlOf(groupClaim), /type="web_app"/, 'no Mini App button inside a group');

sent.length = 0;
await handleEconomyCommand(message('/daily', 'group'));
const groupDaily = sent.at(-1);
assert.ok(htmlOf(groupDaily).includes(style(CLAIM_GROUP_TEXT.daily)), `group daily text: ${htmlOf(groupDaily)}`);
assert.ok(htmlOf(groupDaily).includes('/daily'));

// ---- already claimed today ------------------------------------------------------
await db.run({
  text: `UPDATE users SET last_claim_date = ? WHERE telegram_id = ?`,
  params: [todayKey(), U],
});
for (const [cmd, type] of [['/claim', 'private'], ['/daily', 'private'], ['/claim', 'group'], ['/daily', 'group']]) {
  sent.length = 0;
  await handleEconomyCommand(message(cmd, type));
  const payload = sent.at(-1);
  const text = payload.text ?? htmlOf(payload);
  assert.deepEqual(
    linesOf(text), linesOf(style(CLAIM_ALREADY_TEXT)),
    `already-claimed text (${cmd} ${type}): ${text}`,
  );
  assert.equal(payload.reply_markup, undefined);
  assert.doesNotMatch(htmlOf(payload), /tg-button-row/, 'no claim button after claiming');
}
await db.run({ text: `UPDATE users SET last_claim_date = NULL WHERE telegram_id = ?`, params: [U] });

// ---- /lb in a group sends the group board + a Global button ----------------------
await db.run({
  text: `INSERT OR IGNORE INTO users (telegram_id, balance, first_name) VALUES (1, 500, 'A'), (2, 900, 'B')`,
  params: [],
});
await db.run({
  text: `INSERT OR REPLACE INTO group_members (chat_id, telegram_id) VALUES (?, 1), (?, 2)`,
  params: [GROUP, GROUP],
});

sent.length = 0;
await handleEconomyCommand(message('/lb', 'group'));
const groupBoard = blocksOf(sent.at(-1));
assert.ok(allText(groupBoard).includes(style('🏆 Group Leaderboard')));
assert.deepEqual(buttonsOf(groupBoard).map((b) => b.callback_data), ['lb:global']);

// ---- Global button edits the same message ---------------------------------------
const callback = (data) => ({
  id: `cb-${data}`, data, from: { id: U, first_name: 'Shinobi' },
  message: { chat: { id: GROUP, type: 'group' }, message_id: 55 },
});

const sendsBefore = sent.length;
edits.length = 0;
answers.length = 0;
await handleEconomyCallback(callback('lb:global'));
assert.equal(answers.at(-1)?.callback_query_id, 'cb-lb:global');
assert.equal(sent.length, sendsBefore, 'no second message is sent');
assert.equal(edits.length, 1, 'the tapped message is edited');
const globalEdit = edits.at(-1);
assert.equal(globalEdit.chat_id, GROUP);
assert.equal(globalEdit.message_id, 55);
const globalBoard = blocksOf(globalEdit);
assert.ok(allText(globalBoard).includes(style('🌍 Global Leaderboard')));
assert.ok(!allText(globalBoard).includes(style('🏆 Group Leaderboard')));
assert.deepEqual(buttonsOf(globalBoard).map((b) => b.callback_data), ['lb:group'], 'back to the group board');

// ---- and the way back edits the same message too --------------------------------
edits.length = 0;
await handleEconomyCallback(callback('lb:group'));
assert.equal(edits.length, 1);
const backToGroup = blocksOf(edits.at(-1));
assert.ok(allText(backToGroup).includes(style('🏆 Group Leaderboard')));
assert.deepEqual(buttonsOf(backToGroup).map((b) => b.callback_data), ['lb:global']);

// ---- private /lb sends the global board without a back button -------------------
sent.length = 0;
await handleEconomyCommand(message('/lb'));
const dmBoard = blocksOf(sent.at(-1));
assert.ok(allText(dmBoard).includes(style('🌍 Global Leaderboard')));
assert.deepEqual(buttonsOf(dmBoard), []);

// ---- rich edits fall back to a classic text edit --------------------------------
edits.length = 0;
failRichEdits = true;
await handleEconomyCallback(callback('lb:global'));
failRichEdits = false;
assert.equal(edits.length, 1, 'classic fallback still edits the message');
assert.equal(edits.at(-1).rich_message, undefined, 'classic payload, no rich_message');
assert.ok(linesOf(edits.at(-1).text || '').join(' ').includes(style('Global Leaderboard')));
assert.deepEqual(
  edits.at(-1).reply_markup.inline_keyboard.flat().map((b) => b.callback_data),
  ['lb:group'],
);

console.log('claim & leaderboard: OK');
