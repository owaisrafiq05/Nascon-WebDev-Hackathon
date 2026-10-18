import { createHmac, timingSafeEqual } from 'node:crypto';

import { asRecord, asString, providerFetch, type ErrorExtractor } from '../http.js';

/**
 * Stripe in test mode (I2).
 *
 * Payments are taken only on Stripe Checkout's hosted page, so no card data
 * ever reaches this server (I2.8). Called over REST with the workspace's own
 * secret key (I5.2).
 */
export interface PaymentCredentials {
  readonly secretKey: string;
  readonly webhookSecret: string;
}

export interface CreateCheckoutInput {
  readonly amount: number;
  readonly currency: string;
  readonly description: string;
  readonly customerEmail: string | null;
  readonly successUrl: string;
  readonly cancelUrl: string;
  /** Echoed back in webhooks, so an event finds its payment. */
  readonly paymentId: string;
  readonly workspaceId: string;
  readonly expiresAt: Date;
}

export interface CheckoutSession {
  readonly id: string;
  readonly url: string;
  readonly expiresAt: Date | null;
}

export interface PaymentProvider {
  verifyCredentials(credentials: PaymentCredentials): Promise<{ livemode: boolean }>;
  createCheckout(
    credentials: PaymentCredentials,
    input: CreateCheckoutInput,
  ): Promise<CheckoutSession>;
}

const stripeError: ErrorExtractor = (body) => {
  const error = asRecord(asRecord(body)['error']);
  const message = asString(error['message']);
  const code = asString(error['code']) ?? asString(error['type']);
  return { ...(message === undefined ? {} : { message }), ...(code === undefined ? {} : { code }) };
};

export const stripePaymentProvider: PaymentProvider = {
  async verifyCredentials(credentials) {
    const { body } = await providerFetch(
      {
        method: 'GET',
        url: 'https://api.stripe.com/v1/balance',
        headers: { Authorization: `Bearer ${credentials.secretKey}` },
      },
      stripeError,
    );
    return { livemode: asRecord(body)['livemode'] === true };
  },

  async createCheckout(credentials, input) {
    const { body } = await providerFetch(
      {
        method: 'POST',
        url: 'https://api.stripe.com/v1/checkout/sessions',
        headers: {
          Authorization: `Bearer ${credentials.secretKey}`,
          // Stripe dedupes a retried create with the same key.
          'Idempotency-Key': `checkout-${input.paymentId}`,
        },
        form: {
          mode: 'payment',
          'line_items[0][quantity]': '1',
          'line_items[0][price_data][currency]': input.currency.toLowerCase(),
          'line_items[0][price_data][unit_amount]': String(input.amount),
          'line_items[0][price_data][product_data][name]': input.description,
          success_url: input.successUrl,
          cancel_url: input.cancelUrl,
          client_reference_id: input.paymentId,
          'metadata[paymentId]': input.paymentId,
          'metadata[workspaceId]': input.workspaceId,
          'payment_intent_data[metadata][paymentId]': input.paymentId,
          'payment_intent_data[metadata][workspaceId]': input.workspaceId,
          expires_at: String(Math.floor(input.expiresAt.getTime() / 1_000)),
          ...(input.customerEmail === null ? {} : { customer_email: input.customerEmail }),
        },
      },
      stripeError,
    );
    const record = asRecord(body);
    const expires = record['expires_at'];
    return {
      id: asString(record['id']) ?? '',
      url: asString(record['url']) ?? '',
      expiresAt: typeof expires === 'number' ? new Date(expires * 1_000) : null,
    };
  },
};

/**
 * Stripe's webhook signature (I2.3): header `t=<ts>,v1=<sig>`, where the
 * signature is HMAC-SHA256 of `<ts>.<raw body>` keyed by the endpoint secret.
 * Checked on the raw bytes, before parsing, with a replay tolerance.
 */
export function stripeSignature(secret: string, timestamp: number, rawBody: Buffer): string {
  return createHmac('sha256', secret)
    .update(`${String(timestamp)}.`)
    .update(rawBody)
    .digest('hex');
}

export function verifyStripeSignature(
  secret: string,
  rawBody: Buffer,
  header: string | undefined,
  now: Date = new Date(),
  toleranceSeconds = 300,
): boolean {
  if (header === undefined) return false;
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of header.split(',')) {
    const [key, value] = part.split('=');
    if (key === 't' && value !== undefined) timestamp = Number(value);
    if (key === 'v1' && value !== undefined) signatures.push(value);
  }
  if (timestamp === null || !Number.isFinite(timestamp) || signatures.length === 0) return false;
  if (Math.abs(now.getTime() / 1_000 - timestamp) > toleranceSeconds) return false;

  const expected = Buffer.from(stripeSignature(secret, timestamp, rawBody));
  return signatures.some((signature) => {
    const actual = Buffer.from(signature);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  });
}
