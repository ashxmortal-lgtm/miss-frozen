export { db, sql, database } from './sdk_db_stub.mjs';

export class BotApiError extends Error {}

/**
 * Outbound HTTP stub. Tests replace `fetch` with their own implementation; by
 * default every request fails the way an unreachable host does, which is the
 * behaviour the quote renderer must survive.
 */
export let fetch = async () => { throw new TypeError('network unavailable in tests'); };

/** Test hook: install a fake transport (pass null to restore the failing one). */
export function setFetch(impl) {
  fetch = impl || (async () => { throw new TypeError('network unavailable in tests'); });
}
export class EndpointError extends Error {}

export const api = {
  async answerCallbackQuery() {},
  async sendMessage() {},
  async sendPhoto() {},
  async editMessageText() {},
  async deleteMessage() {},
  async copyMessage() { return { message_id: 1 }; },
  // Storage-channel photo resolution forwards once to learn a reusable file_id.
  async forwardMessage() { return { message_id: 1, photo: [{ file_id: 'stub-photo' }] }; },
};

// Minimal stand-ins for the platform file helpers (backup module imports them).
export class InputFile {
  constructor(value, filename) { this.value = value; this.filename = filename; }
}
export const FormData = globalThis.FormData;
