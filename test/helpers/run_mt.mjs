// /mt ephemeral transmission: the sender's answer and the receiver's body both
// have to go out as ephemeral messages tied to the triggering command, otherwise
// Telegram refuses them and the jutsu looks broken. A refused ephemeral send
// falls back to the bot DM (still private) instead of staying silent.
import assert from 'node:assert/strict';
import { api } from 'sdk';
import { db } from './sdk_db_stub.mjs';
import { handleMtCommand } from '../../tgcloud/lib/mt.js';
import { style } from '../../tgcloud/lib/texts.js';

for (const text of [
  `CREATE TABLE IF NOT EXISTS inventory (
    telegram_id INTEGER, item_type TEXT, item_name TEXT, qty INTEGER DEFAULT 1,
    PRIMARY KEY (telegram_id, item_name))`,
]) await db.run({ text, params: [] });

const sent = [];
const deleted = [];
const menus = [];
let refuseEphemeralFor = null;
let refuseSenderDm = false;

api.sendMessage = async (payload) => {
  if (refuseSenderDm && Number(payload.chat_id) === 8101 && !payload.ephemeral_message_parameters) {
    throw Object.assign(new Error('Forbidden: bot cannot initiate conversation with a user'), { code: 403 });
  }
  if (
    refuseEphemeralFor != null
    && payload.ephemeral_message_parameters
    && Number(payload.ephemeral_message_parameters.receiver_user_id) === refuseEphemeralFor
  ) {
    throw Object.assign(new Error('Bad Request: ephemeral message is not supported'), { code: 400 });
  }
  sent.push(payload);
  return { message_id: sent.length };
};
api.deleteMessage = async (payload) => { deleted.push(payload); return true; };
api.setMyCommands = async (payload) => { menus.push(payload); return true; };
api.getMe = async () => ({ username: 'frozen_bot', is_bot: true });

const OWNER = 8101;
const RECEIVER = 8102;
const NO_JUTSU = 8103;
const GROUP = -100810;

await db.run({
  text: `INSERT OR REPLACE INTO inventory (telegram_id, item_type, item_name, qty)
         VALUES (?, 'jutsu', 'Mind Transmission Jutsu', 1)`,
  params: [OWNER],
});

const message = ({ from = OWNER, replyFrom = RECEIVER, text = '/mt hello there', id = 501, ephemeralId = null }) => ({
  text,
  message_id: ephemeralId ? 0 : id,
  ...(ephemeralId ? { ephemeral_message_id: ephemeralId } : {}),
  chat: { id: GROUP, type: 'supergroup', title: 'Konoha' },
  from: { id: from, first_name: 'Sender' },
  reply_to_message: replyFrom == null ? undefined : {
    message_id: 77,
    from: { id: replyFrom, first_name: 'Receiver' },
  },
});

const ephemeralTo = (id) => sent.filter((p) => Number(p.ephemeral_message_parameters?.receiver_user_id) === id);
const textOf = (payload) => String(payload.text ?? payload.rich_message?.html ?? '');

// ---- 1. the group command menu keeps every command, /mt marked ephemeral ----
sent.length = 0;
assert.equal(await handleMtCommand(message({})), true, '/mt is handled');

assert.equal(menus.length, 1, 'the ephemeral command list is registered once');
const registered = menus[0].commands;
assert.equal(menus[0].scope.type, 'all_group_chats');
const mtEntry = registered.find((c) => c.command === 'mt');
assert.ok(mtEntry, '/mt is in the group menu');
assert.equal(mtEntry.is_ephemeral, true, '/mt is an ephemeral command');
for (const cmd of ['help', 'balance', 'rob', 'protect', 'buy']) {
  assert.ok(registered.some((c) => c.command === cmd), `the group menu still lists /${cmd}`);
}
assert.ok(registered.length > 20, 'the whole user menu is sent, not just /mt');
assert.ok(!registered.some((c) => c.command === 'search_tsuna'), 'hidden discovery command stays out of the menu');

// ---- 2. receiver body + sender confirmation are both ephemeral ---------------
const toReceiver = ephemeralTo(RECEIVER);
assert.equal(toReceiver.length, 1, 'the receiver gets exactly one ephemeral message');
assert.equal(toReceiver[0].chat_id, GROUP, 'ephemeral messages are sent in the group, not a DM');
assert.match(textOf(toReceiver[0]), new RegExp(style('MIND TRANSMISSION')));
assert.match(textOf(toReceiver[0]), new RegExp(style('hello there')));
assert.deepEqual(
  toReceiver[0].reply_parameters,
  { message_id: 501, allow_sending_without_reply: true },
  'the receiver message is tied to the triggering command (Telegram rejects it otherwise)',
);

