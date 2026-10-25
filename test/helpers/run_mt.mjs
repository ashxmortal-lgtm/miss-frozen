// /mt delivery: every private message (receiver body + sender answer) must be an
// ephemeral send that Telegram accepts. Ephemeral sends need an eligible trigger
// (`reply_parameters.ephemeral_message_id`) or bot-admin rights — a plain
// message_id is not one. A refused ephemeral send falls back to the bot DM, and
// only a resolved delivery produces a success acknowledgement.
import assert from 'node:assert/strict';
import { api } from 'sdk';
import { db } from './sdk_db_stub.mjs';
import { handleMtCommand, resetMtRegistrationState } from '../../tgcloud/lib/mt.js';
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
let refuseDmFor = null;
let refuseSenderDm = false;
let refuseDelete = false;
let botStatus = 'administrator';

const isEphemeralTo = (payload, id) => Number(payload.ephemeral_message_parameters?.receiver_user_id) === id;

api.sendMessage = async (payload) => {
  if (refuseSenderDm && Number(payload.chat_id) === 8101 && !payload.ephemeral_message_parameters) {
    throw Object.assign(new Error('Forbidden: bot cannot initiate conversation with a user'), { code: 403 });
  }
  if (refuseDmFor != null && Number(payload.chat_id) === refuseDmFor && !payload.ephemeral_message_parameters) {
    throw Object.assign(new Error('Forbidden: bot was blocked by the user'), { code: 403 });
  }
  if (refuseEphemeralFor != null && payload.ephemeral_message_parameters
    && isEphemeralTo(payload, refuseEphemeralFor)) {
    throw Object.assign(new Error('Bad Request: ephemeral message is not supported'), { code: 400 });
  }
  sent.push(payload);
  return { message_id: sent.length };
};
api.deleteMessage = async (payload) => {
  if (refuseDelete) throw Object.assign(new Error('Bad Request: message to delete not found'), { code: 400 });
  deleted.push(payload);
  return true;
};
api.setMyCommands = async (payload) => { menus.push(payload); return true; };
api.getMyCommands = async () => menus.length ? menus.at(-1).commands : [];
api.getMe = async () => ({ id: 999001, username: 'frozen_bot', is_bot: true });
api.getChatMember = async () => ({ status: botStatus });

const OWNER = 8101;
const RECEIVER = 8102;
const NO_JUTSU = 8103;
const GROUP = -100810;

await db.run({
  text: `INSERT OR REPLACE INTO inventory (telegram_id, item_type, item_name, qty)
         VALUES (?, 'jutsu', 'Mind Transmission Jutsu', 1)`,
  params: [OWNER],
});

const message = ({
  from = OWNER, replyFrom = RECEIVER, text = '/mt hello there', id = 501, ephemeralId = null,
  replyIsBot = false,
} = {}) => ({
  text,
  message_id: ephemeralId ? 0 : id,
  ...(ephemeralId ? { ephemeral_message_id: ephemeralId } : {}),
  chat: { id: GROUP, type: 'supergroup', title: 'Konoha' },
  from: { id: from, first_name: 'Sender' },
  reply_to_message: replyFrom == null ? undefined : {
    message_id: 77,
    from: { id: replyFrom, first_name: 'Receiver', is_bot: replyIsBot },
  },
});

const ephemeralTo = (id) => sent.filter((p) => isEphemeralTo(p, id));
const plainTo = (id) => sent.filter((p) => Number(p.chat_id) === id && !p.ephemeral_message_parameters);
const textOf = (payload) => String(payload.text ?? payload.rich_message?.html ?? '');
const matches = (payload, text) => new RegExp(style(text)).test(textOf(payload));
const reset = () => { sent.length = 0; deleted.length = 0; };

// ---- 1. registration + delivery of a normal (non-ephemeral) command ----------
resetMtRegistrationState();
menus.length = 0;
assert.equal(await handleMtCommand(message()), true, '/mt is handled');

assert.equal(menus.length, 1, 'the group menu is registered once');
assert.deepEqual(menus[0].scope, { type: 'all_group_chats' });
const registered = menus[0].commands;
const mtEntry = registered.find((c) => c.command === 'mt');
assert.ok(mtEntry, '/mt is in the group menu');
assert.equal(mtEntry.is_ephemeral, true, '/mt is registered with is_ephemeral: true');
for (const cmd of ['help', 'balance', 'rob', 'protect', 'buy']) {
  assert.ok(registered.some((c) => c.command === cmd), `the group menu still lists /${cmd}`);
}
assert.ok(registered.length > 20, 'the whole user menu is sent, not just /mt');
assert.ok(!registered.some((c) => c.command === 'search_tsuna'), 'the hidden command stays out of the menu');
assert.equal(registered.filter((c) => c.is_ephemeral).length, 1, 'only /mt is ephemeral');

