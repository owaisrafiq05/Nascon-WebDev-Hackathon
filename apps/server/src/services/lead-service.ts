import {
  assignLead,
  AUDIT_EVENT_TYPES,
  isAbsent,
  nextEscalation,
  type AssignmentCandidate,
  type AssignmentState,
  type AvailabilityStatus,
  type EscalationConfig,
  type UnassignableReason,
} from '@ubmp/domain';
import { conflict, notFound } from '@ubmp/shared';
import mongoose, { type ClientSession, Types } from 'mongoose';

import { ContactModel, contactDisplayName } from '../db/models/contact.js';
import { LeadModel, type LeadDoc, type LeadSource } from '../db/models/lead.js';
import { MembershipModel } from '../db/models/membership.js';
import { UserModel } from '../db/models/user.js';
import {
  DEFAULT_ESCALATION_LEVELS,
  WorkspaceSettingsModel,
  type WorkspaceSettingsDoc,
} from '../db/models/workspace-settings.js';
import { recordActivity } from '../repositories/activity-repository.js';
import { appendAuditEvent } from '../repositories/audit-repository.js';
import { appendOutbox } from '../repositories/outbox.js';
import { cancelJobsFor, escalationKey, scheduleJob } from '../repositories/job-queue.js';
import type { Actor } from './crm-service.js';
import type { AuthContext } from './session-service.js';

/**
 * Lead capture, assignment, acknowledgement and escalation (F3.1 - F3.9).
 *
 * The rules all come from `packages/domain`; this module's job is to load the
 * inputs, persist the decision and schedule the next timer. It never decides
 * who gets a lead or when a window expires.
 *
 * **Every ownership change is a conditional update on `version`.** That is what
 * makes "a lead is never owned by two people at once" true: two writers racing
 * to escalate the same lead both read version N, both attempt the update, and
 * exactly one matches. The loser sees `matchedCount === 0` and stops.
 */

export async function settingsFor(
  workspaceId: Types.ObjectId,
  session?: ClientSession,
): Promise<WorkspaceSettingsDoc> {
  const existing = await WorkspaceSettingsModel.findOne({ workspaceId })
    .session(session ?? null)
    .lean();
  if (existing !== null) return existing;

  // Created on first use rather than at sign-up, so a workspace made before
  // this phase still works.
  const [created] = await WorkspaceSettingsModel.create(
    [{ workspaceId, escalationLevels: DEFAULT_ESCALATION_LEVELS }],
    session === undefined ? {} : { session, ordered: true },
  );
  if (created === undefined) throw new Error('settings were not created');

  return created.toObject();
}

/** The domain's escalation config, built from the workspace's settings. */
export function escalationConfigFrom(settings: WorkspaceSettingsDoc): EscalationConfig {
  return {
    levels: [
      {
        target: 'assignee',
        acknowledgementWindowMs: settings.acknowledgementWindowSeconds * 1_000,
      },
      ...settings.escalationLevels.map((level) => ({
        target: level.target,
        acknowledgementWindowMs: level.windowSeconds * 1_000,
      })),
    ],
  };
}

/** Reads a lead's stored fields back into the domain's state shape. */
export function assignmentStateOf(lead: LeadDoc): AssignmentState {
  if (lead.assignmentStatus === 'pending_ack' || lead.assignmentStatus === 'escalated') {
    return {
      status: lead.assignmentStatus,
      level: lead.escalationLevel,
      target: lead.escalationTarget,
      windowStartedAt: (lead.windowStartedAt ?? lead.createdAt).getTime(),
      escalationCount: lead.escalationCount,
    };
  }

  return {
    status: lead.assignmentStatus,
    level: lead.escalationLevel,
    target: lead.escalationTarget,
    escalationCount: lead.escalationCount,
    settledAt: (lead.acknowledgedAt ?? lead.updatedAt).getTime(),
  };
}

/**
 * The employees the assignment engine may choose from (F3.3).
 *
 * Ordered by id so the rotation is stable: the engine's fairness depends on the
 * candidate list not changing order between calls.
 */
export async function assignmentCandidates(
  workspaceId: Types.ObjectId,
  session?: ClientSession,
): Promise<readonly AssignmentCandidate[]> {
  const memberships = await MembershipModel.find({ workspaceId })
    .sort({ _id: 1 })
    .select('_id availabilityStatus openLeadCount')
    .session(session ?? null)
    .lean();

  return memberships.map((membership) => ({
    employeeId: membership._id.toString(),
    status: membership.availabilityStatus,
    openLeadCount: membership.openLeadCount,
  }));
}

