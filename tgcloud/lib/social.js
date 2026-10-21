import { api } from './message_api.js';

/** Private channel hosting the GIFs (from t.me/c/3889508991/MSG_ID) */
const GIF_CHAT_ID = -1003889508991;

const GIF_MSG_IDS = {
  hug:   [436, 429, 428, 427, 426, 425, 430],
  slap:  [404, 403, 402, 400, 399, 434],
  punch: [438, 435, 411, 410, 409, 408, 407, 413, 412],
  pat:   [433, 432, 423, 422, 421, 420],
};

const DIALOGUES = {
  hug: [
    '{1} hugged {2}',
    '{1} gave {2} a warm hug 🫂',
    '{1} pulled {2} into a hug',
    '{1} gave {2} a big hug 🫂',
  ],
  slap: [
    '{1} slapped {2}',
    '{1} gave {2} a solid slap!',
    '{1} slapped {2} right across the face 😭',
    "{1} couldn't resist slapping {2}",
  ],
  punch: [
    '{1} punched {2}',
    '{1} threw a punch at {2}!',
    '{1} landed a punch on {2} 😭',
    '{1} decided to punch {2}',
  ],
  pat: [
    '{1} patted {2}',
    '{1} gently patted {2} on the head',
    '{1} gave {2} a little head pat 🥹',
    '{1} patted {2} like a good shinobi',
  ],
};

const REPLY_HINT = "𝑹𝒆𝒑𝒍𝒚 𝒕𝒐 𝒔𝒐𝒎𝒆𝒐𝒏𝒆'𝒔 𝒎𝒆𝒔𝒔𝒂𝒈𝒆 𝒕𝒐 𝒖𝒔𝒆 𝒕𝒉𝒊𝒔 𝒄𝒐𝒎𝒎𝒂𝒏𝒅.";

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const mentionHtml = (u) => {
  if (!u?.id) return 'User';
  return `<a href="tg://user?id=${u.id}">${esc(u.first_name || 'User')}</a>`;
};
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

export async function handleSocialCommand(message) {
  const text = message.text || '';
  if (!text.startsWith('/')) return false;
  const head = text.split(/\s+/)[0];
  const [rawCmd, atBot] = head.slice(1).split('@');
  const cmd = rawCmd.toLowerCase();
  if (!DIALOGUES[cmd]) return false;

  if (atBot) {
    try {
      const me = await api.getMe();
      if (atBot.toLowerCase() !== String(me.username || '').toLowerCase()) return true;
    } catch (_) {}
  }

  const from = message.from;
  if (!from || from.is_bot) return true;

  const chat = message.chat;
  const isGroup = chat.type === 'group' || chat.type === 'supergroup';
  if (!isGroup) {
    await api.sendMessage({ chat_id: chat.id, text: 'This command works only in groups.' });
    return true;
  }

  const rt = message.reply_to_message;
  if (!rt?.from) {
    await api.sendMessage({
      chat_id: chat.id,
      text: REPLY_HINT,
      reply_parameters: { message_id: message.message_id },
    });
    return true;
  }

  const target = rt.from;
  const captionTpl = pick(DIALOGUES[cmd]);
  const caption = captionTpl
    .replace('{1}', mentionHtml(from))
    .replace('{2}', mentionHtml(target));

  const msgId = pick(GIF_MSG_IDS[cmd]);

  try {
    await api.copyMessage({
      chat_id: chat.id,
      from_chat_id: GIF_CHAT_ID,
      message_id: msgId,
      caption,
      parse_mode: 'HTML',
      reply_parameters: { message_id: message.message_id },
    });
  } catch (e) {
    console.error(`social ${cmd} gif failed:`, e?.description || e);
    try {
      await api.sendMessage({
        chat_id: chat.id,
        text: caption,
        parse_mode: 'HTML',
        reply_parameters: { message_id: message.message_id },
      });
    } catch (_) {}
  }
  return true;
}
