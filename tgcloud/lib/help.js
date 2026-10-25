/**
 * Classic /help fallback text. Prefer welcome_ui.buildUserHelpBlocks (rich)
 * which reads from command_registry. This module stays in sync with the registry
 * and keeps the same order: profile block → PvP block → utility commands.
 */
import { OWNER_ID } from './config.js';
import { listCommands } from './command_registry.js';
import { escapeHtml } from './texts.js';

const BLOCK_ONE = [
  '/claim', '/balance', '/profile', '/inventory', '/shinobi_store', '/gift_store',
  '/buy', '/mission', '/patrol', '/map', '/ability',
];
const BLOCK_TWO = [
  '/kill', '/rob', '/protect', '/transfer', '/leaderboard', '/equip', '/unequip', '/redeem',
  '/q', '/own',
];
const BLOCK_THREE = ['/start', '/help', '/owner'];

const descOf = (cmd) => {
  const entry = listCommands('user').find((c) => c.cmd === cmd);
  return entry ? entry.desc : '';
};

const commandList = (cmds) => cmds
  .map((cmd) => {
    const desc = descOf(cmd);
    return desc ? `${escapeHtml(cmd)} — ${escapeHtml(desc)}` : escapeHtml(cmd);
  })
  .join('\n');

export function helpText(user) {
  const blocks = [
    `🎮 <b>GAME COMMANDS</b>`,
    `<blockquote>${commandList(BLOCK_ONE)}</blockquote>`,
    `<blockquote>${commandList(BLOCK_TWO)}</blockquote>`,
    commandList(BLOCK_THREE),
  ];
  let text = blocks.join('\n\n');
  if (user && user.id === OWNER_ID) {
    const ownerCommands = listCommands('owner').filter((command) => command.access === 'owner');
    text += `\n\n👑 <b>OWNER</b>\n\n<blockquote>${commandList(ownerCommands.map((c) => c.cmd))}</blockquote>`;
  }
  return text;
}

/** Same navigation rows as the rich /help screen (classic fallback). */
export function helpKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: 'PETS', callback_data: 'hp:pets' },
        { text: 'JUTSU', callback_data: 'hp:jutsu' },
        { text: 'FUN', callback_data: 'hp:fun' },
      ],
      [
        { text: 'MORE ❄️ GAMES', callback_data: 'hp:more' },
        { text: 'BACK', callback_data: 'hp:main' },
      ],
    ],
  };
}
