import { randomUUID } from 'node:crypto';

import type { ClientSession, Types } from 'mongoose';

import {
  ScheduledJobModel,
  type JobType,
  type ScheduledJobDoc,
} from '../db/models/scheduled-job.js';

/**
 * Scheduling and claiming persisted jobs (Q5, F3.8).
 *
 * The claim is the whole point of this module, so it is the only place that
 * touches `lockedUntil`.
 */

export interface ScheduleJobInput {
  readonly workspaceId: Types.ObjectId;
  readonly type: JobType;
  readonly targetId: Types.ObjectId;
  readonly runAt: Date;
  readonly idempotencyKey: string;
  readonly payload?: Record<string, unknown> | undefined;
}

/**
 * Schedules a job, or does nothing if one with the same key already exists.
 *
 * The duplicate is swallowed rather than reported: two requests racing to
 * schedule the same escalation is a benign race, and the outcome a caller wants
 * ("a job exists for this") is true either way.
 */
export async function scheduleJob(
  input: ScheduleJobInput,
  session?: ClientSession,
): Promise<{ scheduled: boolean }> {
  try {
    await ScheduledJobModel.create(
      [
        {
          workspaceId: input.workspaceId,
          type: input.type,
          targetId: input.targetId,
          payload: input.payload ?? {},
          runAt: input.runAt,
          status: 'pending',
          idempotencyKey: input.idempotencyKey,
        },
      ],
      session === undefined ? {} : { session, ordered: true },
    );

    return { scheduled: true };
  } catch (error) {
    // 11000 is a unique-index violation: the job is already scheduled.
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 11000) {
      return { scheduled: false };
    }
    throw error;
  }
}

/**
 * The idempotency key for an escalation (F3.8).
 *
 * It includes the assignment version, so a *legitimate* next escalation after a
 * real ownership change gets its own key, while a duplicate schedule for the
 * same state collides and is dropped.
 */
export function escalationKey(
  leadId: Types.ObjectId | string,
  assignmentVersion: number,
  level: number,
): string {
  return `lead.escalate:${String(leadId)}:v${String(assignmentVersion)}:l${String(level)}`;
}

/** How long a claimer holds a job before another may take it over. */
export const DEFAULT_LEASE_MS = 30_000;

export interface ClaimOptions {
  readonly types?: readonly JobType[] | undefined;
  readonly now?: Date | undefined;
  readonly leaseMs?: number | undefined;
  /** Identifies the claimer in the row, for diagnosis. */
  readonly claimerId?: string | undefined;
}

/**
 * Claims one due job, atomically.
 *
 * `findOneAndUpdate` is a single document operation, so of two workers issuing
 * it at the same moment exactly one matches and updates; the other sees the
 * already-locked document and matches nothing. That is what makes "only one
 * executes" true without a distributed lock.
 *
 * A job whose claimer died is matched again once `lockedUntil` is in the past,
 * which is how an interrupted escalation still completes.
 */
export async function claimDueJob(options: ClaimOptions = {}): Promise<ScheduledJobDoc | null> {
  const now = options.now ?? new Date();
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const claimerId = options.claimerId ?? randomUUID();

  return ScheduledJobModel.findOneAndUpdate(
    {
      status: { $in: ['pending', 'running'] },
      runAt: { $lte: now },
      // Free, or the previous claimer's lease has expired.
      $or: [{ lockedUntil: null }, { lockedUntil: { $lte: now } }],
      ...(options.types === undefined ? {} : { type: { $in: [...options.types] } }),
    },
    {
      $set: {
        status: 'running',
        lockedUntil: new Date(now.getTime() + leaseMs),
        lockedBy: claimerId,
      },
      $inc: { attempts: 1 },
    },
    // Oldest first, so a job is not starved by newer ones.
    { sort: { runAt: 1 }, new: true },
  ).lean();
}

export async function completeJob(jobId: Types.ObjectId): Promise<void> {
  await ScheduledJobModel.updateOne(
    { _id: jobId },
    { $set: { status: 'done', lockedUntil: null, lockedBy: null } },
  );
}

/**
 * Records a failure and releases the lease so the job is retried.
 *
 * After `maxAttempts` it is marked failed and left alone, so a job that fails
 * for a permanent reason does not spin for ever; an Admin sees it in the
 * integrations or jobs view.
 */
export async function failJob(
  jobId: Types.ObjectId,
  error: unknown,
  options: { maxAttempts?: number; retryDelayMs?: number } = {},
): Promise<void> {
  const maxAttempts = options.maxAttempts ?? 5;
  const retryDelayMs = options.retryDelayMs ?? 10_000;
  const message = error instanceof Error ? error.message : String(error);

  const job = await ScheduledJobModel.findById(jobId).select('attempts').lean();
  const attempts = job?.attempts ?? maxAttempts;

  if (attempts >= maxAttempts) {
    await ScheduledJobModel.updateOne(
      { _id: jobId },
      { $set: { status: 'failed', lockedUntil: null, lockedBy: null, lastError: message } },
    );
    return;
  }

  await ScheduledJobModel.updateOne(
    { _id: jobId },
    {
      $set: {
        status: 'pending',
        lockedUntil: null,
        lockedBy: null,
        lastError: message,
        runAt: new Date(Date.now() + retryDelayMs),
      },
    },
  );
}

/** Cancels outstanding jobs for a target, e.g. once a lead is acknowledged. */
export async function cancelJobsFor(
  targetId: Types.ObjectId,
  session?: ClientSession,
): Promise<number> {
  const result = await ScheduledJobModel.updateMany(
    { targetId, status: { $in: ['pending', 'running'] } },
    { $set: { status: 'cancelled', lockedUntil: null, lockedBy: null } },
    session === undefined ? {} : { session },
  );

  return result.modifiedCount;
}