const emitOutbox = appendOutbox;

/** Why a lead could not be placed, in words a manager can act on (F3.7). */
export function unassignableMessage(reason: UnassignableReason): string {
  const messages: Record<UnassignableReason, string> = {
    no_candidates: 'This workspace has no employees to assign leads to.',
    all_excluded: 'Everyone eligible has already held this lead.',
    none_available: 'Nobody is Available right now.',
    all_at_capacity: 'Everyone Available is at their open-lead limit.',
    limit_below_one: 'The maximum open leads per employee is set below one.',
  };

  return messages[reason];
}

// ---------------------------------------------------------------------------
// Capture and assignment
// ---------------------------------------------------------------------------

export interface CreateLeadInput {
  readonly workspaceId: Types.ObjectId;
  readonly source: LeadSource;
  readonly sourceLabel: string;
  readonly contactId?: Types.ObjectId | null | undefined;
  /** Used when the lead carries a new person rather than a known contact. */
  readonly contact?:
    | { firstName: string; lastName?: string; email?: string | null; phone?: string | null }
    | undefined;
  readonly actor: Actor | null;
  readonly requestId?: string | undefined;
}

export interface CreateLeadResult {
  readonly leadId: Types.ObjectId;
  readonly assigneeMembershipId: Types.ObjectId | null;
  readonly unassignedReason: UnassignableReason | null;
}

/**
 * Captures a lead and assigns it in one transaction (F3.1, F3.3).
 *
 * A lead that cannot be assigned is still created, unassigned, with the reason
 * recorded. Refusing the capture would lose the enquiry, which is the exact
 * failure the whole platform exists to prevent.
 */
