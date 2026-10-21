import { findItem, fmt, CHAKRA_RATE, CHAKRA_MIN } from './store.js';
import { purchase } from './purchase.js';


// Returns the message body (no mention; reply() adds it) or null to stay silent.
export async function handleBuy(user, text, updateId) {
  const args = text.trim().split(/\s+/).slice(1);
  if (args.length === 0) {
    return `❌ 𝐌𝐈𝐒𝐒𝐈𝐍𝐆 𝐈𝐓𝐄𝐌\n\nᴜsᴇ: /buy [item name]\n\nᴇxᴀᴍᴘʟᴇ: /buy Sasuke`;
  }

  let req;
  if (args[0].toLowerCase() === 'chakra') {
    const raw = args[1];
    if (args.length !== 2 || !/^\d{1,12}$/.test(raw) || Number(raw) === 0) {
      return `❌ 𝐈𝐍𝐕𝐀𝐋𝐈𝐃 𝐈𝐍𝐏𝐔𝐓\n\nᴇɴᴛᴇʀ ᴀ ᴡʜᴏʟᴇ ɴᴜᴍʙᴇʀ.\n\nᴇxᴀᴍᴘʟᴇ: /buy chakra 150`;
    }
    const amount = Number(raw);
    if (amount < CHAKRA_MIN) {
      return `❌ 𝐈𝐍𝐕𝐀𝐋𝐈𝐃 𝐂𝐇𝐀𝐊𝐑𝐀 𝐀𝐌𝐎𝐔𝐍𝐓\n\nᴍɪɴɪᴍᴜᴍ ᴘᴜʀᴄʜᴀsᴇ: chakra x 𝟏𝟎𝟎 ⚡\n\nᴜsᴇ: /buy chakra 100`;
    }
    req = { type: 'chakra', name: 'Chakra', qty: amount, cost: amount * CHAKRA_RATE };
  } else {
    const item = findItem(args.join(' '));
    if (!item) {
      return `❌ 𝐈𝐓𝐄𝐌 𝐍𝐎𝐓 𝐅𝐎𝐔𝐍𝐃\n\nᴛʜɪs ɪᴛᴇᴍ ɪsɴ'ᴛ ᴀᴠᴀɪʟᴀʙʟᴇ ɪɴ ᴛʜᴇ sᴛᴏʀᴇ.\n\nᴜsᴇ /shinobi_store ᴛᴏ ʙʀᴏᴡsᴇ ɪᴛᴇᴍs.`;
    }
    req = { type: item.type, name: item.name, qty: 1, cost: item.price, emoji: item.emoji };
  }

  const r = await purchase(user.id, updateId, req);

  if (r.status === 'duplicate') return null;
  if (r.status === 'owned') {
    return req.type === 'jutsu'
      ? `⚠️ 𝐉𝐔𝐓𝐒𝐔 𝐀𝐋𝐑𝐄𝐀𝐃𝐘 𝐔𝐍𝐋𝐎𝐂𝐊𝐄𝐃\n\nʏᴏᴜ ᴀʟʀᴇᴀᴅʏ ᴘᴏssᴇss ᴛʜɪs ᴊᴜᴛsᴜ.\n\nᴄᴏɪɴs ʀᴇᴍᴀɪɴ ᴜɴᴛᴏᴜᴄʜᴇᴅ.`
      : `⚠️ 𝐀𝐋𝐑𝐄𝐀𝐃𝐘 𝐑𝐄𝐂𝐑𝐔𝐈𝐓𝐄𝐃\n\nʏᴏᴜ ᴀʟʀᴇᴀᴅʏ ᴏᴡɴ ᴛʜɪs sʜɪɴᴏʙɪ.\n\nᴄᴏɪɴs ʀᴇᴍᴀɪɴ ᴜɴᴛᴏᴜᴄʜᴇᴅ.`;
  }
  if (r.status === 'insufficient') {
    return `❌ 𝐈𝐍𝐒𝐔𝐅𝐅𝐈𝐂𝐈𝐄𝐍𝐓 𝐂𝐎𝐈𝐍𝐒\n\nʏᴏᴜ ɴᴇᴇᴅ ${fmt(req.cost)} 🍥\nʏᴏᴜ ʜᴀᴠᴇ ${fmt(r.balance)} 🍥\n\nɴᴇᴇᴅ ${fmt(req.cost - r.balance)} 🍥 ᴍᴏʀᴇ.`;
  }
  if (r.status === 'failed') {
    return r.safe
      ? `⚠️ 𝐓𝐑𝐀𝐍𝐒𝐀𝐂𝐓𝐈𝐎𝐍 𝐅𝐀𝐈𝐋𝐄𝐃\n\nʏᴏᴜʀ ᴘᴜʀᴄʜᴀsᴇ ᴄᴏᴜʟᴅɴ'ᴛ ʙᴇ ᴄᴏᴍᴘʟᴇᴛᴇᴅ.\n\nɴᴏ ᴄᴏɪɴs ᴡᴇʀᴇ ᴅᴇᴅᴜᴄᴛᴇᴅ.`
      : `⚠️ 𝐓𝐑𝐀𝐍𝐒𝐀𝐂𝐓𝐈𝐎𝐍 𝐅𝐀𝐈𝐋𝐄𝐃\n\nʏᴏᴜʀ ᴘᴜʀᴄʜᴀsᴇ ᴄᴏᴜʟᴅɴ'ᴛ ʙᴇ ᴄᴏᴍᴘʟᴇᴛᴇᴅ.\n\nᴡᴇ ᴀʀᴇ ᴄʜᴇᴄᴋɪɴɢ ʏᴏᴜʀ ʙᴀʟᴀɴᴄᴇ. ᴅᴏɴ'ᴛ ʀᴇᴛʀʏ ʏᴇᴛ.`;
  }

  const tail = `ᴄᴏsᴛ: ${fmt(req.cost)} 🍥\nʙᴀʟᴀɴᴄᴇ: ${fmt(r.balance)} 🍥`;
  if (req.type === 'chakra') {
    return `✅ 𝐂𝐇𝐀𝐊𝐑𝐀 𝐑𝐄𝐏𝐋𝐄𝐍𝐈𝐒𝐇𝐄𝐃\n\nᴀᴍᴏᴜɴᴛ: chakra x ${fmt(req.qty)} ⚡\n${tail}`;
  }
  if (req.type === 'jutsu') {
    return `✅ 𝐉𝐔𝐓𝐒𝐔 𝐔𝐍𝐋𝐎𝐂𝐊𝐄𝐃\n\n${req.name} ${req.emoji}\n\n${tail}`;
  }
  return `✅ 𝐏𝐔𝐑𝐂𝐇𝐀𝐒𝐄 𝐒𝐔𝐂𝐂𝐄𝐒𝐒𝐅𝐔𝐋\n\nᴜɴʟᴏᴄᴋᴇᴅ: ${req.name} ${req.emoji}\n\n${tail}`;
}
