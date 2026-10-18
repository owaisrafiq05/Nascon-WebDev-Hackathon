import { model, Schema, type Types } from 'mongoose';

/**
 * One workspace's connection to one provider (I5.1, I5.2).
 *
 * Credentials are per workspace and encrypted at rest; `publicConfig` holds the
 * non-secret settings the interface may show in full (a sender number, a bot
 * username). `webhookKey` is the unguessable path segment providers call back
 * on, which is how an inbound webhook finds its workspace without trusting
 * anything in the body. The signature is still verified on every request.
 *
 * Google Calendar is not here: it is connected per employee, in
 * `calendar_connections`.
 */
export const WORKSPACE_PROVIDERS = ['twilio', 'stripe', 'telegram'] as const;
export type WorkspaceProvider = (typeof WORKSPACE_PROVIDERS)[number];

export const INTEGRATION_STATUSES = ['connected', 'error', 'disconnected'] as const;
export type IntegrationStatus = (typeof INTEGRATION_STATUSES)[number];

export interface IntegrationDoc {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  provider: WorkspaceProvider;
  status: IntegrationStatus;
  /** Encrypted values, keyed by credential name. Never returned to a browser. */
  secrets: Record<string, string>;
  /** Last four characters of each secret, the only form the interface shows. */
  secretHints: Record<string, string>;
  publicConfig: Record<string, string>;
  webhookKey: string;
  lastSuccessAt: Date | null;
  lastErrorAt: Date | null;
  lastError: string | null;
  connectedByMembershipId: Types.ObjectId | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

const integrationSchema = new Schema<IntegrationDoc>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true },
    provider: { type: String, required: true, enum: WORKSPACE_PROVIDERS },
    status: { type: String, required: true, enum: INTEGRATION_STATUSES, default: 'connected' },
    secrets: { type: Schema.Types.Mixed, default: () => ({}) },
    secretHints: { type: Schema.Types.Mixed, default: () => ({}) },
    publicConfig: { type: Schema.Types.Mixed, default: () => ({}) },
    webhookKey: { type: String, required: true, unique: true, maxlength: 64 },
    lastSuccessAt: { type: Date, default: null },
    lastErrorAt: { type: Date, default: null },
    lastError: { type: String, default: null, maxlength: 1_000 },
    connectedByMembershipId: { type: Schema.Types.ObjectId, ref: 'Membership', default: null },
    version: { type: Number, required: true, default: 0 },
  },
  { timestamps: true, minimize: false },
);

integrationSchema.index({ workspaceId: 1, provider: 1 }, { unique: true });

export const IntegrationModel = model<IntegrationDoc>('Integration', integrationSchema);
