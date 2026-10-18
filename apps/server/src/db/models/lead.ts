import { ASSIGNMENT_STATUSES, type AssignmentStatus, type EscalationTarget } from '@ubmp/domain';
import { model, Schema, type Types } from 'mongoose';

/**
 * A lead: an inbound enquiry that must never be left without an accountable
 * owner (F3.1 - F3.8).
 *
 * The assignment state is stored flat on the lead rather than in a child
 * collection, so one conditional update can move ownership, the escalation
 * level and the version together. That atomicity is what makes "a lead is never
 * owned by two people at once" true (F3.8).
 */
export const LEAD_SOURCES = ['web_form', 'messaging', 'manual', 'import'] as const;
export type LeadSource = (typeof LEAD_SOURCES)[number];

export const LEAD_STATUSES = ['open', 'converted', 'closed'] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

export interface LeadDoc {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  contactId: Types.ObjectId | null;
  source: LeadSource;
  /** Which public form, or who entered it. Shown on the lead (F3.1). */
  sourceLabel: string;
  status: LeadStatus;

  assigneeMembershipId: Types.ObjectId | null;
  /** Section 7 "assigned time": when the system LAST assigned this lead. */
  assignedAt: Date | null;
  /**
   * Section 7 measures time to first response from the FIRST assignment, which
   * is a different field; escalation must not flatter the figure.
   */
  firstAssignedAt: Date | null;
  acknowledgedAt: Date | null;
  /** The first acknowledgement ever, for time to first response (Section 7). */
  firstAcknowledgedAt: Date | null;

  /** The escalation state machine's state, from packages/domain. */
  assignmentStatus: AssignmentStatus;
  escalationLevel: number;
  escalationTarget: EscalationTarget;
  /** When the current level's acknowledgement window began. */
  windowStartedAt: Date | null;
  /** Automatic escalations only; manual reassignments are counted separately. */
  escalationCount: number;
  /** Everyone who has already held it, so escalation never loops back. */
  previousAssigneeMembershipIds: Types.ObjectId[];

  /** Last note, message, call log, stage change or appointment (Section 7). */
  lastActivityAt: Date | null;
  /** True while the owner is away but the lead is already acknowledged (F3.6). */
  ownerUnavailable: boolean;

  /**
   * Incremented on every ownership change. An escalation job carries the
   * version it was scheduled for, so a job for a superseded state is a no-op.
   */
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

const leadSchema = new Schema<LeadDoc>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true },
    contactId: { type: Schema.Types.ObjectId, ref: 'Contact', default: null },
    source: { type: String, required: true, enum: LEAD_SOURCES },
    sourceLabel: { type: String, required: true, maxlength: 200 },
    status: { type: String, required: true, enum: LEAD_STATUSES, default: 'open' },

    assigneeMembershipId: { type: Schema.Types.ObjectId, ref: 'Membership', default: null },
    assignedAt: { type: Date, default: null },
    firstAssignedAt: { type: Date, default: null },
    acknowledgedAt: { type: Date, default: null },
    firstAcknowledgedAt: { type: Date, default: null },

    assignmentStatus: {
      type: String,
      required: true,
      enum: ASSIGNMENT_STATUSES,
      default: 'pending_ack',
    },
    escalationLevel: { type: Number, required: true, default: 0, min: 0 },
    escalationTarget: { type: String, required: true, default: 'assignee' },
    windowStartedAt: { type: Date, default: null },
    escalationCount: { type: Number, required: true, default: 0, min: 0 },
    previousAssigneeMembershipIds: { type: [Schema.Types.ObjectId], default: [] },

    lastActivityAt: { type: Date, default: null },
    ownerUnavailable: { type: Boolean, default: false },

    version: { type: Number, required: true, default: 0 },
  },
  { timestamps: true },
);

// The inbox: one employee's open leads.
leadSchema.index({ workspaceId: 1, assigneeMembershipId: 1, status: 1 });
// The recovery queue's three grounds (F3.7).
leadSchema.index({ workspaceId: 1, assignmentStatus: 1, windowStartedAt: 1 });
leadSchema.index({ workspaceId: 1, escalationCount: -1 });
leadSchema.index({ workspaceId: 1, lastActivityAt: 1 });
// "New leads today" on the dashboard (F5.1).
leadSchema.index({ workspaceId: 1, createdAt: -1 });

export const LeadModel = model<LeadDoc>('Lead', leadSchema);
