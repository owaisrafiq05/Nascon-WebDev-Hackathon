import type { Express } from 'express';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { IntegrationEventModel } from '../../db/models/integration-event.js';
import { IntegrationModel, type WorkspaceProvider } from '../../db/models/integration.js';
import { ProviderError } from '../../integrations/http.js';
import { resetProviders } from '../../integrations/registry.js';
import { stripeSignature } from '../../integrations/stripe/stripe.js';
import { twilioSignature } from '../../integrations/twilio/twilio.js';
import { AuditEventModel } from '../../db/models/audit-event.js';
import { LeadModel } from '../../db/models/lead.js';
import { MessageModel } from '../../db/models/message.js';
import { PaymentModel } from '../../db/models/payment.js';
import { decryptSecret, encryptSecret, lastFour } from '../../services/secret-box.js';
import {
  addMember,
  installFakes,
  STRIPE_CREDENTIALS,
  TELEGRAM_CREDENTIALS,
  TWILIO_CREDENTIALS,
  type FakeState,
} from '../../test/fakes.js';
import {
  createTestApp,
  resetDatabase,
  signUpOwner,
  startTestDatabase,
  stopTestDatabase,
  testConfig,
  type TestClient,
} from '../../test/harness.js';

let app: Express;
let fakes: FakeState;
const config = testConfig();
const KEY = config.integrations.encryptionKey ?? Buffer.alloc(32);

beforeAll(async () => {
  await startTestDatabase();
  app = createTestApp(config);
}, 180_000);

afterAll(async () => {
  resetProviders();
  await stopTestDatabase();
});

beforeEach(() => {
  fakes = installFakes();
});

afterEach(async () => {
  await resetDatabase();
});

async function connect(
  owner: TestClient,
  provider: WorkspaceProvider,
  body: Record<string, string>,
) {
  await owner.put(`/api/integrations/${provider}`, body).expect(200);
  const row = await IntegrationModel.findOne({ provider }).lean();
  if (row === null) throw new Error('not connected');
  return row;
}

// ---------------------------------------------------------------------------
// I5: secrets, page, permission, audit, isolation
// ---------------------------------------------------------------------------

describe('secret box (I5.3)', () => {
  it('round-trips, uses a fresh IV, and rejects tampering', () => {
    const a = encryptSecret('top-secret', KEY);
    const b = encryptSecret('top-secret', KEY);
    expect(a).not.toBe(b);
    expect(decryptSecret(a, KEY)).toBe('top-secret');
    const [v, iv, tag, data] = a.split(':');
    const tampered = [v, iv, tag, Buffer.from('x' + (data ?? '')).toString('base64')].join(':');
    expect(() => decryptSecret(tampered, KEY)).toThrow();
    expect(lastFour('abcdef1234')).toBe('••••1234');
  });
});