const toSender = ephemeralTo(OWNER);
assert.equal(toSender.length, 1, 'the sender gets one ephemeral confirmation');
assert.match(textOf(toSender[0]), new RegExp(style('MIND TRANSMISSION SENT')));
assert.match(textOf(toSender[0]), new RegExp(style('delivered inside the group')));

// Nothing reachable by the rest of the group: every send is ephemeral.
assert.equal(sent.length, 2);
assert.ok(sent.every((p) => p.ephemeral_message_parameters), 'no group-visible message is produced');

// The plain /mt command message is deleted so the group timeline stays clean.
assert.deepEqual(deleted, [{ chat_id: GROUP, message_id: 501 }]);

// ---- 3. an ephemeral command replies with ephemeral_message_id ---------------
sent.length = 0;
deleted.length = 0;
await handleMtCommand(message({ ephemeralId: 9001 }));
const replyToEphemeral = sent.filter((p) => p.reply_parameters?.ephemeral_message_id === 9001);
assert.equal(replyToEphemeral.length, 2, 'both ephemeral sends answer the ephemeral command');
assert.ok(replyToEphemeral.every((p) => p.reply_parameters.message_id === undefined),
  'message_id must not be set when replying to an ephemeral message');
assert.equal(deleted.length, 0, 'an already-ephemeral command is not deleted');

// ---- 4. refused ephemeral send falls back to the bot DM ----------------------
sent.length = 0;
refuseEphemeralFor = RECEIVER;
await handleMtCommand(message({}));
refuseEphemeralFor = null;
const dm = sent.filter((p) => p.chat_id === RECEIVER && !p.ephemeral_message_parameters);
assert.equal(dm.length, 1, 'the body is delivered to the receiver DM');
assert.match(textOf(dm[0]), new RegExp(style('hello there')));
const fallbackSender = ephemeralTo(OWNER);
assert.equal(fallbackSender.length, 1);
assert.match(textOf(fallbackSender[0]), new RegExp(style('bot DM')), 'the sender is told the DM fallback was used');

// ---- 5. a player without the jutsu gets the /buy hint, never "don't own" -----
sent.length = 0;
await handleMtCommand(message({ from: NO_JUTSU }));
assert.equal(sent.length, 1);
assert.ok(sent[0].ephemeral_message_parameters, 'the refusal is ephemeral too');
const refusal = textOf(sent[0]);
assert.match(refusal, new RegExp(style('JUTSU NOT UNLOCKED')));
assert.match(refusal, new RegExp(style('Mind Transmission Jutsu')));
assert.ok(!/don't own/i.test(refusal), 'the unlock card never claims the jutsu is missing from the inventory');

// ---- 6. usage errors stay private -------------------------------------------
sent.length = 0;
await handleMtCommand(message({ text: '/mt' }));
assert.match(textOf(sent[0]), new RegExp(style('MESSAGE REQUIRED')));
assert.ok(sent[0].ephemeral_message_parameters);

sent.length = 0;
await handleMtCommand(message({ replyFrom: null }));
assert.match(textOf(sent[0]), new RegExp(style('REPLY REQUIRED')));

sent.length = 0;
await handleMtCommand({ ...message({}), chat: { id: OWNER, type: 'private' }, reply_to_message: undefined });
assert.match(textOf(sent[0]), new RegExp(style('GROUP ONLY')));
assert.equal(sent[0].chat_id, OWNER, 'a DM answer goes back to the DM');

// ---- 7. both private routes refused: a short public status, never silence ----
sent.length = 0;
refuseEphemeralFor = OWNER;
refuseSenderDm = true;
await handleMtCommand(message({}));
refuseEphemeralFor = null;
refuseSenderDm = false;
const publicStatus = sent.filter((p) => p.chat_id === GROUP && !p.ephemeral_message_parameters);
assert.equal(publicStatus.length, 1, 'the sender still gets an answer');
assert.match(textOf(publicStatus[0]), new RegExp(style('MIND TRANSMISSION SENT')));
assert.deepEqual(publicStatus[0].reply_parameters, { message_id: 501, allow_sending_without_reply: true });
assert.ok(!sent.some((p) => p.chat_id === GROUP && /hello there/.test(textOf(p)) && !p.ephemeral_message_parameters),
  'the transmitted body is never posted publicly');

console.log('mt ephemeral: OK');
