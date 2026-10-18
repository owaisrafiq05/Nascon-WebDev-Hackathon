import { randomUUID } from 'node:crypto';

import type { Types } from 'mongoose';

import type { ScheduledJobDoc } from '../db/models/scheduled-job.js';
import { claimDueJob, completeJob, failJob, type ClaimOptions } from '../repositories/job-queue.js';
import { escalateLead, type EscalationOutcome } from './lead-service.js';

/**
 * Runs due scheduled jobs (Q5, F3.8).
 *
 * Lives in the server package rather than the worker so the escalation path can
 * be tested directly, including the two-claimer and crash-recovery cases, with
 * no second process to coordinate.
 */
export interface RunJobResult {
  readonly jobId: string;
  readonly type: ScheduledJobDoc['type'];
  readonly outcome: EscalationOutcome | { readonly handled: false };
}

function assignmentVersionOf(job: ScheduledJobDoc): number {
  const raw = job.payload['assignmentVersion'];
  return typeof raw === 'number' ? raw : 0;
}

/**
 * Executes one job.
 *
 * A failure releases the lease and schedules a retry rather than losing the
 * timer, because a lost escalation is the failure this phase exists to prevent.
 */
export async function runJob(job: ScheduledJobDoc, now: Date = new Date()): Promise<RunJobResult> {
  try {
    if (job.type === 'lead.escalate') {
      const outcome = await escalateLead(job.targetId, assignmentVersionOf(job), now);

      // Done either way: a job that found nothing to do has still had its turn,
      // and re-running it would reach the same conclusion.
      await completeJob(job._id);
      return { jobId: job._id.toString(), type: job.type, outcome };
    }

    await completeJob(job._id);
    return { jobId: job._id.toString(), type: job.type, outcome: { handled: false } };
  } catch (error) {
    await failJob(job._id, error);
    throw error;
  }
}

/**
 * Claims and runs one due job, or returns `null` when none is due.
 *
 * The claim is atomic, so two callers racing here cannot both get the same job:
 * one wins the `findOneAndUpdate`, the other sees it locked and moves on.
 */
export async function claimAndRunOne(options: ClaimOptions = {}): Promise<RunJobResult | null> {
  const job = await claimDueJob({ claimerId: options.claimerId ?? randomUUID(), ...options });
  if (job === null) return null;

  return runJob(job, options.now ?? new Date());
}

/** Drains the queue, bounded so a tick cannot run for ever. */
export async function runDueJobs(
  options: ClaimOptions & { maxJobs?: number } = {},
): Promise<readonly RunJobResult[]> {
  const maxJobs = options.maxJobs ?? 50;
  const results: RunJobResult[] = [];

  for (let index = 0; index < maxJobs; index += 1) {
    const result = await claimAndRunOne(options);
    if (result === null) break;
    results.push(result);
  }

  return results;
}

export type { Types };
