import {
  collectedRevenue,
  projectedRevenue,
  type OpportunityForPipeline,
  type PaymentRecord,
  type PaymentStatus,
} from '@ubmp/domain';
import { AppError, ERROR_CODES, notFound } from '@ubmp/shared';
import mongoose, { type ClientSession, Types } from 'mongoose';

import type { IntegrationsConfig } from '../config.js';
import { ContactModel, contactDisplayName } from '../db/models/contact.js';
import type { IntegrationDoc } from '../db/models/integration.js';
import { OpportunityModel } from '../db/models/opportunity.js';
import { PaymentModel, type PaymentDoc } from '../db/models/payment.js';
import { withRetry, asRecord, asString } from '../integrations/http.js';
import { providers } from '../integrations/registry.js';
import { recordActivity } from '../repositories/activity-repository.js';
import { claimProviderEvent, recordIntegrationEvent } from '../repositories/integration-events.js';
import { appendOutbox } from '../repositories/outbox.js';
import type { Actor } from './crm-service.js';
import { notConnected, providerFailure, workspaceSecrets } from './integration-service.js';
import { membershipLabels, settingsFor } from './lead-service.js';
import type { AuthContext } from './session-service.js';

/**
 * Payments through Stripe Checkout (I2.1 - I2.8).
 *
 * The status of a payment changes **only** from a verified webhook. The
 * success redirect is cosmetic; a person cannot mark something paid.
 */

/** Stripe Checkout sessions last at most 24 hours. */
export const CHECKOUT_LIFETIME_MS = 23 * 60 * 60 * 1_000;

export async function paymentViews(workspaceId: Types.ObjectId, payments: readonly PaymentDoc[]) {
  const opportunityIds = [...new Set(payments.map((payment) => payment.opportunityId.toString()))];
  const contactIds = [
    ...new Set(
      payments
        .map((payment) => payment.contactId?.toString())
        .filter((id): id is string => id !== undefined),
    ),
  ];
  const [opportunities, contacts, labels] = await Promise.all([
    OpportunityModel.find({ workspaceId, _id: { $in: opportunityIds } })
      .select('name')
      .lean(),
    ContactModel.find({ workspaceId, _id: { $in: contactIds } })
      .select('firstName lastName')
      .lean(),
    membershipLabels(workspaceId),
  ]);
  const opportunityName = new Map(opportunities.map((entry) => [entry._id.toString(), entry.name]));
  const contactName = new Map(
    contacts.map((entry) => [entry._id.toString(), contactDisplayName(entry)]),
  );

  return payments.map((payment) => ({
    id: payment._id.toString(),
    opportunityId: payment.opportunityId.toString(),
    opportunityName: opportunityName.get(payment.opportunityId.toString()) ?? '(deleted)',
    contactId: payment.contactId?.toString() ?? null,
    contactName:
      payment.contactId === null ? null : (contactName.get(payment.contactId.toString()) ?? null),
    requestedByMembershipId: payment.requestedByMembershipId.toString(),
    requestedByEmail: labels.get(payment.requestedByMembershipId.toString())?.email ?? null,
    amount: payment.amount,
    currency: payment.currency,
    description: payment.description,
    status: payment.status,
    confirmedByWebhook: payment.confirmedByWebhook,
    refundedAmount: payment.refundedAmount,
    providerReference: payment.providerReference,
    checkoutUrl:
      payment.status === 'pending' || payment.status === 'failed' ? payment.checkoutUrl : null,
    failureReason: payment.failureReason,
    paidAt: payment.paidAt?.toISOString() ?? null,
    expiresAt: payment.expiresAt?.toISOString() ?? null,
    createdAt: payment.createdAt.toISOString(),
  }));
}

// ---------------------------------------------------------------------------
// Requesting a payment (I2.1)
// ---------------------------------------------------------------------------

