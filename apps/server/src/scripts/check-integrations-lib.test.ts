import { describe, expect, it, vi } from 'vitest';

import type { Providers } from '../integrations/registry.js';

import {
  checkEncryptionKey,
  checkGoogle,
  checkPublicBaseUrl,
  formatResult,
  hasFailure,
  missingVars,
  parseArgs,
  redact,
  runChecks,
  twilioRecipient,
} from './check-integrations-lib.js';

const noArgs = parseArgs([]);

const spies = {
  twilioVerify: vi.fn(),
  twilioSend: vi.fn(),
  stripeVerify: vi.fn(),
  telegramVerify: vi.fn(),
  telegramSend: vi.fn(),
};

function fakeProviders(overrides: Partial<Providers> = {}): Providers {
  spies.twilioVerify.mockReset().mockResolvedValue({ accountName: 'Sandbox' });
  spies.twilioSend.mockReset().mockResolvedValue({ providerMessageId: 'SM1', status: 'queued' });
  spies.stripeVerify.mockReset().mockResolvedValue({ livemode: false });
  spies.telegramVerify.mockReset().mockResolvedValue({ username: 'ubmp_bot' });
  spies.telegramSend.mockReset().mockResolvedValue({ messageId: '42' });
  return {
    messaging: {
      verifyCredentials: (c) => spies.twilioVerify(c) as Promise<{ accountName: string }>,
      send: (c, i) =>
        spies.twilioSend(c, i) as Promise<{ providerMessageId: string; status: string }>,
    },
    payments: {
      verifyCredentials: (c) => spies.stripeVerify(c) as Promise<{ livemode: boolean }>,
      createCheckout: () => Promise.reject(new Error('not used')),
    },
    calendar: {
      authorizationUrl: (client: { clientId: string; redirectUri: string }, state: string) =>
        `https://accounts.google.com/o/oauth2/v2/auth?client_id=${client.clientId}&redirect_uri=${encodeURIComponent(client.redirectUri)}&state=${state}`,
    } as unknown as Providers['calendar'],
    notifications: {
      verifyBot: (t) => spies.telegramVerify(t) as Promise<{ username: string }>,
      send: (t, c, x) => spies.telegramSend(t, c, x) as Promise<{ messageId: string }>,
    },
    ...overrides,
  };
}

const fullEnv = {
  ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
  PUBLIC_BASE_URL: 'https://demo.example.com',
  TWILIO_ACCOUNT_SID: 'ACabcdef1234567890',
  TWILIO_AUTH_TOKEN: 'twilio-secret-token-9999',
  TWILIO_WHATSAPP_FROM: 'whatsapp:+14155238886',
  STRIPE_SECRET_KEY: 'sk_test_supersecret1234',
  STRIPE_WEBHOOK_SECRET: 'whsec_webhooksecret5678',
  TELEGRAM_BOT_TOKEN: '123456:telegram-token-ABCD',
  GOOGLE_OAUTH_CLIENT_ID: 'client-id-0001.apps.googleusercontent.com',
  GOOGLE_OAUTH_CLIENT_SECRET: 'GOCSPX-google-secret-7777',
  GOOGLE_OAUTH_REDIRECT_URI: 'https://demo.example.com/api/google/callback',
};

describe('parseArgs', () => {
  it('reads both flags with values', () => {
    expect(parseArgs(['--send-telegram', '555', '--twilio-to', '+92300'])).toMatchObject({
      sendTelegram: '555',
      twilioTo: '+92300',
      errors: [],
    });
  });

  it('sends nothing by default', () => {
    expect(noArgs).toEqual({ sendTelegram: null, twilioTo: null, help: false, errors: [] });
  });

  it('reports a flag without a value and unknown flags', () => {
    expect(parseArgs(['--send-telegram']).errors).toEqual(['--send-telegram needs a value']);
    expect(parseArgs(['--twilio-to', '--help']).errors).toEqual(['--twilio-to needs a value']);
    expect(parseArgs(['--nope']).errors).toEqual(['unknown argument --nope']);
  });

  it('recognises help', () => {
    expect(parseArgs(['-h']).help).toBe(true);
  });
});

describe('missingVars', () => {
  it('treats unset and blank values as missing', () => {
    expect(missingVars({ A: 'x', B: '  ', C: undefined }, ['A', 'B', 'C', 'D'])).toEqual([
      'B',
      'C',
      'D',
    ]);
  });
});

describe('redact and formatResult', () => {
  it('masks secrets to their last four characters', () => {
    const text = redact('bad token twilio-secret-token-9999 given', ['twilio-secret-token-9999']);
    expect(text).not.toContain('twilio-secret-token');
    expect(text).toContain('9999');
  });

  it('formats one line per result', () => {
    expect(formatResult({ name: 'stripe', status: 'SKIP', detail: 'missing X' })).toBe(
      'SKIP stripe: missing X',
    );
  });
});

describe('config checks', () => {
  it('accepts a 32 byte key and rejects others', () => {
    expect(checkEncryptionKey(fullEnv).status).toBe('OK');
    expect(checkEncryptionKey({ ENCRYPTION_KEY: 'c2hvcnQ=' }).detail).toContain('5 bytes');
    expect(checkEncryptionKey({}).status).toBe('FAIL');
  });

  it('requires an https public base url', () => {
    expect(checkPublicBaseUrl(fullEnv).status).toBe('OK');
    expect(checkPublicBaseUrl({ PUBLIC_BASE_URL: 'http://localhost:4000' }).detail).toContain(
      'https',
    );
    expect(checkPublicBaseUrl({ PUBLIC_BASE_URL: 'not a url' }).status).toBe('FAIL');
    expect(checkPublicBaseUrl({}).status).toBe('FAIL');
  });
});