export async function createLead(input: CreateLeadInput): Promise<CreateLeadResult> {
  const session = await mongoose.startSession();
  try {
    let result: CreateLeadResult | undefined;

    await session.withTransaction(async () => {
      const settings = await settingsFor(input.workspaceId, session);

      // A new person arriving by form or message becomes a contact (I1.5).
      let contactId = input.contactId ?? null;
      if (contactId === null && input.contact !== undefined) {
        const [contact] = await ContactModel.create(
          [
            {
              workspaceId: input.workspaceId,
              firstName: input.contact.firstName,
              lastName: input.contact.lastName ?? '',
              email: input.contact.email ?? null,
              phone: input.contact.phone ?? null,
            },
          ],
          { session, ordered: true },
        );
        if (contact === undefined) throw new Error('contact was not created');
        contactId = contact._id;
      }

      const candidates = await assignmentCandidates(input.workspaceId, session);
      const decision = assignLead(
        { leadId: 'new' },
        candidates,
        { strategy: 'round_robin', maxOpenLeadsPerEmployee: settings.maxOpenLeadsPerEmployee },
        {
          lastAssignedEmployeeId: settings.roundRobinCursorMembershipId?.toString() ?? null,
        },
      );

      const now = new Date();
      const assigneeId = decision.assigned ? new Types.ObjectId(decision.employeeId) : null;

      const [lead] = await LeadModel.create(
        [
          {
            workspaceId: input.workspaceId,
            contactId,
            source: input.source,
            sourceLabel: input.sourceLabel,
            status: 'open',
            assigneeMembershipId: assigneeId,
            assignedAt: assigneeId === null ? null : now,
            firstAssignedAt: assigneeId === null ? null : now,
            assignmentStatus: 'pending_ack',
            escalationLevel: 0,
            escalationTarget: 'assignee',
            windowStartedAt: assigneeId === null ? null : now,
            escalationCount: 0,
            previousAssigneeMembershipIds: assigneeId === null ? [] : [assigneeId],
            version: 0,
          },
        ],
        { session, ordered: true },
      );
      if (lead === undefined) throw new Error('lead was not created');

      if (assigneeId !== null) {
        // The cursor moves only on a successful assignment, so a failure costs
        // nobody their turn.
        await WorkspaceSettingsModel.updateOne(
          { workspaceId: input.workspaceId },
          { $set: { roundRobinCursorMembershipId: assigneeId } },
          { session },
        );

        await MembershipModel.updateOne(
          { _id: assigneeId, workspaceId: input.workspaceId },
          { $inc: { openLeadCount: 1 } },
          { session },
        );

        // The acknowledgement window starts now (F3.4).
        await scheduleJob(
          {
            workspaceId: input.workspaceId,
            type: 'lead.escalate',
            targetId: lead._id,
            runAt: new Date(now.getTime() + settings.acknowledgementWindowSeconds * 1_000),
            idempotencyKey: escalationKey(lead._id, 0, 0),
            payload: { assignmentVersion: 0, level: 0 },
          },
          session,
        );
      }

      const actor = input.actor ?? {
        membershipId: null as unknown as Types.ObjectId,
        userId: null as unknown as Types.ObjectId,
        label: `system (${input.sourceLabel})`,
      };

      await appendAuditEvent(
        {
          workspaceId: input.workspaceId,
          type: AUDIT_EVENT_TYPES.LEAD_CAPTURED,
          actor:
            input.actor === null
              ? { kind: 'system', label: `form: ${input.sourceLabel}` }
              : {
                  kind: 'user',
                  userId: input.actor.userId,
                  membershipId: input.actor.membershipId,
                  label: input.actor.label,
                },
          target: { kind: 'lead', id: lead._id.toString(), label: input.sourceLabel },
          after: { source: input.source, assigned: assigneeId !== null },
          ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
        },
        session,
      );

      if (assigneeId !== null) {
        await appendAuditEvent(
          {
            workspaceId: input.workspaceId,
            type: AUDIT_EVENT_TYPES.LEAD_ASSIGNED,
            actor: { kind: 'system', label: 'assignment engine' },
            target: { kind: 'lead', id: lead._id.toString(), label: input.sourceLabel },
            after: { assigneeMembershipId: assigneeId.toString(), level: 0 },
            ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
          },
          session,
        );
      }

      if (contactId !== null) {
        await recordActivity(
          {
            workspaceId: input.workspaceId,
            type: 'lead.assigned',
            targetKind: 'contact',
            targetId: contactId,
            contactId,
            actor: {
              ...(input.actor === null
                ? {}
                : { membershipId: input.actor.membershipId, userId: input.actor.userId }),
              label: actor.label,
            },
            summary:
              assigneeId === null
                ? `Lead captured from ${input.sourceLabel}, not yet assigned`
                : `Lead captured from ${input.sourceLabel} and assigned`,
            payload: { source: input.source, leadId: lead._id.toString() },
          },
          session,
        );
      }

      await emitOutbox(
        input.workspaceId,
        'lead.created',
        { leadId: lead._id.toString() },
        assigneeId,
        session,
      );

      result = {
        leadId: lead._id,
        assigneeMembershipId: assigneeId,
        unassignedReason: decision.assigned ? null : decision.reason,
      };
    });

    if (result === undefined) throw new Error('create lead produced no result');
    return result;
  } finally {
    await session.endSession();
  }
}

// ---------------------------------------------------------------------------
// Acknowledgement (F3.4, Section 7)
// ---------------------------------------------------------------------------

/**
 * Marks a lead acknowledged and cancels its escalation.
 *
 * Section 7 counts either an explicit Acknowledge or "a recorded action on the
 * lead", so `recordedAction` lets a note, message or stage change acknowledge
 * it through the same path rather than a parallel one that could diverge.
 */