describe('integrations page (I5.1 - I5.7)', () => {
  it('lists every integration with status, limits and no secrets', async () => {
    const owner = await signUpOwner(app);
    await connect(owner, 'twilio', TWILIO_CREDENTIALS);

    const response = await owner.get('/api/integrations').expect(200);
    const body = JSON.stringify(response.body);
    expect(response.body.integrations.map((entry: { provider: string }) => entry.provider)).toEqual(
      ['twilio', 'stripe', 'telegram', 'google'],
    );
    const twilio = response.body.integrations[0];
    expect(twilio.status).toBe('connected');
    expect(twilio.secretHints.authToken).toBe('••••1234');
    expect(twilio.cannot.join(' ')).toContain('sandbox');
    expect(twilio.webhookUrls.inbound).toMatch(
      /^https:\/\/hooks\.example\.test\/api\/webhooks\/twilio\/[0-9a-f]{48}\/inbound$/,
    );
    // The secret never reaches the browser (I5.3).
    expect(body).not.toContain(TWILIO_CREDENTIALS.authToken);
    expect(response.body.integrations[1].status).toBe('not_connected');
  });

  it('stores credentials encrypted at rest', async () => {
    const owner = await signUpOwner(app);
    const row = await connect(owner, 'stripe', STRIPE_CREDENTIALS);
    expect(JSON.stringify(row.secrets)).not.toContain(STRIPE_CREDENTIALS.secretKey);
    expect(decryptSecret(row.secrets['secretKey'] ?? '', KEY)).toBe(STRIPE_CREDENTIALS.secretKey);
  });

  it('refuses credentials the provider rejects, and records the error', async () => {
    const owner = await signUpOwner(app);
    const response = await owner
      .put('/api/integrations/twilio', { ...TWILIO_CREDENTIALS, authToken: 'bad-token' })
      .expect(502);
    expect(response.body.error.code).toBe('UPSTREAM_FAILED');
    expect(await IntegrationModel.countDocuments()).toBe(0);
    expect(await IntegrationEventModel.countDocuments({ result: 'error' })).toBe(1);
  });

  it('validates credential formats', async () => {
    const owner = await signUpOwner(app);
    const response = await owner
      .put('/api/integrations/stripe', { secretKey: 'sk_live_123', webhookSecret: 'whsec_x' })
      .expect(422);
    expect(response.body.error.details.fields.secretKey).toContain('test-mode');
  });

  it('keeps a stored secret when the field is left blank on update', async () => {
    const owner = await signUpOwner(app);
    await connect(owner, 'twilio', TWILIO_CREDENTIALS);
    await owner.put('/api/integrations/twilio', { from: '+15550001111' }).expect(200);
    const row = await IntegrationModel.findOne({ provider: 'twilio' }).lean();
    expect(row?.publicConfig['from']).toBe('+15550001111');
    expect(decryptSecret(row?.secrets['authToken'] ?? '', KEY)).toBe(TWILIO_CREDENTIALS.authToken);
  });

  it('audits connect, update and disconnect without secrets (I5.7, F4.1)', async () => {
    const owner = await signUpOwner(app);
    await connect(owner, 'telegram', TELEGRAM_CREDENTIALS);
    await owner.put('/api/integrations/telegram', TELEGRAM_CREDENTIALS).expect(200);
    await owner.delete('/api/integrations/telegram').expect(204);

    const types = (
      await AuditEventModel.find({ targetKind: 'integration' }).sort({ at: 1 }).lean()
    ).map((entry) => entry.type);
    expect(types).toEqual([
      'integration.connected',
      'integration.updated',
      'integration.disconnected',
    ]);
    const all = JSON.stringify(await AuditEventModel.find({}).lean());
    expect(all).not.toContain(TELEGRAM_CREDENTIALS.botToken);

    const row = await IntegrationModel.findOne({ provider: 'telegram' }).lean();
    expect(row?.status).toBe('disconnected');
    expect(row?.secrets).toEqual({});
  });

  it('refuses a member without integrations.manage (I5.7, F1.5)', async () => {
    const owner = await signUpOwner(app);
    const user = await addMember(app, owner, 'plain@example.com');
    await user.get('/api/integrations').expect(403);
    await user.put('/api/integrations/twilio', TWILIO_CREDENTIALS).expect(403);
    await user.get('/api/integrations/events').expect(403);
  });

  it('never shows one workspace another workspace connection (I5.2)', async () => {
    const ownerA = await signUpOwner(app);
    const ownerB = await signUpOwner(app);
    await connect(ownerA, 'twilio', TWILIO_CREDENTIALS);
    const response = await ownerB.get('/api/integrations').expect(200);
    expect(response.body.integrations[0].status).toBe('not_connected');
  });
});

// ---------------------------------------------------------------------------
// I1: messaging
// ---------------------------------------------------------------------------

function signedTwilio(
  webhookKey: string,
  kind: 'inbound' | 'status',
  params: Record<string, string>,
) {
  const path = `/api/webhooks/twilio/${webhookKey}/${kind}`;
  const signature = twilioSignature(
    TWILIO_CREDENTIALS.authToken,
    `https://hooks.example.test${path}`,
    params,
  );
  return request(app)
    .post(path)
    .type('form')
    .set('X-Twilio-Signature', signature)
    .send(new URLSearchParams(params).toString());
}