// ---- 2. receiver body + sender ack are ephemeral, and nothing is public ------
const toReceiver = ephemeralTo(RECEIVER);
assert.equal(toReceiver.length, 1, 'the receiver gets exactly one ephemeral message');
assert.equal(toReceiver[0].chat_id, GROUP, 'ephemeral messages are sent in the group, not a DM');
assert.equal(typeof toReceiver[0].ephemeral_message_parameters.receiver_user_id, 'number',
  'receiver_user_id is serialized as a JSON number');
assert.ok(matches(toReceiver[0], 'MIND TRANSMISSION'));
assert.ok(matches(toReceiver[0], 'hello there'));
assert.equal(toReceiver[0].reply_parameters, undefined,
  'a plain message_id is not an eligible ephemeral trigger, so none is sent');

const toSender = ephemeralTo(OWNER);
assert.equal(toSender.length, 1, 'the sender gets one ephemeral acknowledgement');
assert.ok(matches(toSender[0], 'MIND TRANSMISSION SENT'));
assert.ok(matches(toSender[0], 'delivered inside the group'));
assert.equal(sent.length, 2, 'no extra public message is produced');
assert.ok(sent.every((p) => p.ephemeral_message_parameters), 'every send is ephemeral');
assert.deepEqual(deleted, [{ chat_id: GROUP, message_id: 501 }], 'the plain /mt command is deleted');

// ---- 3. an ephemeral command replies with ephemeral_message_id ---------------
reset();
await handleMtCommand(message({ ephemeralId: 9001 }));
const replyToEphemeral = sent.filter((p) => p.reply_parameters?.ephemeral_message_id === 9001);
assert.equal(replyToEphemeral.length, 2, 'both ephemeral sends answer the ephemeral command');
assert.ok(replyToEphemeral.every((p) => p.reply_parameters.message_id === undefined),
  'message_id must not be set when replying to an ephemeral message');
assert.equal(deleted.length, 0, 'an already-ephemeral command is not deleted');

// ---- 4. refused ephemeral send falls back to the receiver DM ----------------
reset();
refuseEphemeralFor = RECEIVER;
await handleMtCommand(message());
refuseEphemeralFor = null;
const dm = plainTo(RECEIVER);
assert.equal(dm.length, 1, 'the body is delivered to the receiver DM');
assert.ok(matches(dm[0], 'hello there'));
const fallbackSender = ephemeralTo(OWNER);
assert.equal(fallbackSender.length, 1);
assert.ok(matches(fallbackSender[0], 'delivered to their bot DM'), 'the sender is told the DM fallback was used');

// ---- 5. a deletion failure never blocks the transmission --------------------
reset();
refuseDelete = true;
await handleMtCommand(message());
refuseDelete = false;
assert.equal(deleted.length, 0, 'the delete call failed');
assert.equal(ephemeralTo(RECEIVER).length, 1, 'the body is still delivered');
assert.equal(ephemeralTo(OWNER).length, 1, 'the sender still gets the success ack');
assert.ok(matches(ephemeralTo(OWNER)[0], 'MIND TRANSMISSION SENT'));

// ---- 6. bot is a plain member and nothing triggered: go straight to DM ------
resetMtRegistrationState();
reset();
botStatus = 'member';
await handleMtCommand(message());
botStatus = 'administrator';
assert.equal(ephemeralTo(RECEIVER).length, 0, 'no doomed ephemeral attempt for the receiver');
assert.equal(ephemeralTo(OWNER).length, 0, 'no doomed ephemeral attempt for the sender');
assert.equal(plainTo(RECEIVER).length, 1, 'the body goes to the receiver DM');
assert.equal(plainTo(OWNER).length, 1, 'the ack goes to the sender DM');
assert.ok(matches(plainTo(OWNER)[0], 'delivered to their bot DM'));

