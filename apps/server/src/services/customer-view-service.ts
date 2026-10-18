import { maskOpportunityValues, type Permission } from '@ubmp/domain';
import { notFound } from '@ubmp/shared';
import type { Types } from 'mongoose';

import { CompanyModel } from '../db/models/company.js';
import { ContactModel, contactDisplayName } from '../db/models/contact.js';
import { MembershipModel } from '../db/models/membership.js';
import { OpportunityModel } from '../db/models/opportunity.js';
import { PipelineModel } from '../db/models/pipeline.js';
import { UserModel } from '../db/models/user.js';
import { AppointmentModel } from '../db/models/appointment.js';
import { ConversationModel } from '../db/models/conversation.js';
import { PaymentModel } from '../db/models/payment.js';
import { queryActivity } from '../repositories/activity-repository.js';
import { appointmentViews } from './calendar-service.js';
import { canSeeAllConversations, conversationViews } from './messaging-service.js';
import { paymentViews } from './payment-service.js';
import type { AuthContext } from './session-service.js';

/**
 * The complete customer view (F2.8): "one contact page shows conversations,
 * opportunities, payments, appointments, the assigned employee and the activity
 * history".
 *
 * Assembled in one place, and in one round of parallel queries, so the page is
 * a single request rather than six that each have to re-check the workspace.
 *
 * Conversations, payments and appointments come from the messaging, payment
 * and calendar integrations; an empty section carries a `reason` the page
 * shows instead of a blank area (Q10).
 */

/** A section of the page fed by an integration (I1, I2, I3). */
export interface IntegrationSection {
  readonly items: readonly Record<string, unknown>[];
  /** Kept for the response shape; integrations are live, so always null. */
  readonly availableFrom: null;
  readonly reason: string | null;
}

function section(
  items: readonly Record<string, unknown>[],
  emptyReason: string,
): IntegrationSection {
  return { items, availableFrom: null, reason: items.length === 0 ? emptyReason : null };
}

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
  readonly conversations: IntegrationSection;
  readonly payments: IntegrationSection;
  readonly appointments: IntegrationSection;
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

  const conversationFilter: Record<string, unknown> = {
    workspaceId: auth.workspaceId,
    contactId,
    // The same visibility rule as the conversations list (I1.6).
    ...(canSeeAllConversations(auth) ? {} : { assigneeMembershipId: auth.membershipId }),
  };

  const [company, opportunities, membership, activity, conversations, payments, appointments] =
    await Promise.all([
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
      ConversationModel.find(conversationFilter).sort({ lastMessageAt: -1 }).limit(20).lean(),
      PaymentModel.find({ workspaceId: auth.workspaceId, contactId })
        .sort({ createdAt: -1 })
        .limit(50)
        .lean(),
      AppointmentModel.find({ workspaceId: auth.workspaceId, contactId })
        .sort({ startsAt: -1 })
        .limit(50)
        .lean(),
    ]);

  const [conversationItems, paymentItems, appointmentItems] = await Promise.all([
    conversationViews(auth.workspaceId, conversations),
    paymentViews(auth.workspaceId, payments),
    appointmentViews(auth.workspaceId, appointments),
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
      companyId: contact.companyId?.toString() ?? null,
      ownerMembershipId: contact.ownerMembershipId?.toString() ?? null,
      firstName: contact.firstName,
      lastName: contact.lastName,
      displayName: contactDisplayName(contact),
      email: contact.email,
      phone: contact.phone,
      tags: contact.tags,
      // Mongoose drops empty objects on save, so an untouched map reads back missing.
      customFields: contact.customFields ?? {},
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

    conversations: section(conversationItems, 'No conversations with this contact yet.'),
    payments: section(paymentItems, 'No payment requests for this contact yet.'),
    appointments: section(appointmentItems, 'No appointments with this contact yet.'),

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
      payload: entry.payload ?? {},
      createdAt: entry.createdAt.toISOString(),
    })),
  };
}
