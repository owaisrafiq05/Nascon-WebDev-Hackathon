import { PAYMENT_STATUSES, type PaymentStatus } from '@ubmp/domain';
import { model, Schema, type Types } from 'mongoose';

/**
 * A payment request and its outcome (I2.1 - I2.7).
 *
 * Amounts are integer minor units, like every money figure in the domain.
 * `confirmedByWebhook` is set only by a verified provider webhook, never by a
 * redirect or a button, so collected revenue counts only what the provider
 * confirmed (I2.6, Section 7). No card data exists here by construction:
 * details are entered on Stripe's hosted page only (I2.8).
 */
export interface PaymentDoc {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  opportunityId: Types.ObjectId;
  contactId: Types.ObjectId | null;
  requestedByMembershipId: Types.ObjectId;
  amount: number;
  currency: string;
  description: string;
  status: PaymentStatus;
  confirmedByWebhook: boolean;
  refundedAmount: number;
  /** Stripe Checkout Session id. */
  providerReference: string | null;
  /** Stripe PaymentIntent id, once known. */
  providerPaymentId: string | null;
  checkoutUrl: string | null;
  failureReason: string | null;
  paidAt: Date | null;
  expiresAt: Date | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

const paymentSchema = new Schema<PaymentDoc>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true },
    opportunityId: { type: Schema.Types.ObjectId, ref: 'Opportunity', required: true },
    contactId: { type: Schema.Types.ObjectId, ref: 'Contact', default: null },
    requestedByMembershipId: { type: Schema.Types.ObjectId, ref: 'Membership', required: true },
    amount: { type: Number, required: true, min: 1 },
    currency: { type: String, required: true, uppercase: true, minlength: 3, maxlength: 3 },
    description: { type: String, default: '', maxlength: 200 },
    status: { type: String, required: true, enum: PAYMENT_STATUSES, default: 'pending' },
    confirmedByWebhook: { type: Boolean, default: false },
    refundedAmount: { type: Number, default: 0, min: 0 },
    providerReference: { type: String, default: null, maxlength: 255 },
    providerPaymentId: { type: String, default: null, maxlength: 255 },
    checkoutUrl: { type: String, default: null, maxlength: 2_000 },
    failureReason: { type: String, default: null, maxlength: 500 },
    paidAt: { type: Date, default: null },
    expiresAt: { type: Date, default: null },
    version: { type: Number, required: true, default: 0 },
  },
  { timestamps: true },
);

paymentSchema.index({ workspaceId: 1, opportunityId: 1, createdAt: -1 });
paymentSchema.index({ workspaceId: 1, contactId: 1, createdAt: -1 });
paymentSchema.index({ workspaceId: 1, status: 1, paidAt: -1 });
paymentSchema.index({ providerReference: 1 });
paymentSchema.index({ providerPaymentId: 1 });

export const PaymentModel = model<PaymentDoc>('Payment', paymentSchema);
