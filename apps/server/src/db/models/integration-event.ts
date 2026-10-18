import { model, Schema, type Types } from 'mongoose';

/**
 * The synchronization history (I5.4): every inbound webhook and every outbound
 * provider call, with time, result and a reference.
 *
 * `providerEventId` carries a unique index per provider, which is what makes
 * webhook processing idempotent (I1.8, I2.4): the second delivery of an event
 * fails to insert and is recorded as a duplicate instead of being processed.
 */
export const INTEGRATION_PROVIDERS = ['twilio', 'stripe', 'google', 'telegram'] as const;
export type IntegrationProvider = (typeof INTEGRATION_PROVIDERS)[number];

export const EVENT_DIRECTIONS = ['inbound', 'outbound'] as const;
export const EVENT_RESULTS = ['ok', 'error', 'rejected', 'duplicate', 'ignored'] as const;
export type IntegrationEventResult = (typeof EVENT_RESULTS)[number];

export interface IntegrationEventDoc {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId | null;
  provider: IntegrationProvider;
  direction: (typeof EVENT_DIRECTIONS)[number];
  kind: string;
  result: IntegrationEventResult;
  /** The provider's id for the thing (message SID, checkout session, event id). */
  reference: string | null;
  providerEventId: string | null;
  httpStatus: number | null;
  error: string | null;
  /** Whether a failure was temporary (retried) or permanent (shown). */
  transient: boolean | null;
  createdAt: Date;
}

const integrationEventSchema = new Schema<IntegrationEventDoc>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', default: null },
    provider: { type: String, required: true, enum: INTEGRATION_PROVIDERS },
    direction: { type: String, required: true, enum: EVENT_DIRECTIONS },
    kind: { type: String, required: true, maxlength: 100 },
    result: { type: String, required: true, enum: EVENT_RESULTS },
    reference: { type: String, default: null, maxlength: 200 },
    providerEventId: { type: String, default: null, maxlength: 200 },
    httpStatus: { type: Number, default: null },
    error: { type: String, default: null, maxlength: 1_000 },
    transient: { type: Boolean, default: null },
    createdAt: { type: Date, required: true, default: () => new Date() },
  },
  { timestamps: false },
);

integrationEventSchema.index({ workspaceId: 1, createdAt: -1 });
integrationEventSchema.index({ workspaceId: 1, provider: 1, createdAt: -1 });
// Idempotency: one processed row per provider event.
integrationEventSchema.index(
  { provider: 1, providerEventId: 1 },
  { unique: true, partialFilterExpression: { providerEventId: { $type: 'string' } } },
);

export const IntegrationEventModel = model<IntegrationEventDoc>(
  'IntegrationEvent',
  integrationEventSchema,
);
