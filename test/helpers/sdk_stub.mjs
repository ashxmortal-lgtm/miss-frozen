export { db, sql, database } from './sdk_db_stub.mjs';

export class BotApiError extends Error {}
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
