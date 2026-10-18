import { createHmac, timingSafeEqual } from 'node:crypto';

import { asRecord, asString, asText, providerFetch, type ErrorExtractor } from '../http.js';

/**
 * Twilio Programmable Messaging, WhatsApp sandbox or SMS (I1).
 *
 * Called over REST with the workspace's own Account SID and Auth Token (I5.2);
 * no SDK, so the provider stays behind the `MessagingProvider` interface.
 */
export interface MessagingCredentials {
  readonly accountSid: string;
  readonly authToken: string;
  /** The sender, e.g. `whatsapp:+14155238886` or `+15551234567`. */
  readonly from: string;
}

export interface SendMessageInput {
  readonly to: string;
  readonly body: string;
  readonly statusCallbackUrl: string | null;
}

export interface SentMessage {
  readonly providerMessageId: string;
  readonly status: string;
}

export interface MessagingProvider {
  verifyCredentials(credentials: MessagingCredentials): Promise<{ accountName: string }>;
  send(credentials: MessagingCredentials, input: SendMessageInput): Promise<SentMessage>;
}

const twilioError: ErrorExtractor = (body) => {
  const record = asRecord(body);
  const code = record['code'];
  return {
    ...(asString(record['message']) === undefined ? {} : { message: asString(record['message']) }),
    ...(asText(code) === undefined ? {} : { code: asText(code) }),
  };
};

function authHeader(credentials: MessagingCredentials): Record<string, string> {
  const basic = Buffer.from(`${credentials.accountSid}:${credentials.authToken}`).toString(
    'base64',
  );
  return { Authorization: `Basic ${basic}` };
}

export const twilioMessagingProvider: MessagingProvider = {
  async verifyCredentials(credentials) {
    const { body } = await providerFetch(
      {
        method: 'GET',
        url: `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(credentials.accountSid)}.json`,
        headers: authHeader(credentials),
      },
      twilioError,
    );
    return { accountName: asString(asRecord(body)['friendly_name']) ?? credentials.accountSid };
  },

  async send(credentials, input) {
    const { body } = await providerFetch(
      {
        method: 'POST',
        url: `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(credentials.accountSid)}/Messages.json`,
        headers: authHeader(credentials),
        form: {
          From: credentials.from,
          To: input.to,
          Body: input.body,
          ...(input.statusCallbackUrl === null ? {} : { StatusCallback: input.statusCallbackUrl }),
        },
      },
      twilioError,
    );
    const record = asRecord(body);
    return {
      providerMessageId: asString(record['sid']) ?? '',
      status: asString(record['status']) ?? 'queued',
    };
  },
};

/**
 * Twilio's request signature (I1.2): HMAC-SHA1, keyed by the Auth Token, over
 * the full callback URL followed by every POST parameter sorted by name with
 * its value appended, base64 encoded.
 */
export function twilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
): string {
  const data = Object.keys(params)
    .sort()
    .reduce((accumulator, key) => accumulator + key + (params[key] ?? ''), url);
  return createHmac('sha1', authToken).update(Buffer.from(data, 'utf8')).digest('base64');
}

export function verifyTwilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
  supplied: string | undefined,
): boolean {
  if (supplied === undefined || supplied === '') return false;
  const expected = Buffer.from(twilioSignature(authToken, url, params));
  const actual = Buffer.from(supplied);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
