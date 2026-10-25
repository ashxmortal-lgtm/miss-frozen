import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// Round 11 — item ability buttons + the daily claim reminder.
//
// · `/buy` / `/equip` replies for a shinobi or pet carry ONE `Check ❄️ ability`
//   URL button that opens that exact item's guide post.
// · Members of a group who have not claimed today are mentioned once per IST
//   day with the claim message and the same button the group `/claim` uses.
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

const run = (file) => execFileSync(
  process.execPath,
  ['--experimental-loader', './test/helpers/sdk-loader.mjs', file],
  { cwd: new URL('..', import.meta.url), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
);

test('buy and equip replies attach the item ability button', () => {
  const ability = read('tgcloud/lib/ability.js');
  // One post per shinobi; pets read their own `abilityUrl`.
  for (const [name, id] of [
    ['Naruto', 9], ['Sasuke', 10], ['Sakura', 11], ['Itachi', 12],
    ['Tsunade', 13], ['Jiraiya', 14], ['Hinata', 15],
  ]) {
    assert.match(ability, new RegExp(`${name}: 'https://t\\.me/frozenblooded/${id}'`), name);
  }
  assert.match(ability, /ABILITY_BUTTON_TEXT = 'Check ❄️ ability'/);
  assert.match(ability, /const petId = PET_BY_NAME\[key\];\n  if \(petId\) return petAbilityUrl\(petId\);/);

  const buy = read('tgcloud/lib/buy.js');
  assert.match(buy, /ability: pet\.name/, 'pet purchases report the item');
  assert.match(buy, /ability: req\.name/, 'shinobi purchases report the item');

  const handler = read('tgcloud/lib/economy_handler.js');
  assert.match(handler, /const abilityKb = typeof out === 'object' \? abilityCheckKeyboard\(out\.ability\) : undefined;/);
  assert.match(handler, /reply_markup: abilityKb/, 'the /buy reply carries the button');
  // /equip: pet + shinobi (success and already-equipped).
  assert.match(handler, /equipSuccessText\(petDef\.name\), abilityExtra\(petDef\.name\)/);
  assert.match(handler, /is already equipped\..*abilityExtra\(args\)/);
  assert.match(handler, /Check \/inventory`, abilityExtra\(shown\)\)/);
});

test('buy/pet/shinobi ability links resolve end to end', () => {
  const output = run('test/helpers/run_buy_ability.mjs');
  assert.match(output, /buy ability button: OK/);
});

test('the daily claim reminder is one group message per IST day', () => {
  const source = read('tgcloud/lib/claim_reminder.js');
  assert.match(source, /CLAIM_REMINDER_START_HOUR_IST = 10/);
  assert.match(source, /claim_reminder_chat:\$\{chat\.id\}:\$\{day\}/, 'one message per group per day');
  assert.match(source, /❄️ \$\{who\}\\n\\n🎁 ᴄʟᴀɪᴍ ʏᴏᴜʀ ᴅᴀɪʟʏ ʀᴇᴡᴀʀᴅ ɴᴏᴡ! 👀/);
  // The button is shared with /claim so the two can never drift.
  const handler = read('tgcloud/lib/economy_handler.js');
  assert.match(handler, /import \{ sweepClaimReminders, CLAIM_GROUP_BUTTON \} from '\.\/claim_reminder\.js';/);
  assert.match(handler, /reply_markup: \{ inline_keyboard: \[\[\{ \.\.\.CLAIM_GROUP_BUTTON \}\]\] \}/);
  // Wired into the per-message sweep that runs for every incoming message.
  assert.match(handler, /try \{ await announceDone\(message\.chat, claimingNow\); \}/);
  assert.match(handler, /sweepClaimReminders\(chat, undefined, \{ skip: skipClaimIds \}\)/);
});

test('claim reminder sweep against real SQLite', () => {
  const output = run('test/helpers/run_claim_reminder.mjs');
  assert.match(output, /claim reminder: OK/);
});
