/* eslint-disable @typescript-eslint/require-await -- stubs implement async signatures synchronously */
import { createHmac } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { isTransientStatus, ProviderError, providerFetch, withRetry } from './http.js';
import { stripeSignature, verifyStripeSignature } from './stripe/stripe.js';
import { twilioSignature, verifyTwilioSignature } from './twilio/twilio.js';

describe('Twilio signature (I1.2)', () => {
  const url = 'https://hooks.example.test/api/webhooks/twilio/k/inbound';
  const params = { From: 'whatsapp:+1555', Body: 'hi', MessageSid: 'SM1' };

  it('is HMAC-SHA1 over the URL and the sorted parameters', () => {
    const expected = createHmac('sha1', 'token')
      .update(`${url}Bodyhi` + 'Fromwhatsapp:+1555' + 'MessageSidSM1')
      .digest('base64');
    expect(twilioSignature('token', url, params)).toBe(expected);
  });

  it('accepts the genuine signature and rejects any change', () => {
    const signature = twilioSignature('token', url, params);
    expect(verifyTwilioSignature('token', url, params, signature)).toBe(true);
    expect(verifyTwilioSignature('token', url, { ...params, Body: 'changed' }, signature)).toBe(
      false,
    );
    expect(verifyTwilioSignature('other', url, params, signature)).toBe(false);
    expect(verifyTwilioSignature('token', `${url}?x=1`, params, signature)).toBe(false);
    expect(verifyTwilioSignature('token', url, params, undefined)).toBe(false);
  });
});

describe('Stripe signature (I2.3)', () => {
  const body = Buffer.from('{"id":"evt_1"}');
  const now = new Date('2030-01-01T00:00:00Z');
  const t = Math.floor(now.getTime() / 1_000);

  it('accepts a fresh, genuine signature', () => {
    const header = `t=${String(t)},v1=${stripeSignature('whsec_x', t, body)}`;
    expect(verifyStripeSignature('whsec_x', body, header, now)).toBe(true);
  });

  it('rejects a wrong secret, an altered body, a replay and a malformed header', () => {
    const header = `t=${String(t)},v1=${stripeSignature('whsec_x', t, body)}`;
    expect(verifyStripeSignature('whsec_y', body, header, now)).toBe(false);
    expect(verifyStripeSignature('whsec_x', Buffer.from('{"id":"evt_2"}'), header, now)).toBe(
      false,
    );
    expect(verifyStripeSignature('whsec_x', body, header, new Date(now.getTime() + 301_000))).toBe(
      false,
    );
    expect(verifyStripeSignature('whsec_x', body, 'garbage', now)).toBe(false);
    expect(verifyStripeSignature('whsec_x', body, undefined, now)).toBe(false);
  });
});

describe('provider HTTP (I5.5)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('classifies statuses as temporary or permanent', () => {
    expect(isTransientStatus(429)).toBe(true);
    expect(isTransientStatus(503)).toBe(true);
    expect(isTransientStatus(400)).toBe(false);
    expect(isTransientStatus(401)).toBe(false);
  });

  it('turns an error body into a ProviderError with the provider message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ message: 'bad number', code: 21211 }), { status: 400 }),
      ),
    );
    await expect(
      providerFetch({ method: 'GET', url: 'https://x.test' }, (body) => ({
        message: (body as { message: string }).message,
        code: '21211',
      })),
    ).rejects.toMatchObject({
      message: 'bad number',
      transient: false,
      status: 400,
      providerCode: '21211',
    });
  });

  it('reports an unreachable provider as temporary', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );
    await expect(providerFetch({ method: 'GET', url: 'https://x.test' })).rejects.toMatchObject({
      transient: true,
    });
  });

  it('retries temporary failures only', async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw new ProviderError('busy', { transient: true, status: 503 });
        return 'ok';
      },
      { baseDelayMs: 1 },
    );
    expect(result).toBe('ok');
    expect(calls).toBe(3);

    let permanentCalls = 0;
    await expect(
      withRetry(
        async () => {
          permanentCalls += 1;
          throw new ProviderError('no', { transient: false, status: 400 });
        },
        { baseDelayMs: 1 },
      ),
    ).rejects.toThrow('no');
    expect(permanentCalls).toBe(1);
  });
});
