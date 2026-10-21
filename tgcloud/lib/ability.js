import { style, mention } from './texts.js';

export const ROWS = [
  ['⚔️ Sasuke', 'adventurer · /mission → 🍥 300'],
  ['🌸 Sakura', 'booster · /claim and patrol/mission bonus grow with level · patrol only (no missions) · healing at Lv. 4'],
  ['🍥 Naruto', 'shadow clones · ×3 on /mission, /patrol only · may find Jiraiya (within 15 patrols) · clone window grows with level'],
  ['🐸 Jiraiya', 'protection · /protect → 24h immunity · found via Naruto /patrol (within 15) · trains Naruto'],
  ['👁️ Itachi', 'kill & rob · /kill → 🍥 50–300 · /rob needs a dead target · 5 levels by successful kills · cannot patrol/mission'],
  ['👁️ Hinata', 'byakugan · /byakugan → reveals protection time · once per 24h, private'],
  ['🧠 Mind Transmission', '/mt → hidden message · jutsu owners only'],
  ['🍃 Rank', 'academy → genin → chūnin → jōnin → anbu → kage'],
  ['👤 Profile', '/profile → rank, XP, roster & stats'],
];

const ABILITY_URL = 'https://t.me/frozenblooded/27';

export function abilityHtml(user) {
  const who = user ? `<p>${mention(user)}</p>` : '';
  return style(
    `${who}<p>Clicked on button below to check abilities of all shinobis.</p>` +
    `<tg-button-row align="center"><tg-button type="url" url="${ABILITY_URL}" style="success">Check ❄️ abilities</tg-button></tg-button-row>`,
  );
}

export function abilityText() {
  return 'Clicked on button below to check abilities of all shinobis.';
}

export const abilityKeyboard = () => ({
  inline_keyboard: [[{
    text: 'Check ❄️ abilities',
    url: ABILITY_URL,
    style: 'success',
  }]],
});
export const backKeyboard = (id) => ({
  inline_keyboard: [[{ text: style('← Back'), callback_data: `lv:ab:${id}` }]],
});