describe('Twilio webhooks (I1.1, I1.2, I1.5, I1.8)', () => {
  it('rejects and records a forged request without writing anything', async () => {
    const owner = await signUpOwner(app);
    const row = await connect(owner, 'twilio', TWILIO_CREDENTIALS);
    await request(app)
      .post(`/api/webhooks/twilio/${row.webhookKey}/inbound`)
      .type('form')
      .set('X-Twilio-Signature', 'forged')
      .send('MessageSid=SM1&From=whatsapp%3A%2B15551230000&Body=hi')
      .expect(403);
    expect(await MessageModel.countDocuments()).toBe(0);
    expect(await IntegrationEventModel.countDocuments({ result: 'rejected' })).toBe(1);
  });

  it('rejects a body altered after signing', async () => {
    const owner = await signUpOwner(app);
    const row = await connect(owner, 'twilio', TWILIO_CREDENTIALS);
    const params = { MessageSid: 'SM2', From: 'whatsapp:+15551230000', Body: 'hello' };
    const path = `/api/webhooks/twilio/${row.webhookKey}/inbound`;
    const signature = twilioSignature(
      TWILIO_CREDENTIALS.authToken,
      `https://hooks.example.test${path}`,
      params,
    );
    await request(app)
      .post(path)
      .type('form')
      .set('X-Twilio-Signature', signature)
      .send(new URLSearchParams({ ...params, Body: 'tampered' }).toString())
      .expect(403);
    expect(await MessageModel.countDocuments()).toBe(0);
  });

  it('answers 404 for an unknown webhook address', async () => {
    await request(app)
      .post(`/api/webhooks/twilio/${'0'.repeat(48)}/inbound`)
      .type('form')
      .send('a=b')
      .expect(404);
  });

  it('creates a contact, a lead and a conversation for an unknown number, once', async () => {
    const owner = await signUpOwner(app);
    const row = await connect(owner, 'twilio', TWILIO_CREDENTIALS);
    const params = {
      MessageSid: 'SM100',
      From: 'whatsapp:+15551234567',
      Body: 'Hi, I need a quote',
      ProfileName: 'Grace',
    };

    await signedTwilio(row.webhookKey, 'inbound', params).expect(200);
    // The provider retries: same MessageSid (I1.8).
    await signedTwilio(row.webhookKey, 'inbound', params).expect(200);

    expect(await MessageModel.countDocuments()).toBe(1);
    const leads = await LeadModel.find({}).lean();
    expect(leads).toHaveLength(1);
    expect(leads[0]?.source).toBe('messaging');
    expect(leads[0]?.sourceLabel).toBe('WhatsApp message');
    expect(await IntegrationEventModel.countDocuments({ result: 'duplicate' })).toBe(1);

    const conversations = await owner.get('/api/conversations').expect(200);
    expect(conversations.body.items).toHaveLength(1);
    expect(conversations.body.items[0].contactName).toBe('Grace');
  });

  it('attaches a message from a known number to the existing contact (I1.5)', async () => {
    const owner = await signUpOwner(app);
    const row = await connect(owner, 'twilio', TWILIO_CREDENTIALS);
    const contact = await owner
      .post('/api/contacts', { firstName: 'Ada', phone: '+1 (555) 222-3333' })
      .expect(201);

    await signedTwilio(row.webhookKey, 'inbound', {
      MessageSid: 'SM200',
      From: 'whatsapp:+15552223333',
      Body: 'hello',
    }).expect(200);

    expect(await LeadModel.countDocuments()).toBe(0);
    const message = await MessageModel.findOne({}).lean();
    expect(message?.contactId.toString()).toBe(contact.body.id);
  });

  it('opts a contact out when they reply STOP (I1.9)', async () => {
    const owner = await signUpOwner(app);
    const row = await connect(owner, 'twilio', TWILIO_CREDENTIALS);
    await signedTwilio(row.webhookKey, 'inbound', {
      MessageSid: 'SM300',
      From: 'whatsapp:+15553334444',
      Body: 'STOP',
    }).expect(200);
    const conversations = await owner.get('/api/conversations').expect(200);
    expect(conversations.body.items[0].optedOut).toBe(true);
  });
});

