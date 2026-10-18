import { recoveryQueueMembership, type RecoveryReason } from '@ubmp/domain';
import type { Types } from 'mongoose';

import { LeadModel } from '../db/models/lead.js';
import { assignmentStateOf, escalationConfigFrom, settingsFor } from './lead-service.js';

/**
 * The recovery queue (F3.7): leads unacknowledged beyond their window,
 * escalated two or more times, or untouched for the configured idle period.
 *
 * Membership is decided by the domain's `recoveryQueueMembership`, the same
 * function the dashboard count uses, so the page and the figure can never
 * disagree (Q12).
 *
 * Candidates are narrowed in the database first — only open leads — and then
 * judged in memory, because the three grounds combine in a way no single index
 * can express, and the set of open leads is small by definition.
 */
export interface RecoveryItem {
  readonly leadId: string;
  readonly reasons: readonly RecoveryReason[];
  readonly sourceLabel: string;
  readonly assigneeMembershipId: string | null;
  readonly escalationCount: number;
  readonly createdAt: string;
  readonly lastActivityAt: string | null;
}

export async function recoveryQueueFor(
  workspaceId: Types.ObjectId,
  now: Date = new Date(),
): Promise<readonly RecoveryItem[]> {
  const settings = await settingsFor(workspaceId);
  const escalation = escalationConfigFrom(settings);

  const open = await LeadModel.find({ workspaceId, status: 'open' }).sort({ createdAt: 1 }).lean();

  const items: RecoveryItem[] = [];

  for (const lead of open) {
    const membership = recoveryQueueMembership(
      {
        leadId: lead._id.toString(),
        state: assignmentStateOf(lead),
        createdAt: lead.createdAt.getTime(),
        lastRecordedActionAt: lead.lastActivityAt?.getTime() ?? null,
      },
      now.getTime(),
      {
        escalation,
        recovery: {
          minEscalations: settings.recoveryMinEscalations,
          idlePeriodMs: settings.idleRecoveryMinutes * 60 * 1_000,
        },
      },
    );

    if (!membership.inQueue) continue;

    items.push({
      leadId: lead._id.toString(),
      reasons: membership.reasons,
      sourceLabel: lead.sourceLabel,
      assigneeMembershipId: lead.assigneeMembershipId?.toString() ?? null,
      escalationCount: lead.escalationCount,
      createdAt: lead.createdAt.toISOString(),
      lastActivityAt: lead.lastActivityAt?.toISOString() ?? null,
    });
  }

  return items;
}

/** The words shown beside each item, so the reason is never a bare code (F3.7). */
export const RECOVERY_REASON_LABELS: Record<RecoveryReason, string> = {
  unacknowledged_beyond_window: 'Not acknowledged within its window',
  escalated_repeatedly: 'Escalated more than once',
  idle_too_long: 'No recorded action for too long',
};
