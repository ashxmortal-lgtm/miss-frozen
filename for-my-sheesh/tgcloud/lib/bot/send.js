// Thin Bot API wrappers. TGCloud's `api` proxy throws BotApiError on failure;
// a failed send is logged by method/code only (never with tokens or message
// bodies) and never crashes the handler.

export async function sendMessage(api, params) {
  try {
    return await api.sendMessage(params);
  } catch (error) {
    console.error(
      `[bot] sendMessage failed (${error?.method || 'sendMessage'}: ${error?.code || 'unknown'})`,
    );
    return null;
  }
}

export async function answerCallback(api, params) {
  try {
    return await api.answerCallbackQuery(params);
  } catch (error) {
    console.error(
      `[bot] answerCallbackQuery failed (${error?.method || 'answerCallbackQuery'}: ${
        error?.code || 'unknown'
      })`,
    );
    return null;
  }
}

/** Private chats get link previews disabled; these messages are not articles. */
export function baseMessage(chatId, text, extra = {}) {
  return {
    chat_id: chatId,
    text,
    link_preview_options: { is_disabled: true },
    ...extra,
  };
}
