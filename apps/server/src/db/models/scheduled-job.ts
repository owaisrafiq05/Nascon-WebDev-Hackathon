import { model, Schema, type Types } from 'mongoose';

/**
 * A persisted timer (Q5, F3.8).
 *
 * Business timers live here rather than in an in-memory `setTimeout`, so an
 * escalation still happens after the process that scheduled it has restarted.
 *
 * Two properties make it exactly-once:
 *
 *   - **The lease.** A claimer takes a job with one atomic `findOneAndUpdate`
 *     matching `runAt <= now` AND (`lockedUntil` absent or past). Only one
 *     writer can win that update, so two workers cannot run the same job
 *     concurrently. A crashed claimer's lease simply expires and another
 *     claimer picks it up.
 *   - **The idempotency key.** Unique per (lead, assignment version, level), so
 *     scheduling the same escalation twice inserts once. A duplicate schedule
 *     therefore cannot double-escalate.
 */
export const JOB_TYPES = ['lead.escalate', 'lead.recovery_sweep'] as const;
export type JobType = (typeof JOB_TYPES)[number];

export const JOB_STATUSES = ['pending', 'running', 'done', 'failed', 'cancelled'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export interface ScheduledJobDoc {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  type: JobType;
  targetId: Types.ObjectId;
  /** Everything the handler needs, so it does not re-derive from the schedule. */
  payload: Record<string, unknown>;

  runAt: Date;
  status: JobStatus;
  /** Held by whichever claimer took it. Expiry is what survives a crash. */
  lockedUntil: Date | null;
  lockedBy: string | null;
  attempts: number;
  lastError: string | null;

  /** Unique: the same logical job cannot be scheduled twice. */
  idempotencyKey: string;

  createdAt: Date;
  updatedAt: Date;
}

const scheduledJobSchema = new Schema<ScheduledJobDoc>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true },
    type: { type: String, required: true, enum: JOB_TYPES },
    targetId: { type: Schema.Types.ObjectId, required: true },
    payload: { type: Schema.Types.Mixed, default: () => ({}) },

    runAt: { type: Date, required: true },
    status: { type: String, required: true, enum: JOB_STATUSES, default: 'pending' },
    lockedUntil: { type: Date, default: null },
    lockedBy: { type: String, default: null, maxlength: 128 },
    attempts: { type: Number, required: true, default: 0, min: 0 },
    lastError: { type: String, default: null, maxlength: 1_000 },

    idempotencyKey: { type: String, required: true, unique: true, maxlength: 256 },
  },
  { timestamps: true, minimize: false },
);

// The claim query: due, not locked, pending. Led by status so the index stays
// small as completed jobs accumulate.
scheduledJobSchema.index({ status: 1, runAt: 1, lockedUntil: 1 });
scheduledJobSchema.index({ workspaceId: 1, targetId: 1 });

export const ScheduledJobModel = model<ScheduledJobDoc>('ScheduledJob', scheduledJobSchema);
