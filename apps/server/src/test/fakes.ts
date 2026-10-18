/* eslint-disable @typescript-eslint/require-await -- fakes implement async provider interfaces synchronously */
import type { Express } from 'express';
import request from 'supertest';

import type { CalendarProvider, GoogleTokens } from '../integrations/google/google.js';
import { ProviderError } from '../integrations/http.js';
import { overrideProviders } from '../integrations/registry.js';
import type { PaymentProvider } from '../integrations/stripe/stripe.js';
import type { NotificationProvider } from '../integrations/telegram/telegram.js';
import type { MessagingProvider } from '../integrations/twilio/twilio.js';
import { signIn, TEST_PASSWORD, type TestClient } from './harness.js';

/**
 * In-memory stand-ins for the four providers, so the integration paths run
 * end to end in tests without network access. Each records its calls and can
 * be told to fail, transiently or permanently.
 */
export interface FakeState {
  sent: { to: string; body: string; statusCallbackUrl: string | null }[];
  checkouts: { paymentId: string; amount: number; currency: string }[];
  alerts: { chatId: string; text: string }[];
  events: { id: string; summary: string; startsAt: Date; endsAt: Date; timeZone: string }[];
  deletedEvents: string[];
  busy: { start: Date; end: Date }[];
  failSend: ProviderError | null;
  failAlert: ProviderError | null;
  failRefresh: ProviderError | null;
  refreshCount: number;
}

export function installFakes(): FakeState {
  const state: FakeState = {
    sent: [],
    checkouts: [],
    alerts: [],
    events: [],
    deletedEvents: [],
    busy: [],
    failSend: null,
    failAlert: null,
    failRefresh: null,
    refreshCount: 0,
  };
  let counter = 0;
  const next = (prefix: string): string => {
    counter += 1;
    return `${prefix}${String(counter).padStart(6, '0')}`;
  };

  const messaging: MessagingProvider = {
    verifyCredentials: async (credentials) => {
      if (credentials.authToken === 'bad-token') {
        throw new ProviderError('Authenticate', {
          transient: false,
          status: 401,
          providerCode: '20003',
        });
      }
      return { accountName: 'Test account' };
    },
    send: async (_credentials, input) => {
      if (state.failSend !== null) throw state.failSend;
      state.sent.push({
        to: input.to,
        body: input.body,
        statusCallbackUrl: input.statusCallbackUrl,
      });
      return { providerMessageId: next('SM'), status: 'queued' };
    },
  };

  const payments: PaymentProvider = {
    verifyCredentials: async () => ({ livemode: false }),
    createCheckout: async (_credentials, input) => {
      state.checkouts.push({
        paymentId: input.paymentId,
        amount: input.amount,
        currency: input.currency,
      });
      return {
        id: next('cs_test_'),
        url: 'https://checkout.stripe.test/pay',
        expiresAt: input.expiresAt,
      };
    },
  };

  const tokens = (): GoogleTokens => ({
    accessToken: next('access-'),
    refreshToken: 'refresh-token',
    expiresAt: new Date(Date.now() + 3_600_000),
  });

  const calendar: CalendarProvider = {
    authorizationUrl: (_client, stateValue) =>
      `https://accounts.google.test/auth?state=${encodeURIComponent(stateValue)}`,
    exchangeCode: async () => tokens(),
    refresh: async () => {
      state.refreshCount += 1;
      if (state.failRefresh !== null) throw state.failRefresh;
      return tokens();
    },
    revoke: async () => undefined,
    profile: async () => ({ email: 'employee@gmail.test', timeZone: 'Asia/Karachi' }),
    busy: async () => state.busy,
    createEvent: async (_token, _calendarId, event) => {
      const id = next('evt');
      state.events.push({ id, ...event });
      return { id, htmlLink: `https://calendar.google.test/${id}` };
    },
    updateEvent: async (_token, _calendarId, eventId, event) => {
      const found = state.events.find((entry) => entry.id === eventId);
      if (found !== undefined) Object.assign(found, event);
    },
    deleteEvent: async (_token, _calendarId, eventId) => {
      state.deletedEvents.push(eventId);
    },
  };

  const notifications: NotificationProvider = {
    verifyBot: async () => ({ username: 'ubmp_test_bot' }),
    send: async (_token, chatId, text) => {
      if (state.failAlert !== null) throw state.failAlert;
      state.alerts.push({ chatId, text });
      return { messageId: next('') };
    },
  };

  overrideProviders({ messaging, payments, calendar, notifications });
  return state;
}

export const TWILIO_CREDENTIALS = {
  accountSid: `AC${'a'.repeat(32)}`,
  authToken: 'twilio-auth-token-1234',
  from: 'whatsapp:+14155238886',
};

export const STRIPE_CREDENTIALS = {
  secretKey: 'sk_test_abcdef123456',
  webhookSecret: 'whsec_testsecret987',
};

export const TELEGRAM_CREDENTIALS = { botToken: '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ' };

export async function addMember(
  app: Express,
  owner: TestClient,
  email: string,
  baseLevel: 'admin' | 'user' = 'user',
): Promise<TestClient> {
  const invite = await owner.post('/api/members/invites', { email, baseLevel }).expect(201);
  const { token } = invite.body as { token: string };
  await request(app)
    .post('/api/members/invites/accept')
    .send({ token, name: email, password: TEST_PASSWORD })
    .expect(204);
  return signIn(app, email);
}