export async function requestPayment(input: {
  readonly auth: AuthContext;
  readonly opportunityId: string;
  readonly amount: number;
  readonly currency: string;
  readonly description: string | undefined;
  readonly actor: Actor;
  readonly config: IntegrationsConfig;
}): Promise<PaymentDoc> {
  const { auth } = input;
  if (!Types.ObjectId.isValid(input.opportunityId))
    throw notFound('That opportunity does not exist.');
  const opportunity = await OpportunityModel.findOne({
    _id: new Types.ObjectId(input.opportunityId),
    workspaceId: auth.workspaceId,
  }).lean();
  if (opportunity === null) throw notFound('That opportunity does not exist.');

  const stripe = await workspaceSecrets(auth.workspaceId, 'stripe', input.config.encryptionKey);
  if (stripe === null) throw notConnected('Payments');

  const contact =
    opportunity.contactId === null
      ? null
      : await ContactModel.findOne({ _id: opportunity.contactId, workspaceId: auth.workspaceId })
          .select('email')
          .lean();

  const description = input.description?.trim() || opportunity.name;
  const expiresAt = new Date(Date.now() + CHECKOUT_LIFETIME_MS);
  const payment = await PaymentModel.create({
    workspaceId: auth.workspaceId,
    opportunityId: opportunity._id,
    contactId: opportunity.contactId,
    requestedByMembershipId: input.actor.membershipId,
    amount: input.amount,
    currency: input.currency.toUpperCase(),
    description,
    status: 'pending',
    expiresAt,
  });

  const back = `${input.config.webAppUrl}/opportunities/${opportunity._id.toString()}`;
  try {
    const checkout = await withRetry(() =>
      providers().payments.createCheckout(
        {
          secretKey: stripe.values['secretKey'] ?? '',
          webhookSecret: stripe.values['webhookSecret'] ?? '',
        },
        {
          amount: input.amount,
          currency: input.currency,
          description,
          customerEmail: contact?.email ?? null,
          successUrl: `${back}?payment=success`,
          cancelUrl: `${back}?payment=cancelled`,
          paymentId: payment._id.toString(),
          workspaceId: auth.workspaceId.toString(),
          expiresAt,
        },
      ),
    );

    await recordIntegrationEvent({
      workspaceId: auth.workspaceId,
      provider: 'stripe',
      direction: 'outbound',
      kind: 'api.create_checkout',
      result: 'ok',
      reference: checkout.id,
    });

    const updated = await PaymentModel.findOneAndUpdate(
      { _id: payment._id },
      {
        $set: {
          providerReference: checkout.id,
          checkoutUrl: checkout.url,
          ...(checkout.expiresAt === null ? {} : { expiresAt: checkout.expiresAt }),
        },
      },
      { returnDocument: 'after' },
    ).lean();

    await recordActivity({
      workspaceId: auth.workspaceId,
      type: 'payment.requested',
      targetKind: 'opportunity',
      targetId: opportunity._id,
      contactId: opportunity.contactId,
      actor: input.actor,
      summary: `Payment of ${formatMoney(input.amount, input.currency)} requested`,
      payload: { paymentId: payment._id.toString(), providerReference: checkout.id },
    });
    await appendOutbox(auth.workspaceId, 'payment.updated', {
      paymentId: payment._id.toString(),
      opportunityId: opportunity._id.toString(),
    });

    if (updated === null) throw new Error('payment vanished');
    return updated;
  } catch (error) {
    // The request never reached a customer, so it is removed rather than left
    // pending with no link.
    await PaymentModel.deleteOne({ _id: payment._id, providerReference: null });
    await recordIntegrationEvent({
      workspaceId: auth.workspaceId,
      provider: 'stripe',
      direction: 'outbound',
      kind: 'api.create_checkout',
      result: 'error',
      reference: payment._id.toString(),
      error,
    });
    throw providerFailure(error, 'Stripe could not create the payment link');
  }
}

export function formatMoney(amount: number, currency: string): string {
  return `${(amount / 100).toFixed(2)} ${currency.toUpperCase()}`;
}

// ---------------------------------------------------------------------------
// Webhook processing (I2.2 - I2.5)
// ---------------------------------------------------------------------------

