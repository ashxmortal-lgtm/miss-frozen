import { createAccessService } from '../../tgcloud/lib/access.js';

export const OWNER_ID = 8716863150;
export const GIRLFRIEND_ID = 555000111;
export const STRANGER_ID = 999888777;
export const NOW = 1760000000; // fixed unix seconds

export function makeAccess(store, overrides = {}) {
  const { now = NOW, ...rest } = overrides;
  return createAccessService(store, {
    ownerTelegramId: OWNER_ID,
    now: () => now,
    ...rest,
  });
}

export function makeUser(id, extra = {}) {
  return {
    id,
    is_bot: false,
    first_name: 'Sheesh',
    username: 'sheesh',
    ...extra,
  };
}

export function makePrivateMessage(from, text, overrides = {}) {
  return {
    message_id: 10,
    date: NOW,
    chat: { id: from.id, type: 'private' },
    from,
    text,
    ...overrides,
  };
}

export function makeCallback(from, data, overrides = {}) {
  return {
    id: 'cb-1',
    from,
    data,
    chat_instance: 'ci',
    message: {
      message_id: 77,
      date: NOW,
      chat: { id: from.id, type: 'private' },
      from: { id: 123, is_bot: true, first_name: 'bot' },
      text: 'menu',
    },
    ...overrides,
  };
}

export function makeApi() {
  const calls = [];
  return {
    calls,
    async sendMessage(params) {
      calls.push({ method: 'sendMessage', params });
      return { message_id: 1000 + calls.length, chat: { id: params.chat_id }, date: NOW };
    },
    async answerCallbackQuery(params) {
      calls.push({ method: 'answerCallbackQuery', params });
      return true;
    },
    messages() {
      return calls.filter((call) => call.method === 'sendMessage').map((call) => call.params);
    },
    answers() {
      return calls
        .filter((call) => call.method === 'answerCallbackQuery')
        .map((call) => call.params);
    },
  };
}

export function freshInitData(userId, options = {}) {
  const authDate = options.authDate ?? NOW;
  return {
    auth_date: authDate,
    query_id: 'AAH-test',
    user: makeUser(userId),
    ...options.extra,
  };
}