// ---- 7. a player without the jutsu gets the /buy hint -----------------------
reset();
await handleMtCommand(message({ from: NO_JUTSU }));
assert.equal(sent.length, 1);
assert.ok(sent[0].ephemeral_message_parameters, 'the refusal is ephemeral too');
assert.ok(matches(sent[0], 'JUTSU NOT UNLOCKED'));
assert.ok(!/don't own/i.test(textOf(sent[0])), 'the unlock card never claims the jutsu is missing');

// ---- 8. usage errors stay private -------------------------------------------
reset();
await handleMtCommand(message({ text: '/mt' }));
assert.ok(matches(ephemeralTo(OWNER)[0], 'MESSAGE REQUIRED'));

reset();
await handleMtCommand(message({ replyFrom: null }));
assert.ok(matches(ephemeralTo(OWNER)[0], 'REPLY REQUIRED'));

reset();
await handleMtCommand(message({ replyIsBot: true }));
assert.ok(matches(ephemeralTo(OWNER)[0], 'INVALID TARGET'));
assert.equal(ephemeralTo(RECEIVER).length, 0, 'nothing is transmitted to a bot');

reset();
await handleMtCommand(message({ replyFrom: OWNER }));
assert.ok(matches(ephemeralTo(OWNER)[0], 'INVALID TARGET'), 'self-targeting is refused');

reset();
await handleMtCommand(message({ text: `/mt ${'x'.repeat(1001)}` }));
assert.ok(matches(ephemeralTo(OWNER)[0], 'Message too long'));
assert.equal(ephemeralTo(RECEIVER).length, 0, 'an oversized payload is never delivered');

reset();
await handleMtCommand({ ...message(), chat: { id: OWNER, type: 'private' }, reply_to_message: undefined });
assert.ok(matches(plainTo(OWNER)[0], 'GROUP ONLY'));
assert.equal(plainTo(OWNER)[0].chat_id, OWNER, 'a DM answer goes back to the DM');

// ---- 9. delivery refused everywhere → failure ack, never success ------------
reset();
refuseEphemeralFor = RECEIVER;
refuseDmFor = RECEIVER;
await handleMtCommand(message());
refuseEphemeralFor = null;
refuseDmFor = null;
const failureAck = ephemeralTo(OWNER);
assert.equal(failureAck.length, 1, 'the sender still gets one answer');
assert.ok(matches(failureAck[0], 'TRANSMISSION FAILED'));
assert.ok(!matches(failureAck[0], 'MIND TRANSMISSION SENT'), 'no success ack for a rejected delivery');
assert.equal(ephemeralTo(RECEIVER).length, 0);

// ---- 10. both private routes refused: public status, never the private body --
reset();
refuseEphemeralFor = OWNER;
refuseSenderDm = true;
await handleMtCommand(message());
refuseEphemeralFor = null;
refuseSenderDm = false;
const publicStatus = sent.filter((p) => p.chat_id === GROUP && !p.ephemeral_message_parameters);
assert.equal(publicStatus.length, 1, 'the sender still gets an answer');
assert.ok(matches(publicStatus[0], 'MIND TRANSMISSION SENT'));
assert.deepEqual(publicStatus[0].reply_parameters, { message_id: 501, allow_sending_without_reply: true });
assert.ok(!sent.some((p) => p.chat_id === GROUP && textOf(p).includes('hello there')
  && !p.ephemeral_message_parameters), 'the transmitted body is never posted publicly');

// ---- 11. HTML-special characters in the payload stay escaped ----------------
reset();
await handleMtCommand(message({ text: '/mt <b>&x</b> "quoted"' }));
// Everything after the divider is the player's text: escaped, never raw markup.
const escaped = textOf(ephemeralTo(RECEIVER)[0]).split('───────────────').at(-1);
assert.ok(escaped.includes('&lt;'), 'the payload is HTML-escaped');
assert.ok(escaped.includes('&amp;'), 'ampersands are escaped');
assert.ok(!escaped.includes('<'), 'no raw angle bracket reaches parse_mode HTML');
assert.ok(!/&(?!lt;|gt;|amp;|quot;)/.test(escaped), 'a bare ampersand from the player never reaches the payload');

// ---- 12. every other command still goes to its own handler ------------------
reset();
assert.equal(await handleMtCommand({ ...message(), text: '/rob' }), false, '/rob is not /mt');
assert.equal(await handleMtCommand({ ...message(), text: '/protect' }), false, '/protect is not /mt');
assert.equal(sent.length, 0, '/mt stays silent for other commands');

console.log('mt delivery: OK');