export async function acknowledgeLead(
  auth: AuthContext,
  leadId: string,
  actor: Actor,
  options: { recordedAction?: string | undefined } = {},
): Promise<{ acknowledged: boolean }> {
  if (!Types.ObjectId.isValid(leadId)) throw notFound('That lead does not exist.');
  const _id = new Types.ObjectId(leadId);

  const lead = await LeadModel.findOne({ _id, workspaceId: auth.workspaceId }).lean();
  if (lead === null) throw notFound('That lead does not exist.');

  // Already settled: acknowledging again is a no-op rather than an error, so a
  // double click and a late recorded action are both harmless.
  if (lead.assignmentStatus !== 'pending_ack' && lead.assignmentStatus !== 'escalated') {
    return { acknowledged: false };
  }

  const session = await mongoose.startSession();
  try {
    let acknowledged = false;

    await session.withTransaction(async () => {
      const now = new Date();

      const updated = await LeadModel.updateOne(
        { _id, workspaceId: auth.workspaceId, version: lead.version },
        {
          $set: {
            assignmentStatus: 'acknowledged',
            acknowledgedAt: now,
            lastActivityAt: now,
          },
          $inc: { version: 1 },
        },
        { session },
      );

      // Lost the race to an escalation: the state we read is gone, so this
      // acknowledgement does not apply to it.
      if (updated.modifiedCount !== 1) return;

      // No further escalation for this lead (F3.4).
      await cancelJobsFor(_id, session);

      await appendAuditEvent(
        {
          workspaceId: auth.workspaceId,
          type: AUDIT_EVENT_TYPES.LEAD_ACKNOWLEDGED,
          actor: {
            kind: 'user',
            userId: actor.userId,
            membershipId: actor.membershipId,
            label: actor.label,
          },
          target: { kind: 'lead', id: leadId, label: lead.sourceLabel },
          after: {
            level: lead.escalationLevel,
            escalationCount: lead.escalationCount,
            ...(options.recordedAction === undefined ? {} : { via: options.recordedAction }),
          },
        },
        session,
      );

      if (lead.contactId !== null) {
        await recordActivity(
          {
            workspaceId: auth.workspaceId,
            type: 'lead.acknowledged',
            targetKind: 'contact',
            targetId: lead.contactId,
            contactId: lead.contactId,
            actor: { membershipId: actor.membershipId, userId: actor.userId, label: actor.label },
            summary:
              options.recordedAction === undefined
                ? 'Lead acknowledged'
                : `Lead acknowledged by ${options.recordedAction}`,
            payload: { leadId },
          },
          session,
        );
      }

      await emitOutbox(
        auth.workspaceId,
        'lead.acknowledged',
        { leadId },
        lead.assigneeMembershipId,
        session,
      );

      acknowledged = true;
    });

    return { acknowledged };
  } finally {
    await session.endSession();
  }
}

// ---------------------------------------------------------------------------
// Escalation (F3.5, F3.8) — run by the worker
// ---------------------------------------------------------------------------

export interface EscalationOutcome {
  readonly escalated: boolean;
  /** Why nothing happened, when it did not. */
  readonly reason:
    | 'escalated'
    | 'already_settled'
    | 'version_changed'
    | 'window_not_expired'
    | 'no_further_level'
    | 'nobody_eligible'
    | 'lost_race';
}

/**
 * Applies one escalation step.
 *
 * Called by the worker when a job comes due. Every guard below exists because
 * the job may be stale, duplicated, or racing another claimer:
 *
 *   1. the lead may have been acknowledged since the job was scheduled
 *   2. its version may have moved, meaning this job describes a state that no
 *      longer exists
 *   3. the window may not actually have expired (a job can run early after a
 *      clock change or a manual trigger)
 *   4. the conditional update may lose to another writer
 *
 * In all four cases it does nothing and says so, which is what makes running
 * the same job twice a no-op.
 */
