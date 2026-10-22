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
