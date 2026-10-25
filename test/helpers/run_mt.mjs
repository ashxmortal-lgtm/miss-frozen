// /mt delivery: the transmitted body must appear only as a private (ephemeral)
// in-group message — never public, never a DM. Bot API 10.2 uses a flat
// `receiver_user_id`, 10.3 uses `ephemeral_message_parameters`; the payload
// carries both, every send is verified from its response, and a build that
// ignores the parameters (a public post) gets that copy deleted immediately.
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
const publicPosts = []; // messages Telegram actually showed to the group
let generation = '10.3'; // '10.3' | '10.2' | 'legacy' (ignores ephemeral params)
let refuseEphemeralFor = null;
let refuseDmFor = null;
let refuseDelete = false;
let ephemeralSeq = 0;
let publicSeq = 0;

const isEphemeralPayload = (p) => Boolean(p.ephemeral_message_parameters || p.receiver_user_id);

// A tiny emulation of the Bot API generations.
function deliver(payload) {
  if (isEphemeralPayload(payload)) {
    const nestedHonoured = Boolean(payload.ephemeral_message_parameters) && generation === '10.3';
    const flatHonoured = Boolean(payload.receiver_user_id) && generation === '10.2';
    const receiver = Number(payload.ephemeral_message_parameters?.receiver_user_id ?? payload.receiver_user_id);
    if (refuseEphemeralFor != null && receiver === refuseEphemeralFor) {
      throw Object.assign(new Error('Bad Request: ephemeral message is not supported'), { code: 400 });
    }
    sent.push(payload);
    // An unhonoured shape is NOT an error: Telegram ignores the field and the
    // message is posted to the group.
    if (nestedHonoured || flatHonoured) {
      return { message_id: 0, ephemeral_message_id: ++ephemeralSeq };
    }
    const leaked = { chat_id: Number(payload.chat_id), message_id: ++publicSeq };
    publicPosts.push(leaked);
    return { message_id: leaked.message_id };
  }
  if (refuseDmFor != null && Number(payload.chat_id) === refuseDmFor) {
    throw Object.assign(new Error('Forbidden: bot was blocked by the user'), { code: 403 });
  }
  sent.push(payload);
  return { message_id: ++publicSeq };
}

api.sendMessage = async (payload) => deliver(payload);
api.deleteMessage = async (payload) => {
  if (refuseDelete) throw Object.assign(new Error('Bad Request: message to delete not found'), { code: 400 });
  deleted.push(payload);
  return true;
};
api.setMyCommands = async (payload) => { menus.push(payload); return true; };
api.getMyCommands = async () => menus.length ? menus.at(-1).commands : [];
api.getMe = async () => ({ id: 999001, username: 'frozen_bot', is_bot: true });
api.getChatMember = async () => ({ status: 'administrator' });

const OWNER = 8101;
const RECEIVER = 8102;
const NO_JUTSU = 8103;
const GROUP = -100810;
const BODY = 'hello there';

await db.run({
  text: `INSERT OR REPLACE INTO inventory (telegram_id, item_type, item_name, qty)
         VALUES (?, 'jutsu', 'Mind Transmission Jutsu', 1)`,
  params: [OWNER],
});

