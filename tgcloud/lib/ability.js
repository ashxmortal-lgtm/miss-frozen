import { style, mention } from './texts.js';
import { PET_BY_NAME, petAbilityUrl } from './pet/defs.js';

export const ROWS = [
  ['⚔️ Sasuke', 'adventurer · /mission → 🍥 300'],
  ['🌸 Sakura', 'booster · /claim and patrol/mission bonus grow with level · patrol only (no missions) · healing at Lv. 4'],
  ['🍥 Naruto', 'shadow clones · ×3 on /mission, /patrol only · may find Jiraiya (within 15 patrols) · clone window grows with level'],
  ['🐸 Jiraiya', 'protection · /protect → 24h immunity · found via Naruto /patrol (within 15) · trains Naruto'],
  ['👁️ Itachi', 'kill & rob · /kill rewards by level: 100–120 / 120–180 / 150–200 / 200–250 / 250–300 🍥 · /rob needs a dead account (24h) · 5 levels by successful kills · cannot patrol/mission'],
  ['👁️ Hinata', 'byakugan · /byakugan → reveals protection time · once per 24h, private'],
  ['🧠 Mind Transmission', '/mt → hidden message · jutsu owners only'],
  ['🍃 Rank', 'academy → genin → chūnin → jōnin → anbu → kage'],
  ['👤 Profile', '/profile → rank, XP, roster & stats'],
];

export const ABILITY_URL = 'https://t.me/frozenblooded/8';

// One ability post per shinobi in the frozenblooded channel. `/buy` and
// `/equip` replies attach a button to the matching post.
export const SHINOBI_ABILITY_URLS = {
  Naruto: 'https://t.me/frozenblooded/9',
  Sasuke: 'https://t.me/frozenblooded/10',
  Sakura: 'https://t.me/frozenblooded/11',
  Itachi: 'https://t.me/frozenblooded/12',
  Tsunade: 'https://t.me/frozenblooded/13',
  Jiraiya: 'https://t.me/frozenblooded/14',
  Hinata: 'https://t.me/frozenblooded/15',
};

export const ABILITY_BUTTON_TEXT = 'Check ❄️ ability';

const norm = (name) => String(name || '').trim().toLowerCase().replace(/\s+/g, ' ');

/** Ability post for a shinobi or a pet name; null for jutsu/chakra/unknown. */
export function itemAbilityUrl(name) {
  const key = norm(name);
  if (!key) return null;
  const petId = PET_BY_NAME[key];
  if (petId) return petAbilityUrl(petId);
  const shinobi = Object.keys(SHINOBI_ABILITY_URLS).find((n) => norm(n) === key);
  return shinobi ? SHINOBI_ABILITY_URLS[shinobi] : null;
}

/**
 * `Check ❄️ ability` inline button for a bought/equipped item. Undefined when
 * the item has no guide post, so callers can spread it unconditionally.
 */
export function abilityCheckKeyboard(name) {
  const url = itemAbilityUrl(name);
  if (!url) return undefined;
  return { inline_keyboard: [[{ text: ABILITY_BUTTON_TEXT, url, style: 'success' }]] };
}

export function abilityHtml(user) {
  const who = '';
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