/** Which statuses may follow which: never backwards, and refunded is final. */
const ALLOWED_FROM: Record<PaymentStatus, readonly PaymentStatus[]> = {
  pending: [],
  paid: ['pending', 'failed', 'expired'],
  failed: ['pending'],
  expired: ['pending', 'failed'],
  refunded: ['pending', 'failed', 'paid', 'expired'],
};

async function findPayment(
  workspaceId: Types.ObjectId,
  lookup: {
    paymentId?: string | undefined;
    sessionId?: string | undefined;
    paymentIntent?: string | undefined;
  },
  session: ClientSession,
): Promise<PaymentDoc | null> {
  const or: Record<string, unknown>[] = [];
  if (lookup.paymentId !== undefined && Types.ObjectId.isValid(lookup.paymentId)) {
    or.push({ _id: new Types.ObjectId(lookup.paymentId) });
  }
  if (lookup.sessionId !== undefined) or.push({ providerReference: lookup.sessionId });
  if (lookup.paymentIntent !== undefined) or.push({ providerPaymentId: lookup.paymentIntent });
  if (or.length === 0) return null;
  return PaymentModel.findOne({ workspaceId, $or: or }).session(session).lean();
}

export type StripeOutcome = 'applied' | 'duplicate' | 'ignored';

/**
 * Applies one verified Stripe event. Idempotent through the event id claim
 * (I2.4): a redelivery records a duplicate and changes nothing.
 */
export async function applyStripeEvent(
  integration: IntegrationDoc,
  event: Record<string, unknown>,
): Promise<StripeOutcome> {
  const eventId = asString(event['id']) ?? '';
  const type = asString(event['type']) ?? '';
  const object = asRecord(asRecord(event['data'])['object']);
  const metadata = asRecord(object['metadata']);
  const workspaceId = integration.workspaceId;

  const session = await mongoose.startSession();
  try {
    let outcome: StripeOutcome = 'ignored';
    await session.withTransaction(async () => {
      const claimed = await claimProviderEvent(
        {
          workspaceId,
          provider: 'stripe',
          kind: `webhook.${type}`,
          providerEventId: eventId,
          reference: asString(object['id']) ?? null,
        },
        session,
      );
      if (!claimed) {
        outcome = 'duplicate';
        return;
      }

      // A webhook that names another workspace is ignored, never applied (I5.2).
      const metaWorkspace = asString(metadata['workspaceId']);
      if (metaWorkspace !== undefined && metaWorkspace !== workspaceId.toString()) {
        outcome = 'ignored';
        return;
      }

      let next: PaymentStatus | null = null;
      let set: Record<string, unknown> = {};
      let lookup: Parameters<typeof findPayment>[1];
      const paymentIntent = asString(object['payment_intent']);

      switch (type) {
        case 'checkout.session.completed':
        case 'checkout.session.async_payment_succeeded':
          lookup = {
            paymentId: asString(metadata['paymentId']) ?? asString(object['client_reference_id']),
            sessionId: asString(object['id']),
          };
          if (object['payment_status'] === 'paid' || type.endsWith('succeeded')) {
            next = 'paid';
            set = {
              confirmedByWebhook: true,
              paidAt: new Date(),
              failureReason: null,
              ...(paymentIntent === undefined ? {} : { providerPaymentId: paymentIntent }),
            };
          } else if (paymentIntent !== undefined) {
            // Completed but settling later (bank debits): remember the intent.
            set = { providerPaymentId: paymentIntent };
          }
          break;
        case 'checkout.session.async_payment_failed':
          lookup = {
            paymentId: asString(metadata['paymentId']),
            sessionId: asString(object['id']),
          };
          next = 'failed';
          set = { failureReason: 'The bank declined the delayed payment.' };
          break;
        case 'checkout.session.expired':
          lookup = {
            paymentId: asString(metadata['paymentId']),
            sessionId: asString(object['id']),
          };
          next = 'expired';
          set = { failureReason: 'The payment link expired before the customer paid.' };
          break;
        case 'payment_intent.payment_failed': {
          lookup = {
            paymentId: asString(metadata['paymentId']),
            paymentIntent: asString(object['id']),
          };
          next = 'failed';
          const lastError = asRecord(object['last_payment_error']);
          set = {
            providerPaymentId: asString(object['id']),
            failureReason: asString(lastError['message']) ?? 'The payment was declined.',
          };
          break;
        }
        case 'charge.refunded': {
          lookup = { paymentIntent, paymentId: asString(metadata['paymentId']) };
          const refunded =
            typeof object['amount_refunded'] === 'number' ? object['amount_refunded'] : 0;
          const amount = typeof object['amount'] === 'number' ? object['amount'] : 0;
          // A refund proves the charge succeeded, even if its own event is late.
          set = { refundedAmount: refunded, confirmedByWebhook: true };
          // A partial refund keeps the payment paid, with less collected.
          next = refunded >= amount ? 'refunded' : 'paid';
          break;
        }
        default:
          outcome = 'ignored';
          return;
      }

      const payment = await findPayment(workspaceId, lookup, session);
      if (payment === null) {
        outcome = 'ignored';
        return;
      }

      const statusChange =
        next !== null && next !== payment.status && ALLOWED_FROM[next].includes(payment.status);
      // A late event for an earlier state never moves the status backwards; only
      // a refund still updates the refunded amount.
      if (next !== null && next !== payment.status && !statusChange && type !== 'charge.refunded') {
        outcome = 'ignored';
        return;
      }
      if (payment.paidAt !== null) delete set['paidAt'];
      else if (type === 'charge.refunded') set['paidAt'] = new Date();

      await PaymentModel.updateOne(
        { _id: payment._id, workspaceId },
        { $set: { ...set, ...(statusChange ? { status: next } : {}) }, $inc: { version: 1 } },
        { session },
      );

      if (statusChange && (next === 'paid' || next === 'refunded')) {
        await recordActivity(
          {
            workspaceId,
            type: next === 'paid' ? 'payment.received' : 'payment.refunded',
            targetKind: 'opportunity',
            targetId: payment.opportunityId,
            contactId: payment.contactId,
            actor: { label: 'Stripe' },
            summary:
              next === 'paid'
                ? `Payment of ${formatMoney(payment.amount, payment.currency)} received`
                : `Payment of ${formatMoney(payment.amount, payment.currency)} refunded`,
            payload: { paymentId: payment._id.toString(), eventId },
          },
          session,
        );
      }

      await appendOutbox(
        workspaceId,
        'payment.updated',
        { paymentId: payment._id.toString(), opportunityId: payment.opportunityId.toString() },
        payment.requestedByMembershipId,
        session,
      );
      outcome = 'applied';
    });
    return outcome;
  } finally {
    await session.endSession();
  }
}