const message = ({
  from = OWNER, replyFrom = RECEIVER, text = `/mt ${BODY}`, id = 501, ephemeralId = null,
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

const receiverOf = (p) => Number(p.ephemeral_message_parameters?.receiver_user_id ?? p.receiver_user_id);
const ephemeralTo = (id) => sent.filter((p) => isEphemeralPayload(p) && receiverOf(p) === id);
const plainTo = (id) => sent.filter((p) => Number(p.chat_id) === id && !isEphemeralPayload(p));
const publicInGroup = () => sent.filter((p) => Number(p.chat_id) === GROUP && !isEphemeralPayload(p));
const textOf = (payload) => String(payload.text ?? payload.rich_message?.html ?? '');
const matches = (payload, text) => new RegExp(style(text)).test(textOf(payload));
// Each case starts from a cold isolate: cached registration/capability state is
// per isolate, and every case must be independent.
const reset = () => {
  sent.length = 0; deleted.length = 0; publicPosts.length = 0;
  resetMtRegistrationState();
};

// ---- 1. registration + delivery on a Bot API 10.3 build ----------------------
resetMtRegistrationState();
menus.length = 0;
assert.equal(await handleMtCommand(message()), true, '/mt is handled');
assert.equal(menus.length, 1, 'the group menu is registered once');
const registered = menus[0].commands;
assert.deepEqual(menus[0].scope, { type: 'all_group_chats' });
const mtEntry = registered.find((c) => c.command === 'mt');
assert.equal(mtEntry.is_ephemeral, true, '/mt is registered with is_ephemeral: true');
for (const cmd of ['help', 'balance', 'rob', 'protect', 'buy']) {
  assert.ok(registered.some((c) => c.command === cmd), `the group menu still lists /${cmd}`);
}
assert.ok(registered.length > 20, 'the whole user menu is sent, not just /mt');
assert.ok(!registered.some((c) => c.command === 'search_tsuna'), 'the hidden command stays out');

// ---- 2. the body is private and never public --------------------------------
const toReceiver = ephemeralTo(RECEIVER);
assert.equal(toReceiver.length, 1, 'the receiver gets exactly one ephemeral message');
assert.equal(toReceiver[0].chat_id, GROUP, 'it is sent inside the group, not a DM');
assert.equal(receiverOf(toReceiver[0]), RECEIVER, 'receiver_user_id is the target');
assert.equal(typeof receiverOf(toReceiver[0]), 'number', 'receiver_user_id is a JSON number');
assert.ok(toReceiver[0].ephemeral_message_parameters, 'the 10.3 shape is present');
assert.equal(toReceiver[0].receiver_user_id, RECEIVER, 'the 10.2 shape is present too');
assert.ok(matches(toReceiver[0], 'MIND TRANSMISSION'));
assert.ok(matches(toReceiver[0], BODY));
assert.equal(toReceiver[0].reply_parameters, undefined,
  'a plain message_id is not an eligible ephemeral trigger, so none is sent');

const toSender = ephemeralTo(OWNER);
assert.equal(toSender.length, 1, 'the sender gets one ephemeral acknowledgement');
assert.ok(matches(toSender[0], 'MIND TRANSMISSION SENT'));

assert.deepEqual(publicInGroup(), [], 'nothing is visible to the group');
assert.deepEqual(plainTo(RECEIVER), [], 'the body is never sent to a DM');
assert.ok(!sent.some((p) => !isEphemeralPayload(p)), 'no non-ephemeral send at all');
assert.deepEqual(deleted, [{ chat_id: GROUP, message_id: 501 }], 'the plain /mt command is deleted');

// ---- 3. an ephemeral command replies with ephemeral_message_id ---------------
reset();
await handleMtCommand(message({ ephemeralId: 9001 }));
const replyToEphemeral = sent.filter((p) => p.reply_parameters?.ephemeral_message_id === 9001);
assert.equal(replyToEphemeral.length, 2, 'both ephemeral sends answer the ephemeral command');
assert.ok(replyToEphemeral.every((p) => p.reply_parameters.message_id === undefined),
  'message_id must not be set when replying to an ephemeral message');
assert.equal(deleted.length, 0, 'an already-ephemeral command is not deleted');

// ---- 4. a Bot API 10.2 build (flat receiver_user_id only) still works -------
resetMtRegistrationState();
reset();
generation = '10.2';
assert.equal(await handleMtCommand(message()), true);
generation = '10.3';
assert.equal(ephemeralTo(RECEIVER).length, 1, 'the body is delivered privately');
assert.equal(ephemeralTo(OWNER).length, 1, 'the ack is private');
assert.deepEqual(publicInGroup(), [], 'no public post on the 10.2 build');
assert.ok(matches(ephemeralTo(RECEIVER)[0], BODY));

// ---- 5. a build that ignores ephemeral parameters never leaks ---------------
resetMtRegistrationState();
reset();
generation = 'legacy';
await handleMtCommand(message());
generation = '10.3';
assert.ok(publicPosts.length >= 1, 'the legacy build posted the message publicly');
// Every leaked copy is deleted immediately, in addition to the /mt command.
for (const leak of publicPosts) {
  assert.ok(deleted.some((d) => d.chat_id === leak.chat_id && d.message_id === leak.message_id),
    `leaked message ${leak.message_id} was deleted`);
}
assert.ok(deleted.some((d) => d.message_id === 501), 'the /mt command was deleted too');
assert.deepEqual(plainTo(RECEIVER), [], 'the body is never rerouted to a DM');
const legacyAck = plainTo(OWNER);
assert.equal(legacyAck.length, 1, 'the sender is told privately (DM status only)');
assert.ok(matches(legacyAck[0], 'TRANSMISSION FAILED'));
assert.ok(!textOf(legacyAck[0]).includes(BODY), 'the status never repeats the private text');
assert.ok(!sent.some((p) => matches(p, 'MIND TRANSMISSION SENT')), 'no success ack');

// ---- 6. a refused ephemeral send is a failure, not a DM ---------------------
resetMtRegistrationState();
reset();
refuseEphemeralFor = RECEIVER;
await handleMtCommand(message());
refuseEphemeralFor = null;
assert.deepEqual(plainTo(RECEIVER), [], 'the body is not sent to the DM');
assert.deepEqual(publicInGroup(), [], 'nothing public');
const refusedAck = plainTo(OWNER);
assert.equal(refusedAck.length, 1);
assert.ok(matches(refusedAck[0], 'TRANSMISSION FAILED'));
assert.ok(!textOf(refusedAck[0]).includes(BODY));

// ---- 7. a deletion failure never blocks the transmission --------------------
reset();
refuseDelete = true;
await handleMtCommand(message());
refuseDelete = false;
assert.equal(deleted.length, 0, 'the delete call failed');
assert.equal(ephemeralTo(RECEIVER).length, 1, 'the body is still delivered privately');
assert.ok(matches(ephemeralTo(OWNER)[0], 'MIND TRANSMISSION SENT'));

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

// ---- 9. a player without the jutsu ------------------------------------------
reset();
await handleMtCommand(message({ from: NO_JUTSU }));
assert.ok(matches(ephemeralTo(NO_JUTSU)[0], 'JUTSU NOT UNLOCKED'));
assert.equal(ephemeralTo(RECEIVER).length, 0);

// ---- 10. DM chat: GROUP ONLY ------------------------------------------------
reset();
await handleMtCommand({ ...message(), chat: { id: OWNER, type: 'private' }, reply_to_message: undefined });
assert.equal(plainTo(OWNER).length, 1);
assert.ok(matches(plainTo(OWNER)[0], 'GROUP ONLY'));

// ---- 11. HTML-special characters in the payload stay escaped ----------------
reset();
await handleMtCommand(message({ text: '/mt <b>&x</b> "quoted"' }));
const escaped = textOf(ephemeralTo(RECEIVER)[0]).split('───────────────').at(-1);
assert.ok(escaped.includes('&lt;'), 'the payload is HTML-escaped');
assert.ok(escaped.includes('&amp;'), 'ampersands are escaped');
assert.ok(!escaped.includes('<'), 'no raw angle bracket reaches parse_mode HTML');

// ---- 12. other commands are not swallowed ----------------------------------
reset();
assert.equal(await handleMtCommand({ ...message(), text: '/rob' }), false, '/rob is not /mt');
assert.equal(await handleMtCommand({ ...message(), text: '/protect' }), false, '/protect is not /mt');
assert.equal(sent.length, 0);

console.log('mt delivery: OK');
