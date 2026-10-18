import { AUDIT_EVENT_TYPES, AVAILABILITY_STATUSES, PERMISSIONS } from '@ubmp/domain';
import { paginationQuerySchema } from '@ubmp/shared';
import { Router, type RequestHandler } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';

import { LeadFormModel } from '../../db/models/lead-form.js';
import { LeadModel, type LeadDoc } from '../../db/models/lead.js';
import { MembershipModel } from '../../db/models/membership.js';
import {
  DEFAULT_ESCALATION_LEVELS,
  WorkspaceSettingsModel,
  type WorkspaceSettingsDoc,
} from '../../db/models/workspace-settings.js';
import { appendAuditEvent } from '../../repositories/audit-repository.js';
import { appendOutbox } from '../../repositories/outbox.js';
import { RECOVERY_REASON_LABELS, recoveryQueueFor } from '../../services/recovery-service.js';
import { actorFor } from '../../services/crm-service.js';
import {
  acknowledgeLead,
  createLead,
  escalationConfigFrom,
  membershipLabels,
  reassignLead,
  setAvailability,
  settingsFor,
  unassignableMessage,
} from '../../services/lead-service.js';
import { authOf, requireSession } from '../middleware/authenticate.js';
import { requirePermission } from '../middleware/require-permission.js';
import { requireParam } from '../params.js';

/**
 * Leads, availability, assignment rules and the recovery queue
 * (F3.1 - F3.8).
 */
const objectIdSchema = z.string().regex(/^[0-9a-fA-F]{24}$/, 'is not a valid id');

/**
 * The public form's body (F3.1).
 *
 * `_honey` is a honeypot: a real browser leaves it empty because it is hidden,
 * so anything in it is a bot. The submission is accepted with a 202 rather than
 * refused, so a scraper cannot tell the field is a trap and adapt.
 */
const publicLeadSchema = z.object({
  firstName: z.string().trim().min(1, 'is required').max(100),
  lastName: z.string().trim().max(100).optional(),
  email: z.string().trim().email('is not a valid email address').max(320).optional(),
  phone: z.string().trim().max(40).optional(),
  message: z.string().trim().max(2_000).optional(),
  _honey: z.string().max(200).optional(),
});

function leadView(lead: LeadDoc, deadline: number | null) {
  return {
    id: lead._id.toString(),
    contactId: lead.contactId?.toString() ?? null,
    source: lead.source,
    sourceLabel: lead.sourceLabel,
    status: lead.status,
    assigneeMembershipId: lead.assigneeMembershipId?.toString() ?? null,
    assignmentStatus: lead.assignmentStatus,
    escalationLevel: lead.escalationLevel,
    escalationTarget: lead.escalationTarget,
    escalationCount: lead.escalationCount,
    ownerUnavailable: lead.ownerUnavailable,
    assignedAt: lead.assignedAt?.toISOString() ?? null,
    acknowledgedAt: lead.acknowledgedAt?.toISOString() ?? null,
    firstAcknowledgedAt: lead.firstAcknowledgedAt?.toISOString() ?? null,
    lastActivityAt: lead.lastActivityAt?.toISOString() ?? null,
    /** The countdown target the inbox renders (F3.4). */
    acknowledgementDeadline: deadline === null ? null : new Date(deadline).toISOString(),
    version: lead.version,
    createdAt: lead.createdAt.toISOString(),
  };
}

/** The configurable part of the settings, for the audit before/after (F4.1). */
function rulesSnapshot(settings: WorkspaceSettingsDoc): Record<string, unknown> {
  return {
    maxOpenLeadsPerEmployee: settings.maxOpenLeadsPerEmployee,
    acknowledgementWindowSeconds: settings.acknowledgementWindowSeconds,
    escalationLevels: settings.escalationLevels.map((level) => ({
      target: level.target,
      windowSeconds: level.windowSeconds,
    })),
    backupMembershipId: settings.backupMembershipId?.toString() ?? null,
    managerMembershipId: settings.managerMembershipId?.toString() ?? null,
    idleRecoveryMinutes: settings.idleRecoveryMinutes,
    recoveryMinEscalations: settings.recoveryMinEscalations,
  };
}