describe('sending messages (I1.3, I1.4, I1.7, I1.9)', () => {
  async function conversationWith(owner: TestClient, webhookKey: string, phone = '+15557778888') {
    await signedTwilio(webhookKey, 'inbound', {
      MessageSid: `SMin${phone}`,
      From: `whatsapp:${phone}`,
      Body: 'hi',
    }).expect(200);
    const list = await owner.get('/api/conversations').expect(200);
    return list.body.items[0].id as string;
  }

  it('sends a reply through the provider with a status callback', async () => {
    const owner = await signUpOwner(app);
    const row = await connect(owner, 'twilio', TWILIO_CREDENTIALS);
    const conversationId = await conversationWith(owner, row.webhookKey);

    const sent = await owner
      .post(`/api/conversations/${conversationId}/messages`, { body: 'Thanks!' })
      .expect(201);
    expect(sent.body.status).toBe('queued');
    expect(fakes.sent[0]).toMatchObject({ to: 'whatsapp:+15557778888', body: 'Thanks!' });
    expect(fakes.sent[0]?.statusCallbackUrl).toContain(`/webhooks/twilio/${row.webhookKey}/status`);
  });

  it('applies delivery callbacks forward only, and once', async () => {
    const owner = await signUpOwner(app);
    const row = await connect(owner, 'twilio', TWILIO_CREDENTIALS);
    const conversationId = await conversationWith(owner, row.webhookKey);
    await owner
      .post(`/api/conversations/${conversationId}/messages`, { body: 'Hello' })
      .expect(201);
    const sid =
      (await MessageModel.findOne({ direction: 'outbound' }).lean())?.providerMessageId ?? '';

    await signedTwilio(row.webhookKey, 'status', {
      MessageSid: sid,
      MessageStatus: 'delivered',
    }).expect(200);
    // A late "sent" must not move it backwards.
    await signedTwilio(row.webhookKey, 'status', { MessageSid: sid, MessageStatus: 'sent' }).expect(
      200,
    );
    await signedTwilio(row.webhookKey, 'status', {
      MessageSid: sid,
      MessageStatus: 'delivered',
    }).expect(200);

    const thread = await owner.get(`/api/conversations/${conversationId}/messages`).expect(200);
    const outbound = thread.body.items.find(
      (item: { direction: string }) => item.direction === 'outbound',
    );
    expect(outbound.status).toBe('delivered');
  });

  it('records a failed status with a reason in words', async () => {
    const owner = await signUpOwner(app);
    const row = await connect(owner, 'twilio', TWILIO_CREDENTIALS);
    const conversationId = await conversationWith(owner, row.webhookKey);
    await owner
      .post(`/api/conversations/${conversationId}/messages`, { body: 'Hello' })
      .expect(201);
    const sid =
      (await MessageModel.findOne({ direction: 'outbound' }).lean())?.providerMessageId ?? '';

    await signedTwilio(row.webhookKey, 'status', {
      MessageSid: sid,
      MessageStatus: 'undelivered',
      ErrorCode: '63016',
    }).expect(200);
    const message = await MessageModel.findOne({ direction: 'outbound' }).lean();
    expect(message?.status).toBe('undelivered');
    expect(message?.failureReason).toContain('24-hour');
  });

  it('keeps a rejected send visible as failed and lets the employee retry (I1.7)', async () => {
    const owner = await signUpOwner(app);
    const row = await connect(owner, 'twilio', TWILIO_CREDENTIALS);
    const conversationId = await conversationWith(owner, row.webhookKey);

    fakes.failSend = new ProviderError('The To number is not valid', {
      transient: false,
      status: 400,
      providerCode: '21211',
    });
    const failed = await owner
      .post(`/api/conversations/${conversationId}/messages`, { body: 'Hi' })
      .expect(201);
    expect(failed.body.status).toBe('failed');
    expect(failed.body.failureReason).toBe('The phone number is not valid.');

    fakes.failSend = null;
    const retried = await owner.post(`/api/messages/${failed.body.id}/retry`).expect(200);
    expect(retried.body.status).toBe('queued');
    expect(retried.body.attempts).toBe(2);
    await owner.post(`/api/messages/${failed.body.id}/retry`).expect(409);
  });

  it('retries a temporary provider error before giving up (I5.5)', async () => {
    const owner = await signUpOwner(app);
    const row = await connect(owner, 'twilio', TWILIO_CREDENTIALS);
    const conversationId = await conversationWith(owner, row.webhookKey);
    fakes.failSend = new ProviderError('Service unavailable', { transient: true, status: 503 });
    const failed = await owner
      .post(`/api/conversations/${conversationId}/messages`, { body: 'Hi' })
      .expect(201);
    expect(failed.body.status).toBe('failed');
    expect(failed.body.failureReason).toContain('temporarily unavailable');
  }, 20_000);

  it('refuses to message an opted-out contact and says why (I1.9)', async () => {
    const owner = await signUpOwner(app);
    await connect(owner, 'twilio', TWILIO_CREDENTIALS);
    const contact = await owner
      .post('/api/contacts', { firstName: 'Opt', phone: '+15550009999' })
      .expect(201);
    await owner.post(`/api/contacts/${contact.body.id}/opt-out`, { optedOut: true }).expect(200);

    const response = await owner
      .post(`/api/contacts/${contact.body.id}/messages`, { body: 'hi' })
      .expect(409);
    expect(response.body.error.message).toContain('opted out');
    expect(fakes.sent).toHaveLength(0);
  });

  it('shows a conversation only to its assignee or a manager (I1.6)', async () => {
    const owner = await signUpOwner(app);
    const row = await connect(owner, 'twilio', TWILIO_CREDENTIALS);
    const user = await addMember(app, owner, 'rep@example.com');
    const conversationId = await conversationWith(owner, row.webhookKey);

    const list = await user.get('/api/conversations').expect(200);
    expect(list.body.items).toHaveLength(0);
    await user.get(`/api/conversations/${conversationId}/messages`).expect(404);
  });

  it('acknowledges the sender lead when they message the customer (Section 7)', async () => {
    const owner = await signUpOwner(app);
    const row = await connect(owner, 'twilio', TWILIO_CREDENTIALS);
    await owner
      .patch(`/api/availability/${owner.membershipId}`, { status: 'available' })
      .expect(200);
    const conversationId = await conversationWith(owner, row.webhookKey);
    expect((await LeadModel.findOne({}).lean())?.assignmentStatus).toBe('pending_ack');

    await owner
      .post(`/api/conversations/${conversationId}/messages`, { body: 'On it' })
      .expect(201);
    const lead = await LeadModel.findOne({}).lean();
    expect(lead?.assignmentStatus).toBe('acknowledged');
    expect(lead?.firstAcknowledgedAt).toBeInstanceOf(Date);
  });
});

