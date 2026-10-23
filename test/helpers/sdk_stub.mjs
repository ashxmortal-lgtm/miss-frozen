export { db, sql, database } from './sdk_db_stub.mjs';

export class BotApiError extends Error {}
export class EndpointError extends Error {}

export const api = {
  async answerCallbackQuery() {},
  async sendMessage() {},
  async editMessageText() {},
  async deleteMessage() {},
  async copyMessage() { return { message_id: 1 }; },
};

// Minimal stand-ins for the platform file helpers (backup module imports them).
export class InputFile {
  constructor(value, filename) { this.value = value; this.filename = filename; }
}
export const FormData = globalThis.FormData;
