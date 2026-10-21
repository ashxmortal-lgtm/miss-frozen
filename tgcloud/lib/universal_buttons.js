export const FROZEN_BLOODED_TEXT = '𝑭𝒓❄️𝒛𝒆𝒏 𝑩𝒍𝒐𝒐𝒅𝒆𝒅';
export const FROZEN_BLOODED_URL = 'https://t.me/+ihpNjYxHXUBlYWY9';

export function frozenBloodedButton() {
  return {
    text: FROZEN_BLOODED_TEXT,
    url: FROZEN_BLOODED_URL,
    style: 'danger',
  };
}

export function frozenBloodedRow() {
  return {
    type: 'buttons',
    align: 'center',
    buttons: [frozenBloodedButton()],
  };
}

/** Match both the exact stylized label and plain-text equivalents. */
export function isFrozenBloodedLabel(value) {
  const letters = String(value ?? '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^\p{L}]+/gu, '');
  return letters === 'frozenblooded' || letters === 'frzenblooded';
}