// ---------------------------------------------------------------------------
// I2: payments
// ---------------------------------------------------------------------------

function stripeEvent(
  webhookKey: string,
  event: Record<string, unknown>,
  secret = STRIPE_CREDENTIALS.webhookSecret,
) {
  const raw = Buffer.from(JSON.stringify(event));
  const timestamp = Math.floor(Date.now() / 1_000);
  return (
    request(app)
      .post(`/api/webhooks/stripe/${webhookKey}`)
      .set('Content-Type', 'application/json')
      .set(
        'Stripe-Signature',
        `t=${String(timestamp)},v1=${stripeSignature(secret, timestamp, raw)}`,
      )
      // A string, not the Buffer: superagent would JSON-encode a Buffer object.
      .send(raw.toString('utf8'))
  );
}

async function opportunity(owner: TestClient, value = 100_000) {
  const contact = await owner
    .post('/api/contacts', { firstName: 'Pay', email: 'pay@example.com', phone: '+15554443333' })
    .expect(201);
  const created = await owner
    .post('/api/opportunities', {
      name: 'Solar install',
      contactId: contact.body.id,
      value,
      currency: 'USD',
    })
    .expect(201);
  return { opportunityId: created.body.id as string, contactId: contact.body.id as string };
}

describe('payments (I2.1 - I2.7)', () => {
  it('creates a hosted checkout link for a stated amount', async () => {
    const owner = await signUpOwner(app);
    await connect(owner, 'stripe', STRIPE_CREDENTIALS);
    const { opportunityId } = await opportunity(owner);

    const payment = await owner
      .post(`/api/opportunities/${opportunityId}/payments`, { amount: 25_000, currency: 'usd' })
      .expect(201);
    expect(payment.body).toMatchObject({
      status: 'pending',
      amount: 25_000,
      currency: 'USD',
      checkoutUrl: 'https://checkout.stripe.test/pay',
      opportunityName: 'Solar install',
      contactName: 'Pay',
      requestedByEmail: owner.email,
    });
    expect(payment.body.providerReference).toMatch(/^cs_test_/);
  });

  it('refuses when Stripe is not connected', async () => {
    const owner = await signUpOwner(app);
    const { opportunityId } = await opportunity(owner);
    const response = await owner
      .post(`/api/opportunities/${opportunityId}/payments`, { amount: 1_000, currency: 'USD' })
      .expect(409);
    expect(response.body.error.message).toContain('not connected');
  });

  it('rejects a webhook with a bad signature before changing anything (I2.3)', async () => {
    const owner = await signUpOwner(app);
    const row = await connect(owner, 'stripe', STRIPE_CREDENTIALS);
    await stripeEvent(
      row.webhookKey,
      { id: 'evt_1', type: 'checkout.session.completed' },
      'whsec_wrong',
    ).expect(400);
    expect(await IntegrationEventModel.countDocuments({ result: 'rejected' })).toBe(1);
  });

  it('marks paid from the webhook, once, and counts collected revenue only then (I2.2, I2.4, I2.6)', async () => {
    const owner = await signUpOwner(app);
    const row = await connect(owner, 'stripe', STRIPE_CREDENTIALS);
    const { opportunityId } = await opportunity(owner, 100_000);
    const payment = await owner
      .post(`/api/opportunities/${opportunityId}/payments`, { amount: 25_000, currency: 'USD' })
      .expect(201);

    const before = await owner.get('/api/payments/summary').expect(200);
    expect(before.body.collected.net).toBe(0);
    expect(before.body.projected).toEqual({
      openOpportunities: 100_000,
      unpaidRequests: 25_000,
      total: 125_000,
    });

    const event = {
      id: 'evt_paid_1',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: payment.body.providerReference,
          payment_status: 'paid',
          payment_intent: 'pi_123',
          metadata: { paymentId: payment.body.id, workspaceId: owner.workspaceId },
        },
      },
    };
    await stripeEvent(row.webhookKey, event).expect(200);
    const again = await stripeEvent(row.webhookKey, event).expect(200);
    expect(again.body.outcome).toBe('duplicate');

    const stored = await PaymentModel.findById(payment.body.id).lean();
    expect(stored?.status).toBe('paid');
    expect(stored?.confirmedByWebhook).toBe(true);
    expect(stored?.version).toBe(1);

    const after = await owner.get('/api/payments/summary').expect(200);
    expect(after.body.collected).toEqual({
      gross: 25_000,
      refunded: 0,
      net: 25_000,
      paymentCount: 1,
    });
  });

  it('shows expired, failed and refunded outcomes (I2.5)', async () => {
    const owner = await signUpOwner(app);
    const row = await connect(owner, 'stripe', STRIPE_CREDENTIALS);
    const { opportunityId } = await opportunity(owner);
    const a = await owner
      .post(`/api/opportunities/${opportunityId}/payments`, { amount: 1_000, currency: 'USD' })
      .expect(201);
    const b = await owner
      .post(`/api/opportunities/${opportunityId}/payments`, { amount: 2_000, currency: 'USD' })
      .expect(201);
    const c = await owner
      .post(`/api/opportunities/${opportunityId}/payments`, { amount: 3_000, currency: 'USD' })
      .expect(201);

    await stripeEvent(row.webhookKey, {
      id: 'evt_exp',
      type: 'checkout.session.expired',
      data: { object: { id: a.body.providerReference, metadata: { paymentId: a.body.id } } },
    }).expect(200);
    await stripeEvent(row.webhookKey, {
      id: 'evt_fail',
      type: 'payment_intent.payment_failed',
      data: {
        object: {
          id: 'pi_fail',
          metadata: { paymentId: b.body.id },
          last_payment_error: { message: 'Your card was declined.' },
        },
      },
    }).expect(200);
    await stripeEvent(row.webhookKey, {
      id: 'evt_paid_c',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: c.body.providerReference,
          payment_status: 'paid',
          payment_intent: 'pi_c',
          metadata: { paymentId: c.body.id },
        },
      },
    }).expect(200);
    await stripeEvent(row.webhookKey, {
      id: 'evt_refund_c',
      type: 'charge.refunded',
      data: {
        object: { id: 'ch_c', payment_intent: 'pi_c', amount: 3_000, amount_refunded: 3_000 },
      },
    }).expect(200);

    const list = await owner.get('/api/payments').expect(200);
    const byId = new Map(list.body.items.map((item: { id: string }) => [item.id, item]));
    expect(byId.get(a.body.id)).toMatchObject({ status: 'expired' });
    expect(byId.get(b.body.id)).toMatchObject({
      status: 'failed',
      failureReason: 'Your card was declined.',
    });
    expect(byId.get(c.body.id)).toMatchObject({ status: 'refunded', refundedAmount: 3_000 });

    const summary = await owner.get('/api/payments/summary').expect(200);
    expect(summary.body.collected).toMatchObject({ gross: 3_000, refunded: 3_000, net: 0 });
  });

  it('does not move a paid payment back to expired on a late event', async () => {
    const owner = await signUpOwner(app);
    const row = await connect(owner, 'stripe', STRIPE_CREDENTIALS);
    const { opportunityId } = await opportunity(owner);
    const p = await owner
      .post(`/api/opportunities/${opportunityId}/payments`, { amount: 1_000, currency: 'USD' })
      .expect(201);
    await stripeEvent(row.webhookKey, {
      id: 'evt_a',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: p.body.providerReference,
          payment_status: 'paid',
          metadata: { paymentId: p.body.id },
        },
      },
    }).expect(200);
    await stripeEvent(row.webhookKey, {
      id: 'evt_b',
      type: 'checkout.session.expired',
      data: { object: { id: p.body.providerReference, metadata: { paymentId: p.body.id } } },
    }).expect(200);
    expect((await PaymentModel.findById(p.body.id).lean())?.status).toBe('paid');
  });

  it('ignores an event naming another workspace (I5.2)', async () => {
    const ownerA = await signUpOwner(app);
    const ownerB = await signUpOwner(app);
    await connect(ownerA, 'stripe', STRIPE_CREDENTIALS);
    const { opportunityId } = await opportunity(ownerA);
    const p = await ownerA
      .post(`/api/opportunities/${opportunityId}/payments`, { amount: 1_000, currency: 'USD' })
      .expect(201);

    await ownerB.put('/api/integrations/stripe', STRIPE_CREDENTIALS).expect(200);
    const rowB = await IntegrationModel.findOne({
      workspaceId: ownerB.workspaceId,
      provider: 'stripe',
    }).lean();
    await stripeEvent(rowB?.webhookKey ?? '', {
      id: 'evt_cross',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: p.body.providerReference,
          payment_status: 'paid',
          metadata: { paymentId: p.body.id },
        },
      },
    }).expect(200);
    expect((await PaymentModel.findById(p.body.id).lean())?.status).toBe('pending');
  });

  it('sends the payment link to the customer over messaging', async () => {
    const owner = await signUpOwner(app);
    await connect(owner, 'stripe', STRIPE_CREDENTIALS);
    await connect(owner, 'twilio', TWILIO_CREDENTIALS);
    const { opportunityId } = await opportunity(owner);
    const p = await owner
      .post(`/api/opportunities/${opportunityId}/payments`, { amount: 1_000, currency: 'USD' })
      .expect(201);
    await owner.post(`/api/payments/${p.body.id}/send`).expect(200);
    expect(fakes.sent[0]?.body).toContain('https://checkout.stripe.test/pay');
  });

  it('stores no card data anywhere (I2.8)', () => {
    const payment = PaymentModel.schema.paths;
    expect(Object.keys(payment).some((path) => /card|cvc|pan/i.test(path))).toBe(false);
  });
});
