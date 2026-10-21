import { AccessError, ACCESS_ERROR_CODES, MiniAppUrlError } from '../errors.js';
import {
  ANNIVERSARY_INTRO,
  HELP_MEMBER,
  HELP_OWNER,
  MESSAGES,
  OWNER_START,
  TEXTS,
  UNAUTHORIZED_TEMPLATE,
  WELCOME_MESSAGE,
} from '../content.js';
import { BUTTON_LABELS, ROLES } from '../config.js';
import { welcomeKeyboard } from '../keyboards.js';
import { fillMention, mentionHtml } from '../mentions.js';
import { saveMiniAppBaseUrl } from '../mini_app_url.js';
import { formatGrantDate, parseCommand } from './commands.js';
import { baseMessage, sendMessage } from './send.js';

/**
 * Private-message router. `from.id` is the Telegram-verified sender — never a
 * username and never an ID written in the message body.
 *
 * @param {object} message Telegram Message (update.message)
 * @param {{update?: object}} ctx platform handler context
 * @param {{api: object, access: object, support: object, store: object, now?: Function}} deps
 */
export async function routeMessage(message, ctx, deps) {
  const { api, access } = deps;

  // This is a private personal space. In groups the bot stays completely silent.
  if (!message || message.chat?.type !== 'private') {
    return { handled: false, reason: 'not-private' };
  }

  const from = message.from;
  if (!from || from.is_bot === true) {
    return { handled: false, reason: 'no-human-sender' };
  }

  const command = parseCommand(message.text);
  const chatId = message.chat.id;

  let auth;
  try {
    auth = await access.authorize(from.id);
  } catch (error) {
    if (error instanceof AccessError && error.code === ACCESS_ERROR_CODES.INVALID_ID) {
      return { handled: false, reason: 'invalid-sender' };
    }
    if (command) {
      await sendMessage(api, baseMessage(chatId, TEXTS.storageUnavailable));
    }
    return { handled: true, reason: 'storage-error', allowed: false };
  }

  if (!auth.allowed) {
    // Deny every command, including /start. Plain chatter is ignored so a
    // stranger cannot use the bot as an echo chamber.
    if (command) {
      const mention = mentionHtml(from);
      await sendMessage(
        api,
        baseMessage(chatId, fillMention(UNAUTHORIZED_TEMPLATE, mention), {
          parse_mode: 'HTML',
        }),
      );
    }
    return { handled: true, reason: 'unauthorized', allowed: false };
  }

  if (!command) {
    return { handled: true, reason: 'no-command', allowed: true };
  }

  switch (command.name) {
    case 'start': {
      if (auth.isOwner) {
        await sendMessage(
          api,
          baseMessage(chatId, OWNER_START, { reply_markup: welcomeKeyboard() }),
        );
      } else {
        // Exactly one primary inline button, as specified.
        await sendMessage(
          api,
          baseMessage(chatId, WELCOME_MESSAGE, { reply_markup: welcomeKeyboard() }),
        );
      }
      return { handled: true, allowed: true, action: 'start', role: auth.role };
    }

    case 'help': {
      const text = auth.isOwner ? HELP_OWNER : HELP_MEMBER;
      await sendMessage(api, baseMessage(chatId, text));
      return { handled: true, allowed: true, action: 'help', role: auth.role };
    }

    case 'grant': {
      if (command.args.length !== 1) {
        await sendMessage(api, baseMessage(chatId, TEXTS.grantUsage));
        return { handled: true, allowed: true, action: 'grant-usage' };
      }
      try {
        const result = await access.grant(command.args[0], from.id);
        const text = result.alreadyOwner
          ? MESSAGES.grantOwner(result.targetId)
          : result.changed
            ? MESSAGES.grantMade(result.targetId)
            : MESSAGES.grantAlready(result.targetId);
        await sendMessage(api, baseMessage(chatId, text));
        return { handled: true, allowed: true, action: 'grant', changed: result.changed };
      } catch (error) {
        await sendAccessError(api, chatId, error);
        return { handled: true, allowed: true, action: 'grant-error' };
      }
    }

    case 'revoke': {
      if (command.args.length !== 1) {
        await sendMessage(api, baseMessage(chatId, TEXTS.revokeUsage));
        return { handled: true, allowed: true, action: 'revoke-usage' };
      }
      try {
        const result = await access.revoke(command.args[0], from.id);
        const text = result.revoked
          ? MESSAGES.revokeMade(result.targetId)
          : MESSAGES.revokeAlready(result.targetId);
        await sendMessage(api, baseMessage(chatId, text));
        return { handled: true, allowed: true, action: 'revoke', changed: result.revoked };
      } catch (error) {
        await sendAccessError(api, chatId, error);
        return { handled: true, allowed: true, action: 'revoke-error' };
      }
    }

    case 'access': {
      try {
        const rows = await access.list(from.id);
        const lines = rows.map((row) => {
          if (row.role === ROLES.OWNER) {
            return `👑 ${row.telegramId} — owner — since ${formatGrantDate(row.grantedAt)}`;
          }
          return `🎀 ${row.telegramId} — member — granted by ${row.grantedBy} on ${formatGrantDate(
            row.grantedAt,
          )}`;
        });
        const text = lines.length
          ? `👑 Authorized little people:\n\n${lines.join('\n')}`
          : TEXTS.accessEmpty;
        await sendMessage(api, baseMessage(chatId, text));
        return { handled: true, allowed: true, action: 'access', count: rows.length };
      } catch (error) {
        await sendAccessError(api, chatId, error);
        return { handled: true, allowed: true, action: 'access-error' };
      }
    }

    case 'setapp': {
      if (command.args.length !== 1) {
        await sendMessage(api, baseMessage(chatId, TEXTS.setAppUsage));
        return { handled: true, allowed: true, action: 'setapp-usage' };
      }
      try {
        await access.requireOwner(from.id);
        const url = await saveMiniAppBaseUrl(deps.store, command.args[0], from.id, deps.now?.());
        await sendMessage(api, baseMessage(chatId, MESSAGES.setAppSaved(url)));
        return { handled: true, allowed: true, action: 'setapp', url };
      } catch (error) {
        if (error instanceof MiniAppUrlError) {
          await sendMessage(api, baseMessage(chatId, error.message));
        } else {
          await sendAccessError(api, chatId, error);
        }
        return { handled: true, allowed: true, action: 'setapp-error' };
      }
    }

    default: {
      await sendMessage(api, baseMessage(chatId, TEXTS.unknownCommand));
      return { handled: true, allowed: true, action: 'unknown-command' };
    }
  }
}

async function sendAccessError(api, chatId, error) {
  let text = TEXTS.storageUnavailable;
  if (error instanceof AccessError) {
    switch (error.code) {
      case ACCESS_ERROR_CODES.NOT_OWNER:
        text = TEXTS.notOwner;
        break;
      case ACCESS_ERROR_CODES.OWNER_PROTECTED:
        text = TEXTS.ownerProtected;
        break;
      case ACCESS_ERROR_CODES.INVALID_ID:
        text = TEXTS.invalidId;
        break;
      case ACCESS_ERROR_CODES.MALFORMED_ACCESS:
      case ACCESS_ERROR_CODES.STORAGE_UNAVAILABLE:
        text = error.message;
        break;
      default:
        text = TEXTS.storageUnavailable;
    }
  }
  await sendMessage(api, baseMessage(chatId, text));
}

/** Exported for tests that need the exact primary button label. */
export const PRIMARY_BUTTON_LABEL = BUTTON_LABELS.menu;
