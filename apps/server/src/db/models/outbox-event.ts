import { model, Schema, type Types } from 'mongoose';

/**
 * The realtime outbox (P4 writes, P5 relays).
 *
 * The worker cannot emit to a browser: it holds no Socket.IO server. It appends
 * here instead, inside the same transaction as the change, and the API process
 * relays unsent rows to the sockets in the right workspace room.
 *
 * Writing the event with the change is what stops a "lead escalated" event from
 * being emitted for an escalation that rolled back, and stops an escalation
 * from committing with no one told.
 */
export const OUTBOX_EVENT_TYPES = [
  'lead.created',
  'lead.assigned',
  'lead.escalated',
  'lead.acknowledged',
  'message.received',
  'payment.updated',
  'message.updated',
  'appointment.updated',
  'integration.updated',
  'availability.changed',
] as const;

export type OutboxEventType = (typeof OUTBOX_EVENT_TYPES)[number];

export interface OutboxEventDoc {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  type: OutboxEventType;
  /**
   * Deliberately minimal: ids and nothing a reader might not be permitted to
   * see. The browser refetches through a permission-checked endpoint, so the
   * socket never becomes a way around `requirePermission`.
   */
  payload: Record<string, unknown>;
  /** The member this concerns, for the `user:{id}` room. */
  membershipId: Types.ObjectId | null;
  deliveredAt: Date | null;
  /** The relay's lease, so two API processes never emit the same row at once. */
  claimedUntil: Date | null;
  createdAt: Date;
}

const outboxEventSchema = new Schema<OutboxEventDoc>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true },
    type: { type: String, required: true, enum: OUTBOX_EVENT_TYPES },
    payload: { type: Schema.Types.Mixed, default: () => ({}) },
    membershipId: { type: Schema.Types.ObjectId, ref: 'Membership', default: null },
    deliveredAt: { type: Date, default: null },
    claimedUntil: { type: Date, default: null },
    createdAt: { type: Date, required: true, default: () => new Date() },
  },
  { timestamps: false, minimize: false },
);

// The relay's query: undelivered, oldest first.
outboxEventSchema.index({ deliveredAt: 1, createdAt: 1 });

export const OutboxEventModel = model<OutboxEventDoc>('OutboxEvent', outboxEventSchema);