describe('twilioRecipient', () => {
  it('adds the whatsapp prefix only for a WhatsApp sender', () => {
    expect(twilioRecipient('whatsapp:+1415', '+9230')).toBe('whatsapp:+9230');
    expect(twilioRecipient('whatsapp:+1415', 'whatsapp:+9230')).toBe('whatsapp:+9230');
    expect(twilioRecipient('+1415', '+9230')).toBe('+9230');
  });
});

describe('checkGoogle', () => {
  it('skips and names the missing variables', () => {
    const result = checkGoogle({ GOOGLE_OAUTH_CLIENT_ID: 'x' }, fakeProviders());
    expect(result).toMatchObject({ status: 'SKIP' });
    expect(result.detail).toContain('GOOGLE_OAUTH_CLIENT_SECRET');
    expect(result.detail).toContain('GOOGLE_OAUTH_REDIRECT_URI');
  });

  it('prints the url shape without the full client id or the secret', () => {
    const result = checkGoogle(fullEnv, fakeProviders());
    expect(result.status).toBe('OK');
    expect(result.detail).toContain('accounts.google.com');
    expect(result.detail).not.toContain('client-id-0001');
    expect(result.detail).not.toContain('google-secret');
  });
});

describe('runChecks', () => {
  it('skips every provider when nothing is configured and calls nothing', async () => {
    const p = fakeProviders();
    const results = await runChecks({}, noArgs, p);
    expect(results.filter((r) => r.status === 'SKIP').map((r) => r.name)).toEqual([
      'twilio',
      'stripe',
      'google',
      'telegram',
    ]);
    expect(spies.twilioVerify).not.toHaveBeenCalled();
    expect(spies.stripeVerify).not.toHaveBeenCalled();
    expect(spies.telegramVerify).not.toHaveBeenCalled();
  });

  it('passes with full credentials, sends nothing and prints no secret', async () => {
    const p = fakeProviders();
    const results = await runChecks(fullEnv, noArgs, p);
    expect(hasFailure(results)).toBe(false);
    expect(results.map((r) => r.status)).toEqual(['OK', 'OK', 'OK', 'OK', 'OK', 'OK']);
    expect(spies.twilioSend).not.toHaveBeenCalled();
    expect(spies.telegramSend).not.toHaveBeenCalled();
    const printed = results.map(formatResult).join('\n');
    for (const secret of [
      fullEnv.TWILIO_AUTH_TOKEN,
      fullEnv.STRIPE_SECRET_KEY,
      fullEnv.STRIPE_WEBHOOK_SECRET,
      fullEnv.TELEGRAM_BOT_TOKEN,
      fullEnv.GOOGLE_OAUTH_CLIENT_SECRET,
      fullEnv.ENCRYPTION_KEY,
    ]) {
      expect(printed).not.toContain(secret);
    }
  });

  it('sends one message per flag', async () => {
    const p = fakeProviders();
    await runChecks(fullEnv, parseArgs(['--send-telegram', '555', '--twilio-to', '+92300']), p);
    expect(spies.telegramSend).toHaveBeenCalledWith(
      fullEnv.TELEGRAM_BOT_TOKEN,
      '555',
      expect.any(String),
    );
    expect(spies.twilioSend).toHaveBeenCalledWith(
      expect.objectContaining({ from: fullEnv.TWILIO_WHATSAPP_FROM }),
      expect.objectContaining({ to: 'whatsapp:+92300' }),
    );
  });

  it('refuses a live Stripe key without calling Stripe', async () => {
    const p = fakeProviders();
    const results = await runChecks(
      { ...fullEnv, STRIPE_SECRET_KEY: 'sk_live_abcdef123456' },
      noArgs,
      p,
    );
    expect(results.find((r) => r.name === 'stripe')).toMatchObject({ status: 'FAIL' });
    expect(spies.stripeVerify).not.toHaveBeenCalled();
    expect(hasFailure(results)).toBe(true);
  });

  it('refuses when Stripe reports live mode', async () => {
    const p = fakeProviders({
      payments: {
        verifyCredentials: () => Promise.resolve({ livemode: true }),
        createCheckout: () => Promise.reject(new Error('not used')),
      },
    });
    const results = await runChecks(fullEnv, noArgs, p);
    expect(results.find((r) => r.name === 'stripe')?.status).toBe('FAIL');
  });

  it('turns a provider error into FAIL with the token masked', async () => {
    const p = fakeProviders({
      notifications: {
        verifyBot: () => Promise.reject(new Error(`bad ${fullEnv.TELEGRAM_BOT_TOKEN}`)),
        send: () => Promise.reject(new Error('not used')),
      },
    });
    const results = await runChecks(fullEnv, noArgs, p);
    const telegram = results.find((r) => r.name === 'telegram');
    expect(telegram?.status).toBe('FAIL');
    expect(telegram?.detail).not.toContain(fullEnv.TELEGRAM_BOT_TOKEN);
    expect(telegram?.detail).toContain('ABCD');
  });
});
