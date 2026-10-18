import { asRecord, asString, asText, providerFetch, type ErrorExtractor } from '../http.js';

/**
 * Telegram Bot API, the chosen I4 notification channel.
 *
 * Each workspace supplies its own bot token (I5.2); each employee supplies
 * their own chat id (I4.3).
 */
export interface NotificationProvider {
  verifyBot(botToken: string): Promise<{ username: string }>;
  send(botToken: string, chatId: string, text: string): Promise<{ messageId: string }>;
}

const telegramError: ErrorExtractor = (body) => {
  const record = asRecord(body);
  const description = asString(record['description']);
  const code = record['error_code'];
  return {
    ...(description === undefined ? {} : { message: description }),
    ...(asText(code) === undefined ? {} : { code: asText(code) }),
  };
};

export const telegramNotificationProvider: NotificationProvider = {
  async verifyBot(botToken) {
    const { body } = await providerFetch(
      { method: 'GET', url: `https://api.telegram.org/bot${botToken}/getMe` },
      telegramError,
    );
    return { username: asString(asRecord(asRecord(body)['result'])['username']) ?? 'bot' };
  },

  async send(botToken, chatId, text) {
    const { body } = await providerFetch(
      {
        method: 'POST',
        url: `https://api.telegram.org/bot${botToken}/sendMessage`,
        json: { chat_id: chatId, text, disable_web_page_preview: true },
      },
      telegramError,
    );
    const id = asRecord(asRecord(body)['result'])['message_id'];
    return { messageId: asText(id) ?? '' };
  },
};