// ---------------------------------------------------------------------------
// Collected versus projected (I2.6)
// ---------------------------------------------------------------------------

export function paymentRecordOf(payment: PaymentDoc): PaymentRecord {
  return {
    status: payment.status,
    amount: payment.amount,
    currency: payment.currency,
    confirmedByWebhook: payment.confirmedByWebhook,
    refundedAmount: payment.refundedAmount,
  };
}

export async function paymentSummary(auth: AuthContext) {
  const settings = await settingsFor(auth.workspaceId);
  const currency = settings.currency;
  const [payments, opportunities] = await Promise.all([
    PaymentModel.find({ workspaceId: auth.workspaceId, currency }).lean(),
    OpportunityModel.find({ workspaceId: auth.workspaceId, stageOutcome: 'open', currency })
      .select('stageId stageOutcome value currency')
      .lean(),
  ]);
  const forPipeline: OpportunityForPipeline[] = opportunities.map((opportunity) => ({
    stageId: opportunity.stageId,
    stageOutcome: opportunity.stageOutcome,
    value: opportunity.value ?? 0,
    currency: opportunity.currency ?? currency,
  }));
  const records = payments.map(paymentRecordOf);

  return {
    currency,
    collected: collectedRevenue(records, { currency }),
    projected: projectedRevenue(forPipeline, records, { currency }),
  };
}

export function assertPositiveAmount(amount: number): void {
  if (!Number.isInteger(amount) || amount < 50) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'The amount is too small.', {
      details: { fields: { amount: 'must be at least 50 minor units (0.50)' } },
    });
  }
}