export async function escalateLead(
  leadId: Types.ObjectId,
  expectedVersion: number,
  now: Date = new Date(),
): Promise<EscalationOutcome> {
  const lead = await LeadModel.findById(leadId).lean();
  if (lead === null) return { escalated: false, reason: 'already_settled' };

  if (lead.assignmentStatus !== 'pending_ack' && lead.assignmentStatus !== 'escalated') {
    return { escalated: false, reason: 'already_settled' };
  }

  // The job was scheduled for a state that has since changed.
  if (lead.version !== expectedVersion) {
    return { escalated: false, reason: 'version_changed' };
  }

  const settings = await settingsFor(lead.workspaceId);
  const config = escalationConfigFrom(settings);

  const next = nextEscalation(assignmentStateOf(lead), now.getTime(), config);
  if (next === null) {
    const level = config.levels[lead.escalationLevel];
    const deadline =
      level === undefined
        ? null
        : (lead.windowStartedAt ?? lead.createdAt).getTime() + level.acknowledgementWindowMs;

    // Distinguished so the worker's log says which it was.
    return {
      escalated: false,
      reason:
        deadline !== null && now.getTime() < deadline ? 'window_not_expired' : 'no_further_level',
    };
  }

  // Who the next level resolves to. Only `next_eligible` consults the engine;
  // backup and manager are configured people.
  let nextAssignee: Types.ObjectId | null = null;

  if (next.target === 'backup') {
    nextAssignee = settings.backupMembershipId;
  } else if (next.target === 'manager') {
    nextAssignee = settings.managerMembershipId;
  }

  if (nextAssignee === null) {
    const candidates = await assignmentCandidates(lead.workspaceId);
    const decision = assignLead(
      {
        leadId: leadId.toString(),
        // Never back to someone who has already let it expire (F3.5).
        excludeEmployeeIds: lead.previousAssigneeMembershipIds.map((id) => id.toString()),
      },
      candidates,
      { strategy: 'round_robin', maxOpenLeadsPerEmployee: settings.maxOpenLeadsPerEmployee },
      { lastAssignedEmployeeId: settings.roundRobinCursorMembershipId?.toString() ?? null },
    );

    if (decision.assigned) nextAssignee = new Types.ObjectId(decision.employeeId);
  }

  const session = await mongoose.startSession();
  try {
    let outcome: EscalationOutcome = { escalated: false, reason: 'lost_race' };

    await session.withTransaction(async () => {
      // Conditional on the version we decided from (F3.8). Two claimers both
      // reach here with version N; exactly one update matches.
      const updated = await LeadModel.updateOne(
        { _id: leadId, version: expectedVersion },
        {
          $set: {
            assignmentStatus: 'escalated',
            escalationLevel: next.level,
            escalationTarget: next.target,
            windowStartedAt: new Date(next.windowStartedAt),
            escalationCount: next.escalationCount,
            ...(nextAssignee === null
              ? {}
              : { assigneeMembershipId: nextAssignee, assignedAt: now }),
          },
          $inc: { version: 1 },
          ...(nextAssignee === null
            ? {}
            : { $addToSet: { previousAssigneeMembershipIds: nextAssignee } }),
        },
        { session },
      );

      if (updated.modifiedCount !== 1) {
        outcome = { escalated: false, reason: 'lost_race' };
        return;
      }

      if (nextAssignee !== null) {
        if (lead.assigneeMembershipId !== null) {
          await MembershipModel.updateOne(
            { _id: lead.assigneeMembershipId },
            { $inc: { openLeadCount: -1 } },
            { session },
          );
        }
        await MembershipModel.updateOne(
          { _id: nextAssignee },
          { $inc: { openLeadCount: 1 } },
          { session },
        );
      }

      // The next level's timer, keyed on the NEW version so it cannot collide
      // with the job that just ran.
      const nextLevel = config.levels[next.level];
      if (nextLevel !== undefined && next.level + 1 < config.levels.length) {
        await scheduleJob(
          {
            workspaceId: lead.workspaceId,
            type: 'lead.escalate',
            targetId: leadId,
            runAt: new Date(next.windowStartedAt + nextLevel.acknowledgementWindowMs),
            idempotencyKey: escalationKey(leadId, expectedVersion + 1, next.level),
            payload: { assignmentVersion: expectedVersion + 1, level: next.level },
          },
          session,
        );
      }

      await appendAuditEvent(
        {
          workspaceId: lead.workspaceId,
          type: AUDIT_EVENT_TYPES.LEAD_ESCALATED,
          actor: { kind: 'system', label: 'escalation timer' },
          target: { kind: 'lead', id: leadId.toString(), label: lead.sourceLabel },
          before: {
            level: lead.escalationLevel,
            assigneeMembershipId: lead.assigneeMembershipId?.toString() ?? null,
          },
          after: {
            level: next.level,
            target: next.target,
            assigneeMembershipId: nextAssignee?.toString() ?? null,
            escalationCount: next.escalationCount,
          },
        },
        session,
      );

      if (lead.contactId !== null) {
        await recordActivity(
          {
            workspaceId: lead.workspaceId,
            type: 'lead.escalated',
            targetKind: 'contact',
            targetId: lead.contactId,
            contactId: lead.contactId,
            actor: { label: 'system' },
            summary: `Lead escalated to ${next.target} (level ${String(next.level)})`,
            payload: { leadId: leadId.toString(), level: next.level, target: next.target },
          },
          session,
        );
      }

      // P5 relays this to the browser; P10 sends the external alert (F3.9).
      await emitOutbox(
        lead.workspaceId,
        'lead.escalated',
        {
          leadId: leadId.toString(),
          level: next.level,
          target: next.target,
          reason: 'acknowledgement window expired',
        },
        nextAssignee,
        session,
      );

      outcome = { escalated: true, reason: 'escalated' };
    });

    return outcome;
  } finally {
    await session.endSession();
  }
}

// ---------------------------------------------------------------------------
// Availability and absence (F3.2, F3.6)
// ---------------------------------------------------------------------------

