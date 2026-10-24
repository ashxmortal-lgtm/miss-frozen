import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const read = (path) => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');

const clip = (source, start, end) => source.slice(source.indexOf(start), source.indexOf(end));

test('gate offers the BBQ recovery shortcut while a shinobi is exhausted', () => {
  const ui = read('tgcloud/lib/map/ui.js');
  const handler = read('tgcloud/lib/map/handler.js');

  assert.match(ui, /export function gateKeyboard\(userId, \{ exhausted = 0 \} = \{\}\)/);
  assert.match(ui, /if \(exhausted > 0\) rows\.push\(\[btn\('🍖 Visit BBQ and recover', guard\('map_bbq_heal', userId\)\)\]\)/);

  // Every Gate screen passes the live exhausted count (never a stale default).
  assert.match(handler, /async function gateKb\(telegramId\)/);
  assert.match(handler, /exhausted = \(await listExhausted\(telegramId\)\)\.length/);
  assert.match(handler, /return gateKeyboard\(telegramId, \{ exhausted \}\)/);
  assert.match(handler, /const roster = await gateBody\(user\.id\);\s*await showScreen\(chatId, messageId, user, roster, await gateKb\(user\.id\), 'gate'\)/);
  assert.match(handler, /body = await gateBody\(user\.id\);\s*kb = await gateKb\(user\.id\);/);
  assert.doesNotMatch(handler, /gateKeyboard\(user\.id\)/, 'Gate screens must not use the default keyboard');
});

test('BBQ recovery turns into patrol dispatch from the same screen', () => {
  const handler = read('tgcloud/lib/map/handler.js');
  const pay = clip(handler, "if (action === 'map_bbq_hpay')", "if (action === 'map_open_ability')");

  // Paying for the recovery preselects the healed units and opens the picker.
  assert.match(pay, /const healed = new Set\(result\.healed\);/);
  assert.match(pay, /selectAllGate\(user\.id, available\.filter\(\(n\) => healed\.has\(n\)\)\)/);
  assert.match(pay, /await bbqPatrolPick\(chatId, messageId, user, result\)/);

  const picker = clip(handler, 'async function bbqPatrolPick', '/** Gate controls');
  assert.match(picker, /getEligibleStatus\(user\.id, 'patrol'\)/);
  assert.match(picker, /listGateSelection\(user\.id\)/);
  assert.match(picker, /patrolPickKeyboard\(user\.id, available, selected, \{/);
  assert.match(picker, /togglePrefix: 'map_btog'/);
  assert.match(picker, /selectAllAction: 'map_ball'/);
  assert.match(picker, /text: '🍖 Back to BBQ', callback_data: guard\('map_loc_bbq', user\.id\)/);
  assert.match(picker, /bbqKeyboard\(user\.id\)/, 'the no-patrol fallback stays on the BBQ');

  // Both picker callbacks keep re-rendering the BBQ screen instead of the Gate.
  assert.match(handler, /if \(action === 'map_btog' && parts\.length >= 3\)/);
  assert.match(handler, /if \(action === 'map_ball'\)/);
  const btog = clip(handler, "if (action === 'map_btog'", "if (action === 'map_ball'");
  assert.match(btog, /toggleGateSelection\(user\.id, parts\[1\]\)/);
  assert.match(btog, /await bbqPatrolPick\(chatId, messageId, user\)/);

  // Sending still runs the real patrol dispatch and lands back on the Gate.
  assert.match(handler, /if \(action === 'map_psend'\)[\s\S]*?runActivity\(user, 'patrol', shinobi, chatId\)/);
});

test('the return card claims through one button instead of a text hint', () => {
  const economy = read('tgcloud/lib/economy_handler.js');
  const activities = read('tgcloud/lib/activities.js');

  // Group card button: "claim 🍥 reward" → Hokage Office.
  assert.match(economy, /text: r\.kind === 'pet' \? '🐾 Open Pets' : 'claim 🍥 reward'/);
  assert.match(economy, /callback_data: r\.kind === 'pet' \? `pet_me:\$\{r\.id\}` : `map_loc_hokage:\$\{r\.id\}`/);
  // The same button comes with a settled /patrol or /mission reply.
  assert.match(economy, /r\.settled\s*\n?\s*\? \{ inline_keyboard: \[\[\{ text: 'claim 🍥 reward', callback_data: `map_loc_hokage:\$\{user\.id\}`, style: 'success' \}\]\] \}/);
  assert.match(activities, /settled: own\.blocks\.length/);

  // Old manual claim line is gone; reward rows and pending are separate quotes.
  assert.doesNotMatch(activities, /ᴄʟᴀɪᴍ ᴀᴛ ᴛʜᴇ ʜᴏᴋᴀɢᴇ/);
  assert.doesNotMatch(activities, /\/map → 🏯/);
  assert.match(activities, /s \+= `\$\{quote\(rows\.join\('\\n'\)\)\}\\n`;/);
  assert.match(activities, /quote\(`🍥 𝐏𝐞𝐧𝐝𝐢𝐧𝐠 𝐭𝐨𝐭𝐚𝐥: \$\{fmt\(r\.pendingTotal\)\} ᴋᴏɴᴏʜᴀ ᴄᴏɪɴs`\)/);
});

test('gate → BBQ recovery → patrol dispatch runs end to end', () => {
  const output = execFileSync(
    process.execPath,
    ['--experimental-loader', './test/helpers/sdk-loader.mjs', 'test/helpers/run_gate_bbq_flow.mjs'],
    { cwd: new URL('..', import.meta.url), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  assert.match(output, /gate bbq flow: OK/);
});
