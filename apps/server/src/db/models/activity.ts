import { model, Schema, type Types } from 'mongoose';

/**
 * The activity history shown on a contact and on an opportunity (F2.7).
 *
 * Distinct from the audit log, and deliberately so:
 *
 *   - **Activity** is the customer's story. It is scoped to one record, read by
 *     anyone who may see that record, and answers "what has happened with this
 *     customer": notes, stage changes, assignments, field edits, messages,
 *     payments, appointments.
 *   - **Audit** is the compliance trail (F4.1). It is workspace-wide, needs its
 *     own permission, is append-only at three levels, and answers "who changed
 *     the configuration".
 *
 * They overlap (a stage change is both) but have different readers, retention
 * and permissions, so merging them would mean either leaking configuration
 * changes to every user or hiding the customer timeline behind an audit
 * permission.
 */
export const ACTIVITY_TYPES = [
  'contact.created',
  'contact.updated',
  'contact.deleted',
  'company.created',
  'company.updated',
  'company.deleted',
  'opportunity.created',
  'opportunity.updated',
  'opportunity.deleted',
  'opportunity.stage_changed',
  'opportunity.assigned',
  'note.added',
  // Written by later phases, declared now so the type is not reshaped later.
  'message.sent',
  'message.received',
  'payment.requested',
  'payment.received',
  'payment.refunded',
  'appointment.booked',
  'appointment.rescheduled',
  'appointment.cancelled',
  'lead.assigned',
  'lead.acknowledged',
  'lead.escalated',
] as const;

export type ActivityType = (typeof ACTIVITY_TYPES)[number];

/** Which record's timeline this belongs to. */
export const ACTIVITY_TARGETS = ['contact', 'company', 'opportunity'] as const;
export type ActivityTarget = (typeof ACTIVITY_TARGETS)[number];

export interface ActivityDoc {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  type: ActivityType;
  targetKind: ActivityTarget;
  targetId: Types.ObjectId;
  /**
   * A contact's timeline includes its opportunities' activity, so an entry
   * about an opportunity also carries its contact. That makes the contact
   * timeline one indexed query rather than a fan-out (F2.8).
   */
  contactId: Types.ObjectId | null;
  /** `null` for an entry the system raised, such as an escalation. */
  actorMembershipId: Types.ObjectId | null;
  actorUserId: Types.ObjectId | null;
  /** Readable at the time, so the timeline survives a rename. */
  actorLabel: string;
  /** One line, already written for a person to read. */
  summary: string;
  /** Structured detail: changed fields, amounts, stage names. */
  payload: Record<string, unknown>;
  createdAt: Date;
}

const activitySchema = new Schema<ActivityDoc>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true },
    type: { type: String, required: true, enum: ACTIVITY_TYPES },
    targetKind: { type: String, required: true, enum: ACTIVITY_TARGETS },
    targetId: { type: Schema.Types.ObjectId, required: true },
    contactId: { type: Schema.Types.ObjectId, ref: 'Contact', default: null },
    actorMembershipId: { type: Schema.Types.ObjectId, ref: 'Membership', default: null },
    actorUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    actorLabel: { type: String, required: true, maxlength: 320 },
    summary: { type: String, required: true, maxlength: 500 },
    payload: { type: Schema.Types.Mixed, default: () => ({}) },
    // `createdAt` only: an activity entry describes a moment and never moves.
    createdAt: { type: Date, required: true, default: () => new Date() },
  },
  { timestamps: false },
);

// The timeline query: one record, newest first (F2.7).
activitySchema.index({ workspaceId: 1, targetKind: 1, targetId: 1, createdAt: -1 });
// The contact's complete view, including its opportunities (F2.8).
activitySchema.index({ workspaceId: 1, contactId: 1, createdAt: -1 });

export const ActivityModel = model<ActivityDoc>('Activity', activitySchema);