export interface AvailabilityChangeResult {
  readonly reassignedLeadIds: readonly string[];
  readonly flaggedLeadIds: readonly string[];
}

/**
 * Sets an employee's availability and handles their leads (F3.2, F3.6).
 *
 * On leave or Offline reassigns their **unacknowledged** leads immediately, in
 * the same request, so no window continues to run against someone who is away.
 *
 * Acknowledged leads are deliberately left with their owner and flagged
 * `ownerUnavailable` instead. They already have someone accountable who has
 * engaged with the customer; moving them would discard that context and reset
 * the relationship. The flag is what makes the treatment visible, and a manager
 * can still reassign by hand. This is the defined treatment F3.6 asks for.
 */
export async function setAvailability(
  auth: AuthContext,
  membershipId: string,
  status: AvailabilityStatus,
  actor: Actor,
): Promise<AvailabilityChangeResult> {
  if (!Types.ObjectId.isValid(membershipId)) throw notFound('That member does not exist.');
  const _id = new Types.ObjectId(membershipId);

  const membership = await MembershipModel.findOne({ _id, workspaceId: auth.workspaceId }).lean();
  if (membership === null) throw notFound('That member does not exist.');

  await MembershipModel.updateOne(
    { _id, workspaceId: auth.workspaceId },
    { $set: { availabilityStatus: status } },
  );

  await appendAuditEvent({
    workspaceId: auth.workspaceId,
    type: AUDIT_EVENT_TYPES.USER_AVAILABILITY_CHANGED,
    actor: {
      kind: 'user',
      userId: actor.userId,
      membershipId: actor.membershipId,
      label: actor.label,
    },
    target: { kind: 'membership', id: membershipId, label: membership.availabilityStatus },
    before: { availabilityStatus: membership.availabilityStatus },
    after: { availabilityStatus: status },
  });

  if (!isAbsent(status)) return { reassignedLeadIds: [], flaggedLeadIds: [] };

  const open = await LeadModel.find({
    workspaceId: auth.workspaceId,
    assigneeMembershipId: _id,
    status: 'open',
  }).lean();

  const reassignedLeadIds: string[] = [];
  const flaggedLeadIds: string[] = [];

  for (const lead of open) {
    const unacknowledged =
      lead.assignmentStatus === 'pending_ack' || lead.assignmentStatus === 'escalated';

    if (!unacknowledged) {
      // Acknowledged: left with its owner, flagged so the team can see why.
      await LeadModel.updateOne(
        { _id: lead._id, workspaceId: auth.workspaceId },
        { $set: { ownerUnavailable: true } },
      );
      flaggedLeadIds.push(lead._id.toString());
      continue;
    }

    const moved = await reassignLead(auth, lead._id, actor, {
      reason: 'absence',
      excludeCurrent: true,
    });
    if (moved) reassignedLeadIds.push(lead._id.toString());
  }

  return { reassignedLeadIds, flaggedLeadIds };
}

/**
 * Moves a lead to the next eligible employee.
 *
 * Shared by absence handling and by a manager's manual reassignment, so both
 * take the same conditional-update path and both are audited the same way. A
 * manual move does **not** increment `escalationCount`, because Section 7
 * counts manual reassignments separately from escalations.
 */
