/**
 * `/redeem` success card: exact requested layout, one reward per `✦` line.
 * Runs the real coupons module through the SDK shim.
 */
import assert from 'node:assert/strict';
import { redeemRewardLines, redeemRedeemedText } from '../../tgcloud/lib/coupons.js';

// ---- exact requested layout -------------------------------------------------
assert.equal(
  redeemRedeemedText({ coins: 1000, chakra: 250, shinobis: ['Sasuke'], gifts: [{ name: 'Gift Box', qty: 1 }] }),
  '🎉 𝐂𝐎𝐔𝐏𝐎𝐍 𝐑𝐄𝐃𝐄𝐄𝐌𝐄𝐃!\n\n\n'
  + '🎁 𝐑𝐄𝐖𝐀𝐑𝐃𝐒\n\n'
  + '✦ 1,000 🍥\n✦ 250 ⚡\n✦ Sasuke\n✦ Gift Box\n\n\n'
  + '❄️ ᴄʜᴇᴄᴋ ʏᴏᴜʀ ʀᴇᴡᴀʀᴅꜱ\n\n'
  + '"/balance" · "/inventory"',
);

// ---- reward lines -----------------------------------------------------------
assert.deepEqual(redeemRewardLines({ coins: 2500, chakra: 100 }), ['2,500 🍥', '100 ⚡']);
assert.deepEqual(redeemRewardLines({ shinobis: ['Sasuke', 'Sakura'] }), ['Sasuke', 'Sakura']);
assert.deepEqual(redeemRewardLines({ gifts: [{ name: 'Pet Nametag', qty: 3 }] }), ['Pet Nametag × 3']);
assert.deepEqual(redeemRewardLines({ gift: 'Pet Food' }), ['Pet Food'], 'legacy single gift');
assert.deepEqual(redeemRewardLines({}), [], 'nothing granted');

// ---- more than four rewards collapse into the ellipsis ----------------------
const many = redeemRewardLines({
  coins: 5000, chakra: 500, shinobis: ['Sasuke', 'Sakura', 'Naruto'], gifts: [{ name: 'Pet Nametag', qty: 2 }],
});
assert.equal(many.length, 6);
const manyText = redeemRedeemedText({
  coins: 5000, chakra: 500, shinobis: ['Sasuke', 'Sakura', 'Naruto'], gifts: [{ name: 'Pet Nametag', qty: 2 }],
});
assert.ok(manyText.includes('✦ 5,000 🍥'));
assert.ok(manyText.includes('✦ …'), 'overflow marker');
assert.ok(!manyText.includes('✦ Pet Nametag'), 'only the first four are listed');
assert.equal(manyText.split('\n').filter((l) => l.startsWith('✦')).length, 5, '4 lines + ellipsis');

// ---- empty reward set still renders the card -------------------------------
const empty = redeemRedeemedText({});
assert.ok(empty.startsWith('🎉 𝐂𝐎𝐔𝐏𝐎𝐍 𝐑𝐄𝐃𝐄𝐄𝐌𝐄𝐃!'));
assert.ok(empty.includes('🎁 𝐑𝐄𝐖𝐀𝐑𝐃𝐒'));
assert.ok(empty.includes('"/balance" · "/inventory"'));
assert.ok(!empty.includes('undefined'));

// ---- the handler now uses this card (no legacy sentence) -------------------
const source = await import('node:fs').then(({ default: fs }) => fs.readFileSync(
  new URL('../../tgcloud/lib/coupons.js', import.meta.url), 'utf8',
));
assert.match(source, /text: redeemRedeemedText\(reward\)/);
assert.doesNotMatch(source, /Use \/balance or \/inventory to check your rewards/);

console.log('redeem message: OK');
