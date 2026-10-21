/**
 * Classic /help fallback text. Prefer welcome_ui.buildUserHelpBlocks (rich)
 * which reads from command_registry. This module stays in sync with the registry.
 */
import { OWNER_ID } from './config.js';
import { listCommands } from './command_registry.js';
import { escapeHtml } from './texts.js';

function commandList(commands) {
  return commands.map(({ cmd, desc }) => {
    const description = escapeHtml(desc).replace(/\/[A-Za-z][A-Za-z0-9_]*/g, (token) => `<code>${token}</code>`);
    return `<code>${escapeHtml(cmd)}</code> — ${description}`;
  }).join('\n');
}

export function helpText(user) {
  const userList = commandList(listCommands('user'));
  let text = `📖 𝐇𝐄𝐋𝐏\n\n<blockquote>${userList}</blockquote>`;
  if (user && user.id === OWNER_ID) {
    const ownerCommands = listCommands('owner').filter((command) => command.access === 'owner');
    text += `\n\n👑 𝐎𝐖𝐍𝐄𝐑\n\n<blockquote>${commandList(ownerCommands)}</blockquote>`;
  }
  return text;
}