export interface LeadsRouterOptions {
  /** Supplied so the public form's limiter can be replaced in tests. */
  readonly publicFormRateLimiter: RequestHandler;
}

export function createLeadsRouter({ publicFormRateLimiter }: LeadsRouterOptions): Router {
  const router = Router();

  // -------------------------------------------------------------------------
  // The public form (F3.1)
  // -------------------------------------------------------------------------

  /**
   * Unauthenticated by design: this is the form on the company's website.
   *
   * Protected instead by the form id, a rate limit, Zod validation and a
   * honeypot. It is exempt from CSRF because there is no session to forge
   * against.
   */
  router.post('/public/forms/:formId/leads', publicFormRateLimiter, async (req, res) => {
    const formId = requireParam(req, 'formId');
    if (!Types.ObjectId.isValid(formId)) {
      // The same answer as a disabled form, so form ids cannot be probed.
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'That form does not exist.' } });
      return;
    }

    const form = await LeadFormModel.findOne({
      _id: new Types.ObjectId(formId),
      enabled: true,
    }).lean();

    if (form === null) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'That form does not exist.' } });
      return;
    }

    const input = publicLeadSchema.parse(req.body);

    // Accepted and dropped: a bot is told nothing useful.
    if (input._honey !== undefined && input._honey !== '') {
      res.status(202).json({ received: true });
      return;
    }

    const result = await createLead({
      workspaceId: form.workspaceId,
      source: 'web_form',
      sourceLabel: form.sourceLabel,
      contact: {
        firstName: input.firstName,
        ...(input.lastName === undefined ? {} : { lastName: input.lastName }),
        email: input.email ?? null,
        phone: input.phone ?? null,
      },
      actor: null,
      requestId: req.id,
    });

    // 202: captured, and whether it found an owner is not the submitter's
    // business.
    res.status(202).json({ received: true, leadId: result.leadId.toString() });
  });

  /** Forms are configuration, so creating one needs the config permission. */
  router.post(
    '/lead-forms',
    requireSession(),
    requirePermission(PERMISSIONS.ASSIGNMENT_RULES_MANAGE),
    async (req, res) => {
      const input = z
        .object({
          name: z.string().trim().min(1, 'is required').max(100),
          sourceLabel: z.string().trim().min(1).max(200).optional(),
        })
        .parse(req.body);

      const auth = authOf(req);
      const form = await LeadFormModel.create({
        workspaceId: auth.workspaceId,
        name: input.name,
        sourceLabel: input.sourceLabel ?? input.name,
      });

      res.status(201).json({
        id: form._id.toString(),
        name: form.name,
        sourceLabel: form.sourceLabel,
        // The URL to paste into the company's website.
        endpoint: `/api/public/forms/${form._id.toString()}/leads`,
      });
    },
  );

  router.get(
    '/lead-forms',
    requireSession(),
    requirePermission(PERMISSIONS.CRM_VIEW),
    async (req, res) => {
      const forms = await LeadFormModel.find({ workspaceId: authOf(req).workspaceId })
        .sort({ createdAt: -1 })
        .lean();

      res.status(200).json({
        forms: forms.map((form) => ({
          id: form._id.toString(),
          name: form.name,
          sourceLabel: form.sourceLabel,
          enabled: form.enabled,
          endpoint: `/api/public/forms/${form._id.toString()}/leads`,
        })),
      });
    },
  );

  // -------------------------------------------------------------------------
  // Leads
  // -------------------------------------------------------------------------

  /** Manual entry by an employee (F3.1). */
  router.post(
    '/leads',
    requireSession(),
    requirePermission(PERMISSIONS.CRM_CREATE),
    async (req, res) => {
      const input = z
        .object({
          contactId: objectIdSchema.optional(),
          firstName: z.string().trim().min(1).max(100).optional(),
          lastName: z.string().trim().max(100).optional(),
          email: z.string().trim().email().max(320).optional(),
          phone: z.string().trim().max(40).optional(),
          sourceLabel: z.string().trim().min(1).max(200).default('Manual entry'),
        })
        .refine((value) => value.contactId !== undefined || value.firstName !== undefined, {
          message: 'provide a contactId or a firstName',
        })
        .parse(req.body);

      const auth = authOf(req);
      const actor = await actorFor(auth);

      const result = await createLead({
        workspaceId: auth.workspaceId,
        source: 'manual',
        sourceLabel: input.sourceLabel,
        ...(input.contactId === undefined
          ? {
              contact: {
                firstName: input.firstName ?? 'Unknown',
                ...(input.lastName === undefined ? {} : { lastName: input.lastName }),
                email: input.email ?? null,
                phone: input.phone ?? null,
              },
            }
          : { contactId: new Types.ObjectId(input.contactId) }),
        actor,
        requestId: req.id,
      });

      res.status(201).json({
        leadId: result.leadId.toString(),
        assigneeMembershipId: result.assigneeMembershipId?.toString() ?? null,
        // Reported rather than hidden, so the creator knows it needs attention.
        unassignedReason:
          result.unassignedReason === null
            ? null
            : {
                code: result.unassignedReason,
                message: unassignableMessage(result.unassignedReason),
              },
      });
    },
  );

  /**
   * The inbox. `mine=true` is the employee's own list; without it, and with
   * member management, it is the whole workspace.
   */
  router.get(
    '/leads',
    requireSession(),
    requirePermission(PERMISSIONS.CRM_VIEW),
    async (req, res) => {
      const pagination = paginationQuerySchema.parse(req.query);
      const query = z
        .object({
          mine: z.enum(['true', 'false']).optional(),
          status: z.enum(['open', 'converted', 'closed', 'all']).optional(),
          // The dashboard's drill-down reproduces its "new leads" figure (F5.3).
          createdFrom: z.string().datetime({ offset: true }).optional(),
          createdTo: z.string().datetime({ offset: true }).optional(),
        })
        .parse(req.query);

      const auth = authOf(req);
      const settings = await settingsFor(auth.workspaceId);
      const config = escalationConfigFrom(settings);

      const filter: Record<string, unknown> = { workspaceId: auth.workspaceId };
      if (query.status !== 'all') filter['status'] = query.status ?? 'open';
      if (query.createdFrom !== undefined || query.createdTo !== undefined) {
        filter['createdAt'] = {
          ...(query.createdFrom === undefined ? {} : { $gte: new Date(query.createdFrom) }),
          ...(query.createdTo === undefined ? {} : { $lt: new Date(query.createdTo) }),
        };
      }

      // A member without member management only ever sees their own leads, so
      // the inbox cannot be used to read the whole workspace (F1.5).
      const canSeeAll = auth.permissions.has(PERMISSIONS.MEMBERS_MANAGE);
      if (query.mine === 'true' || !canSeeAll) {
        filter['assigneeMembershipId'] = auth.membershipId;
      }

      const [items, total, labels] = await Promise.all([
        LeadModel.find(filter)
          .sort({ createdAt: -1 })
          .skip((pagination.page - 1) * pagination.limit)
          .limit(pagination.limit)
          .lean<LeadDoc[]>(),
        LeadModel.countDocuments(filter),
        membershipLabels(auth.workspaceId),
      ]);

      res.status(200).json({
        items: items.map((lead) => {
          const level = config.levels[lead.escalationLevel];
          const deadline =
            level === undefined ||
            lead.windowStartedAt === null ||
            (lead.assignmentStatus !== 'pending_ack' && lead.assignmentStatus !== 'escalated')
              ? null
              : lead.windowStartedAt.getTime() + level.acknowledgementWindowMs;

          return {
            ...leadView(lead, deadline),
            assigneeEmail:
              lead.assigneeMembershipId === null
                ? null
                : (labels.get(lead.assigneeMembershipId.toString())?.email ?? null),
          };
        }),
        pageInfo: {
          page: pagination.page,
          limit: pagination.limit,
          total,
          totalPages: total === 0 ? 0 : Math.ceil(total / pagination.limit),
          hasNextPage: pagination.page * pagination.limit < total,
          hasPreviousPage: pagination.page > 1,
        },
      });
    },
  );

  /** Acknowledgement (F3.4). */
  router.post(
    '/leads/:leadId/acknowledge',
    requireSession(),
    requirePermission(PERMISSIONS.CRM_EDIT),
    async (req, res) => {
      const auth = authOf(req);
      const result = await acknowledgeLead(auth, requireParam(req, 'leadId'), await actorFor(auth));

      res.status(200).json(result);
    },
  );

  /** Manual reassignment by a manager (F3.6). */
  router.post(
    '/leads/:leadId/reassign',
    requireSession(),
    requirePermission(PERMISSIONS.MEMBERS_MANAGE),
    async (req, res) => {
      const { toMembershipId } = z
        .object({ toMembershipId: objectIdSchema.optional() })
        .parse(req.body);

      const leadId = requireParam(req, 'leadId');
      if (!Types.ObjectId.isValid(leadId)) {
        res
          .status(404)
          .json({ error: { code: 'NOT_FOUND', message: 'That lead does not exist.' } });
        return;
      }

      const auth = authOf(req);
      const moved = await reassignLead(auth, new Types.ObjectId(leadId), await actorFor(auth), {
        reason: 'manual',
        ...(toMembershipId === undefined
          ? {}
          : { toMembershipId: new Types.ObjectId(toMembershipId) }),
      });

      res.status(200).json({ reassigned: moved });
    },
  );

  // -------------------------------------------------------------------------
  // Availability (F3.2, F3.6)
  // -------------------------------------------------------------------------

  router.get(
    '/availability',
    requireSession(),
    requirePermission(PERMISSIONS.CRM_VIEW),
    async (req, res) => {
      const auth = authOf(req);
      const [memberships, labels] = await Promise.all([
        MembershipModel.find({ workspaceId: auth.workspaceId }).sort({ _id: 1 }).lean(),
        membershipLabels(auth.workspaceId),
      ]);

      res.status(200).json({
        members: memberships.map((membership) => ({
          membershipId: membership._id.toString(),
          email: labels.get(membership._id.toString())?.email ?? '',
          baseLevel: membership.baseLevel,
          availabilityStatus: membership.availabilityStatus,
          openLeadCount: membership.openLeadCount,
        })),
      });
    },
  );

  /**
   * Sets availability.
   *
   * An employee may always set their own; changing someone else's needs member
   * management, so a User cannot mark a colleague On leave (F3.2).
   */
  router.patch('/availability/:membershipId', requireSession(), async (req, res) => {
    const { status } = z.object({ status: z.enum(AVAILABILITY_STATUSES) }).parse(req.body);
    const membershipId = requireParam(req, 'membershipId');
    const auth = authOf(req);

    const isSelf = membershipId === auth.membershipId.toString();
    if (!isSelf && !auth.permissions.has(PERMISSIONS.MEMBERS_MANAGE)) {
      res.status(403).json({
        error: {
          code: 'FORBIDDEN',
          message: 'You can only change your own availability.',
          hint: 'Ask an Owner or Admin to change it for someone else.',
        },
      });
      return;
    }

    const result = await setAvailability(auth, membershipId, status, await actorFor(auth));
    await appendOutbox(auth.workspaceId, 'availability.changed', { membershipId });

    // Reported, so the employee sees what happened to their leads (F3.6).
    res.status(200).json(result);
  });

  // -------------------------------------------------------------------------
  // Assignment rules (F3.3, F3.5)
  // -------------------------------------------------------------------------

  router.get(
    '/assignment-rules',
    requireSession(),
    requirePermission(PERMISSIONS.CRM_VIEW),
    async (req, res) => {
      const settings = await settingsFor(authOf(req).workspaceId);

      res.status(200).json({
        mode: settings.mode,
        maxOpenLeadsPerEmployee: settings.maxOpenLeadsPerEmployee,
        acknowledgementWindowSeconds: settings.acknowledgementWindowSeconds,
        escalationLevels: settings.escalationLevels,
        backupMembershipId: settings.backupMembershipId?.toString() ?? null,
        managerMembershipId: settings.managerMembershipId?.toString() ?? null,
        idleRecoveryMinutes: settings.idleRecoveryMinutes,
        recoveryMinEscalations: settings.recoveryMinEscalations,
      });
    },
  );

  router.patch(
    '/assignment-rules',
    requireSession(),
    requirePermission(PERMISSIONS.ASSIGNMENT_RULES_MANAGE),
    async (req, res) => {
      const input = z
        .object({
          maxOpenLeadsPerEmployee: z.number().int().min(1).max(1_000).optional(),
          // Minimum 5s rather than 1s: a window shorter than the worker's tick
          // would expire before any human could act, and a demo needs 30s.
          acknowledgementWindowSeconds: z.number().int().min(5).max(86_400).optional(),
          escalationLevels: z
            .array(
              z.object({
                target: z.enum(['assignee', 'next_eligible', 'backup', 'manager']),
                windowSeconds: z.number().int().min(5).max(86_400),
              }),
            )
            .max(10)
            .optional(),
          backupMembershipId: objectIdSchema.nullable().optional(),
          managerMembershipId: objectIdSchema.nullable().optional(),
          idleRecoveryMinutes: z.number().int().min(1).max(10_000).optional(),
          recoveryMinEscalations: z.number().int().min(1).max(50).optional(),
        })
        .parse(req.body);

      const auth = authOf(req);
      const before = await settingsFor(auth.workspaceId);

      await WorkspaceSettingsModel.updateOne(
        { workspaceId: auth.workspaceId },
        {
          $set: {
            ...(input.maxOpenLeadsPerEmployee === undefined
              ? {}
              : { maxOpenLeadsPerEmployee: input.maxOpenLeadsPerEmployee }),
            ...(input.acknowledgementWindowSeconds === undefined
              ? {}
              : { acknowledgementWindowSeconds: input.acknowledgementWindowSeconds }),
            ...(input.escalationLevels === undefined
              ? {}
              : { escalationLevels: input.escalationLevels }),
            ...(input.backupMembershipId === undefined
              ? {}
              : {
                  backupMembershipId:
                    input.backupMembershipId === null
                      ? null
                      : new Types.ObjectId(input.backupMembershipId),
                }),
            ...(input.managerMembershipId === undefined
              ? {}
              : {
                  managerMembershipId:
                    input.managerMembershipId === null
                      ? null
                      : new Types.ObjectId(input.managerMembershipId),
                }),
            ...(input.idleRecoveryMinutes === undefined
              ? {}
              : { idleRecoveryMinutes: input.idleRecoveryMinutes }),
            ...(input.recoveryMinEscalations === undefined
              ? {}
              : { recoveryMinEscalations: input.recoveryMinEscalations }),
          },
          $inc: { version: 1 },
        },
      );

      const settings = await settingsFor(auth.workspaceId);
      const actor = await actorFor(auth);
      await appendAuditEvent({
        workspaceId: auth.workspaceId,
        type: AUDIT_EVENT_TYPES.ASSIGNMENT_RULES_UPDATED,
        actor: {
          kind: 'user',
          userId: actor.userId,
          membershipId: actor.membershipId,
          label: actor.label,
        },
        target: { kind: 'assignment_rules', label: 'Assignment and escalation rules' },
        before: rulesSnapshot(before),
        after: rulesSnapshot(settings),
      });
      res.status(200).json({
        acknowledgementWindowSeconds: settings.acknowledgementWindowSeconds,
        maxOpenLeadsPerEmployee: settings.maxOpenLeadsPerEmployee,
        escalationLevels: settings.escalationLevels,
        idleRecoveryMinutes: settings.idleRecoveryMinutes,
        recoveryMinEscalations: settings.recoveryMinEscalations,
      });
    },
  );

  // -------------------------------------------------------------------------
  // Recovery queue (F3.7)
  // -------------------------------------------------------------------------

  router.get(
    '/recovery-queue',
    requireSession(),
    requirePermission(PERMISSIONS.CRM_VIEW),
    async (req, res) => {
      const auth = authOf(req);
      const [items, labels] = await Promise.all([
        recoveryQueueFor(auth.workspaceId),
        membershipLabels(auth.workspaceId),
      ]);

      res.status(200).json({
        items: items.map((item) => ({
          ...item,
          assigneeEmail:
            item.assigneeMembershipId === null
              ? null
              : (labels.get(item.assigneeMembershipId)?.email ?? null),
          // Each reason in words, never a bare code (F3.7).
          reasonLabels: item.reasons.map((reason) => RECOVERY_REASON_LABELS[reason]),
        })),
        total: items.length,
      });
    },
  );

  return router;
}

export { DEFAULT_ESCALATION_LEVELS };
