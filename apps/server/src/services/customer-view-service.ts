import { maskOpportunityValues, type Permission } from '@ubmp/domain';
import { notFound } from '@ubmp/shared';
import type { Types } from 'mongoose';

import { CompanyModel } from '../db/models/company.js';
import { ContactModel, contactDisplayName } from '../db/models/contact.js';
import { MembershipModel } from '../db/models/membership.js';
import { OpportunityModel } from '../db/models/opportunity.js';
import { PipelineModel } from '../db/models/pipeline.js';
import { UserModel } from '../db/models/user.js';
import { queryActivity } from '../repositories/activity-repository.js';
import type { AuthContext } from './session-service.js';

/**
 * The complete customer view (F2.8): "one contact page shows conversations,
 * opportunities, payments, appointments, the assigned employee and the activity
 * history".
 *
 * Assembled in one place, and in one round of parallel queries, so the page is
 * a single request rather than six that each have to re-check the workspace.
 *
 * Conversations, payments and appointments are **declared but empty** until
 * P7, P8 and P9 connect their providers. Each section carries an
 * `availableFrom` marker rather than being omitted, so the page can say "not
 * connected yet" instead of rendering a section that looks broken, and the
 * response shape does not change when the provider arrives (Q10).
 */

/** What a section of the page is waiting on, when it is not live yet. */
export interface PendingSection {
  readonly items: readonly never[];
  /** The phase that fills this in, for the interface's explanation. */
  readonly availableFrom: string;
  readonly reason: string;
}

const CONVERSATIONS_PENDING: PendingSection = {
  items: [],
  availableFrom: 'P7',
  reason: 'Messaging is not connected yet.',
};

const PAYMENTS_PENDING: PendingSection = {
  items: [],
  availableFrom: 'P8',
  reason: 'Payments are not connected yet.',
};

const APPOINTMENTS_PENDING: PendingSection = {
  items: [],
  availableFrom: 'P9',
  reason: 'The calendar is not connected yet.',
};

export interface CustomerView {
  readonly contact: Record<string, unknown>;
  readonly company: Record<string, unknown> | null;
  readonly assignedEmployee: {
    readonly membershipId: string;
    readonly email: string;
    readonly name: string;
    readonly availabilityStatus: string;
  } | null;
  readonly opportunities: readonly Record<string, unknown>[];
  readonly conversations: PendingSection;
  readonly payments: PendingSection;
  readonly appointments: PendingSection;
  readonly activity: readonly Record<string, unknown>[];
}

/**
 * Builds the contact page.
 *
 * `permissions` is passed in rather than read from a request, because the
 * opportunity values on this page go through the same masking rule as every
 * other read path (F1.4).
 */
export async function customerView(
  auth: AuthContext,
  contactId: Types.ObjectId,
  permissions: ReadonlySet<Permission>,
  activityLimit = 25,
): Promise<CustomerView> {
  const contact = await ContactModel.findOne({
    _id: contactId,
    workspaceId: auth.workspaceId,
  }).lean();

  // Checked first, so another workspace's id is a 404 rather than a page of
  // empty sections that reads like a real but inactive contact (F1.6).
  if (contact === null) throw notFound('That contact does not exist.');

  const [company, opportunities, membership, activity] = await Promise.all([
    contact.companyId === null
      ? Promise.resolve(null)
      : CompanyModel.findOne({ _id: contact.companyId, workspaceId: auth.workspaceId }).lean(),

    OpportunityModel.find({ workspaceId: auth.workspaceId, contactId })
      .sort({ createdAt: -1 })
      .lean(),

    contact.ownerMembershipId === null
      ? Promise.resolve(null)
      : MembershipModel.findOne({
          _id: contact.ownerMembershipId,
          workspaceId: auth.workspaceId,
        }).lean(),

    // The contact's timeline includes its opportunities' entries, which is what
    // makes this a complete history rather than only the contact's own edits.
    queryActivity(
      { workspaceId: auth.workspaceId, targetKind: 'contact', targetId: contactId },
      { page: 1, limit: activityLimit },
    ),
  ]);

  const assignedUser =
    membership === null
      ? null
      : await UserModel.findById(membership.userId).select('email name').lean();

  // Stage names, so the page can show where each opportunity sits without the
  // client having to fetch every pipeline.
  const pipelineIds = [
    ...new Set(
      opportunities
        .map((opportunity) => opportunity.pipelineId?.toString())
        .filter((id): id is string => id !== undefined),
    ),
  ];

  const pipelines =
    pipelineIds.length === 0
      ? []
      : await PipelineModel.find({
          _id: { $in: pipelineIds },
          workspaceId: auth.workspaceId,
        })
          .select('name stages')
          .lean();

  const stageNameById = new Map<string, string>();
  const pipelineNameById = new Map<string, string>();
  for (const pipeline of pipelines) {
    pipelineNameById.set(pipeline._id.toString(), pipeline.name);
    for (const stage of pipeline.stages) stageNameById.set(stage.id, stage.name);
  }

  return {
    contact: {
      id: contact._id.toString(),
      firstName: contact.firstName,
      lastName: contact.lastName,
      displayName: contactDisplayName(contact),
      email: contact.email,
      phone: contact.phone,
      tags: contact.tags,
      customFields: contact.customFields,
      optedOutOfMessaging: contact.optedOutOfMessaging,
      lastActivityAt: contact.lastActivityAt?.toISOString() ?? null,
      version: contact.version,
      createdAt: contact.createdAt.toISOString(),
    },

    company:
      company === null
        ? null
        : {
            id: company._id.toString(),
            name: company.name,
            domain: company.domain,
            phone: company.phone,
          },

    assignedEmployee:
      membership === null
        ? null
        : {
            membershipId: membership._id.toString(),
            email: assignedUser?.email ?? '(removed account)',
            name: assignedUser?.name ?? '',
            availabilityStatus: membership.availabilityStatus,
          },

    opportunities: maskOpportunityValues(
      opportunities.map((opportunity) => ({
        id: opportunity._id.toString(),
        name: opportunity.name,
        value: opportunity.value,
        currency: opportunity.currency,
        stageId: opportunity.stageId,
        stageName: stageNameById.get(opportunity.stageId) ?? null,
        stageOutcome: opportunity.stageOutcome,
        pipelineId: opportunity.pipelineId?.toString() ?? null,
        pipelineName:
          opportunity.pipelineId === null
            ? null
            : (pipelineNameById.get(opportunity.pipelineId.toString()) ?? null),
        version: opportunity.version,
        createdAt: opportunity.createdAt.toISOString(),
      })),
      permissions,
    ) as unknown as readonly Record<string, unknown>[],

    conversations: CONVERSATIONS_PENDING,
    payments: PAYMENTS_PENDING,
    appointments: APPOINTMENTS_PENDING,

    activity: activity.items.map((entry) => ({
      id: entry._id.toString(),
      type: entry.type,
      summary: entry.summary,
      targetKind: entry.targetKind,
      targetId: entry.targetId.toString(),
      actor: {
        label: entry.actorLabel,
        membershipId: entry.actorMembershipId?.toString() ?? null,
      },
      payload: entry.payload,
      createdAt: entry.createdAt.toISOString(),
    })),
  };
}