export async function reassignLead(
  auth: AuthContext,
  leadId: Types.ObjectId,
  actor: Actor,
  options: {
    reason: 'absence' | 'manual';
    toMembershipId?: Types.ObjectId | undefined;
    excludeCurrent?: boolean | undefined;
  },
): Promise<boolean> {
  const lead = await LeadModel.findOne({ _id: leadId, workspaceId: auth.workspaceId }).lean();
  if (lead === null) throw notFound('That lead does not exist.');

  const settings = await settingsFor(auth.workspaceId);

  let target = options.toMembershipId ?? null;

  if (target === null) {
    const candidates = await assignmentCandidates(auth.workspaceId);
    const decision = assignLead(
      {
        leadId: leadId.toString(),
        excludeEmployeeIds:
          options.excludeCurrent === true && lead.assigneeMembershipId !== null
            ? [lead.assigneeMembershipId.toString()]
            : [],
      },
      candidates,
      { strategy: 'round_robin', maxOpenLeadsPerEmployee: settings.maxOpenLeadsPerEmployee },
      { lastAssignedEmployeeId: settings.roundRobinCursorMembershipId?.toString() ?? null },
    );

    if (!decision.assigned) {
      // Unassigned rather than left with someone who is away: the recovery
      // queue is what surfaces it (F3.7).
      await LeadModel.updateOne(
        { _id: leadId, workspaceId: auth.workspaceId, version: lead.version },
        {
          $set: { assigneeMembershipId: null, assignedAt: null, ownerUnavailable: false },
          $inc: { version: 1 },
        },
      );
      return false;
    }

    target = new Types.ObjectId(decision.employeeId);
  } else {
    const exists = await MembershipModel.countDocuments({
      _id: target,
      workspaceId: auth.workspaceId,
    });
    if (exists === 0) throw notFound('That member does not exist.');
  }

  const now = new Date();
  const session = await mongoose.startSession();
  try {
    let moved = false;

    await session.withTransaction(async () => {
      const updated = await LeadModel.updateOne(
        { _id: leadId, workspaceId: auth.workspaceId, version: lead.version },
        {
          $set: {
            assigneeMembershipId: target,
            assignedAt: now,
            windowStartedAt: now,
            // A reassigned lead starts a fresh window at level 0, so the new
            // owner gets the full time rather than inheriting a spent clock.
            assignmentStatus: 'pending_ack',
            escalationLevel: 0,
            escalationTarget: 'assignee',
            acknowledgedAt: null,
            ownerUnavailable: false,
            ...(lead.firstAssignedAt === null ? { firstAssignedAt: now } : {}),
          },
          $inc: { version: 1 },
          $addToSet: { previousAssigneeMembershipIds: target },
        },
        { session },
      );

      if (updated.modifiedCount !== 1) return;

      if (lead.assigneeMembershipId !== null) {
        await MembershipModel.updateOne(
          { _id: lead.assigneeMembershipId },
          { $inc: { openLeadCount: -1 } },
          { session },
        );
      }
      await MembershipModel.updateOne({ _id: target }, { $inc: { openLeadCount: 1 } }, { session });

      // The old timer described a state that no longer exists.
      await cancelJobsFor(leadId, session);
      await scheduleJob(
        {
          workspaceId: auth.workspaceId,
          type: 'lead.escalate',
          targetId: leadId,
          runAt: new Date(now.getTime() + settings.acknowledgementWindowSeconds * 1_000),
          idempotencyKey: escalationKey(leadId, lead.version + 1, 0),
          payload: { assignmentVersion: lead.version + 1, level: 0 },
        },
        session,
      );

      await appendAuditEvent(
        {
          workspaceId: auth.workspaceId,
          type:
            options.reason === 'absence'
              ? AUDIT_EVENT_TYPES.LEAD_REASSIGNED_ABSENCE
              : AUDIT_EVENT_TYPES.LEAD_REASSIGNED_MANUAL,
          actor:
            options.reason === 'absence'
              ? { kind: 'system', label: 'absence handling' }
              : {
                  kind: 'user',
                  userId: actor.userId,
                  membershipId: actor.membershipId,
                  label: actor.label,
                },
          target: { kind: 'lead', id: leadId.toString(), label: lead.sourceLabel },
          before: { assigneeMembershipId: lead.assigneeMembershipId?.toString() ?? null },
          after: { assigneeMembershipId: target.toString(), reason: options.reason },
        },
        session,
      );

      await emitOutbox(
        auth.workspaceId,
        'lead.assigned',
        { leadId: leadId.toString(), reason: options.reason },
        target,
        session,
      );

      moved = true;
    });

    return moved;
  } finally {
    await session.endSession();
  }
}

/** Resolves a membership to a label for the inbox and the availability board. */
export async function membershipLabels(
  workspaceId: Types.ObjectId,
): Promise<Map<string, { email: string; name: string }>> {
  const memberships = await MembershipModel.find({ workspaceId }).select('userId').lean();
  const users = await UserModel.find({
    _id: { $in: memberships.map((membership) => membership.userId) },
  })
    .select('email name')
    .lean();

  const userById = new Map(users.map((user) => [user._id.toString(), user]));
  const labels = new Map<string, { email: string; name: string }>();

  for (const membership of memberships) {
    const user = userById.get(membership.userId.toString());
    labels.set(membership._id.toString(), {
      email: user?.email ?? '(removed account)',
      name: user?.name ?? '',
    });
  }

  return labels;
}

export { contactDisplayName, conflict };
