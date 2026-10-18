import { AUDIT_EVENT_TYPES } from '@ubmp/domain';
import {
  conflict,
  notFound,
  offsetFor,
  paginate,
  versionConflict,
  type Paginated,
  type PaginationQuery,
} from '@ubmp/shared';
import mongoose, { Types } from 'mongoose';

import { CompanyModel, type CompanyDoc } from '../db/models/company.js';
import { ContactModel, contactDisplayName, type ContactDoc } from '../db/models/contact.js';
import { UserModel } from '../db/models/user.js';
import { recordActivity } from '../repositories/activity-repository.js';
import { appendAuditEvent } from '../repositories/audit-repository.js';
import type { AuthContext } from './session-service.js';

/**
 * Contacts and companies (F2.1).
 *
 * Every mutation does three things in one transaction: change the record, bump
 * its `version`, and write an activity entry (F2.7). Deletions also write an
 * audit entry, because a deleted record cannot show its own history (F4.1).
 *
 * Writes use the record's `version` as a condition, so two people editing the
 * same contact cannot silently overwrite each other (Q4): the second writer is
 * told their copy is stale rather than winning by arriving last.
 */

export interface Actor {
  readonly membershipId: Types.ObjectId;
  readonly userId: Types.ObjectId;
  readonly label: string;
}

export async function actorFor(auth: AuthContext): Promise<Actor> {
  const user = await UserModel.findById(auth.userId).select('email').lean();

  return {
    membershipId: auth.membershipId,
    userId: auth.userId,
    label: user?.email ?? auth.userId.toString(),
  };
}

function objectId(value: string, what = 'That record'): Types.ObjectId {
  if (!Types.ObjectId.isValid(value)) throw notFound(`${what} does not exist.`);
  return new Types.ObjectId(value);
}

/** Lists the field names whose values differ, for the activity payload. */
function changedFields(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);

  return [...keys]
    .filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
    .sort();
}

// ---------------------------------------------------------------------------
// Companies
// ---------------------------------------------------------------------------

export interface CompanyInput {
  readonly name: string;
  readonly domain?: string | null | undefined;
  readonly phone?: string | null | undefined;
  readonly customFields?: Record<string, unknown> | undefined;
}

/**
 * Written out rather than `Partial<CompanyInput>`: with
 * `exactOptionalPropertyTypes`, `Partial` makes a field optional *without*
 * admitting `undefined`, which is exactly what Zod's `.partial()` produces.
 */
export interface CompanyUpdateInput {
  readonly name?: string | undefined;
  readonly domain?: string | null | undefined;
  readonly phone?: string | null | undefined;
  readonly customFields?: Record<string, unknown> | undefined;
  readonly version: number;
}

export async function createCompany(
  auth: AuthContext,
  input: CompanyInput,
  actor: Actor,
): Promise<CompanyDoc> {
  const session = await mongoose.startSession();
  try {
    let created: CompanyDoc | undefined;

    await session.withTransaction(async () => {
      const [company] = await CompanyModel.create(
        [
          {
            workspaceId: auth.workspaceId,
            name: input.name,
            domain: input.domain ?? null,
            phone: input.phone ?? null,
            customFields: input.customFields ?? {},
            ownerMembershipId: auth.membershipId,
            version: 0,
          },
        ],
        { session, ordered: true },
      );
      if (company === undefined) throw new Error('company was not created');

      await recordActivity(
        {
          workspaceId: auth.workspaceId,
          type: 'company.created',
          targetKind: 'company',
          targetId: company._id,
          actor,
          summary: `Created company ${company.name}`,
        },
        session,
      );

      created = company.toObject();
    });

    if (created === undefined) throw new Error('create company produced no result');
    return created;
  } finally {
    await session.endSession();
  }
}

export async function updateCompany(
  auth: AuthContext,
  companyId: string,
  input: CompanyUpdateInput,
  actor: Actor,
): Promise<CompanyDoc> {
  const _id = objectId(companyId, 'That company');
  const existing = await CompanyModel.findOne({ _id, workspaceId: auth.workspaceId }).lean();
  if (existing === null) throw notFound('That company does not exist.');

  const next = {
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.domain === undefined ? {} : { domain: input.domain }),
    ...(input.phone === undefined ? {} : { phone: input.phone }),
    ...(input.customFields === undefined ? {} : { customFields: input.customFields }),
  };

  const session = await mongoose.startSession();
  try {
    let updated: CompanyDoc | undefined;

    await session.withTransaction(async () => {
      // Conditional on the version the caller read (Q4).
      const result = await CompanyModel.findOneAndUpdate(
        { _id, workspaceId: auth.workspaceId, version: input.version },
        { $set: next, $inc: { version: 1 } },
        { new: true, session },
      ).lean();

      if (result === null) throw versionConflict();

      await recordActivity(
        {
          workspaceId: auth.workspaceId,
          type: 'company.updated',
          targetKind: 'company',
          targetId: _id,
          actor,
          summary: `Updated company ${result.name}`,
          payload: {
            changed: changedFields(existing as unknown as Record<string, unknown>, {
              ...existing,
              ...next,
            }),
          },
        },
        session,
      );

      updated = result;
    });

    if (updated === undefined) throw new Error('update company produced no result');
    return updated;
  } finally {
    await session.endSession();
  }
}

/**
 * Deleting a company detaches its contacts rather than removing them, and does
 * so in the same transaction (Q4): a contact pointing at a company that no
 * longer exists is exactly the orphan the requirement forbids, and deleting the
 * people because their employer was removed would lose real customer data.
 */
export async function deleteCompany(
  auth: AuthContext,
  companyId: string,
  actor: Actor,
  requestId?: string,
): Promise<{ detachedContacts: number }> {
  const _id = objectId(companyId, 'That company');
  const existing = await CompanyModel.findOne({ _id, workspaceId: auth.workspaceId }).lean();
  if (existing === null) throw notFound('That company does not exist.');

  const session = await mongoose.startSession();
  try {
    let detachedContacts = 0;

    await session.withTransaction(async () => {
      const detached = await ContactModel.updateMany(
        { workspaceId: auth.workspaceId, companyId: _id },
        { $set: { companyId: null } },
        { session },
      );
      detachedContacts = detached.modifiedCount;

      await CompanyModel.deleteOne({ _id, workspaceId: auth.workspaceId }, { session });

      await appendAuditEvent(
        {
          workspaceId: auth.workspaceId,
          type: AUDIT_EVENT_TYPES.COMPANY_DELETED,
          actor: {
            kind: 'user',
            userId: actor.userId,
            membershipId: actor.membershipId,
            label: actor.label,
          },
          target: { kind: 'company', id: companyId, label: existing.name },
          before: { name: existing.name },
          after: { detachedContacts },
          ...(requestId === undefined ? {} : { requestId }),
        },
        session,
      );
    });

    return { detachedContacts };
  } finally {
    await session.endSession();
  }
}

export interface CompanyListQuery {
  readonly search?: string | undefined;
}

export async function listCompanies(
  auth: AuthContext,
  query: CompanyListQuery,
  pagination: PaginationQuery,
): Promise<Paginated<CompanyDoc>> {
  const filter: Record<string, unknown> = { workspaceId: auth.workspaceId };

  if (query.search !== undefined && query.search.trim() !== '') {
    // Anchored and escaped: an unanchored regex over a large collection cannot
    // use the index, and an unescaped one lets a caller inject a pattern.
    filter['name'] = { $regex: `^${escapeRegex(query.search.trim())}`, $options: 'i' };
  }

  const [items, total] = await Promise.all([
    CompanyModel.find(filter)
      .sort({ name: 1 })
      .skip(offsetFor(pagination))
      .limit(pagination.limit)
      .lean<CompanyDoc[]>(),
    CompanyModel.countDocuments(filter),
  ]);

  return paginate(items, pagination, total);
}

/** Escapes a user-supplied string for safe use inside a regular expression. */
export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------

export interface ContactUpdateInput {
  readonly firstName?: string | undefined;
  readonly lastName?: string | undefined;
  readonly email?: string | null | undefined;
  readonly phone?: string | null | undefined;
  readonly companyId?: string | null | undefined;
  readonly tags?: readonly string[] | undefined;
  readonly ownerMembershipId?: string | null | undefined;
  readonly customFields?: Record<string, unknown> | undefined;
  readonly version: number;
}

export interface ContactInput {
  readonly firstName: string;
  readonly lastName?: string | undefined;
  readonly email?: string | null | undefined;
  readonly phone?: string | null | undefined;
  readonly companyId?: string | null | undefined;
  readonly tags?: readonly string[] | undefined;
  readonly ownerMembershipId?: string | null | undefined;
  readonly customFields?: Record<string, unknown> | undefined;
}

/** A company id from another workspace must not be attachable (F1.6). */
async function resolveCompanyId(
  workspaceId: Types.ObjectId,
  companyId: string | null | undefined,
): Promise<Types.ObjectId | null> {
  if (companyId === undefined || companyId === null) return null;

  const _id = objectId(companyId, 'That company');
  const found = await CompanyModel.countDocuments({ _id, workspaceId });
  if (found === 0) throw notFound('That company does not exist.');

  return _id;
}

export async function createContact(
  auth: AuthContext,
  input: ContactInput,
  actor: Actor,
): Promise<ContactDoc> {
  const companyId = await resolveCompanyId(auth.workspaceId, input.companyId);

  const session = await mongoose.startSession();
  try {
    let created: ContactDoc | undefined;

    await session.withTransaction(async () => {
      const [contact] = await ContactModel.create(
        [
          {
            workspaceId: auth.workspaceId,
            companyId,
            firstName: input.firstName,
            lastName: input.lastName ?? '',
            email: input.email ?? null,
            phone: input.phone ?? null,
            tags: input.tags === undefined ? [] : [...new Set(input.tags)],
            ownerMembershipId:
              input.ownerMembershipId === undefined || input.ownerMembershipId === null
                ? auth.membershipId
                : objectId(input.ownerMembershipId, 'That member'),
            customFields: input.customFields ?? {},
            version: 0,
          },
        ],
        { session, ordered: true },
      );
      if (contact === undefined) throw new Error('contact was not created');

      await recordActivity(
        {
          workspaceId: auth.workspaceId,
          type: 'contact.created',
          targetKind: 'contact',
          targetId: contact._id,
          contactId: contact._id,
          actor,
          summary: `Created contact ${contactDisplayName(contact)}`,
        },
        session,
      );

      created = contact.toObject();
    });

    if (created === undefined) throw new Error('create contact produced no result');
    return created;
  } finally {
    await session.endSession();
  }
}

export async function updateContact(
  auth: AuthContext,
  contactId: string,
  input: ContactUpdateInput,
  actor: Actor,
): Promise<ContactDoc> {
  const _id = objectId(contactId, 'That contact');
  const existing = await ContactModel.findOne({ _id, workspaceId: auth.workspaceId }).lean();
  if (existing === null) throw notFound('That contact does not exist.');

  const companyId =
    input.companyId === undefined
      ? undefined
      : await resolveCompanyId(auth.workspaceId, input.companyId);

  const next: Record<string, unknown> = {
    ...(input.firstName === undefined ? {} : { firstName: input.firstName }),
    ...(input.lastName === undefined ? {} : { lastName: input.lastName }),
    ...(input.email === undefined ? {} : { email: input.email }),
    ...(input.phone === undefined ? {} : { phone: input.phone }),
    ...(companyId === undefined ? {} : { companyId }),
    ...(input.tags === undefined ? {} : { tags: [...new Set(input.tags)] }),
    ...(input.customFields === undefined ? {} : { customFields: input.customFields }),
    ...(input.ownerMembershipId === undefined
      ? {}
      : {
          ownerMembershipId:
            input.ownerMembershipId === null
              ? null
              : objectId(input.ownerMembershipId, 'That member'),
        }),
  };

  const session = await mongoose.startSession();
  try {
    let updated: ContactDoc | undefined;

    await session.withTransaction(async () => {
      const result = await ContactModel.findOneAndUpdate(
        { _id, workspaceId: auth.workspaceId, version: input.version },
        { $set: next, $inc: { version: 1 } },
        { new: true, session },
      ).lean();

      if (result === null) throw versionConflict();

      const changed = changedFields(existing as unknown as Record<string, unknown>, {
        ...existing,
        ...next,
      });

      await recordActivity(
        {
          workspaceId: auth.workspaceId,
          type: 'contact.updated',
          targetKind: 'contact',
          targetId: _id,
          contactId: _id,
          actor,
          summary: `Updated ${changed.join(', ')} on ${contactDisplayName(result)}`,
          payload: { changed },
        },
        session,
      );

      updated = result;
    });

    if (updated === undefined) throw new Error('update contact produced no result');
    return updated;
  } finally {
    await session.endSession();
  }
}

/**
 * Deleting a contact is refused while it still holds opportunities, with the
 * count reported (Q4).
 *
 * Cascading would silently destroy pipeline value and revenue history; leaving
 * the opportunities behind would orphan them. Refusing and saying how many is
 * the only option that loses nothing, and the same shape as the populated-stage
 * rule in F2.5.
 */
export async function deleteContact(
  auth: AuthContext,
  contactId: string,
  actor: Actor,
  countOpportunities: (contactId: Types.ObjectId) => Promise<number>,
  requestId?: string,
): Promise<void> {
  const _id = objectId(contactId, 'That contact');
  const existing = await ContactModel.findOne({ _id, workspaceId: auth.workspaceId }).lean();
  if (existing === null) throw notFound('That contact does not exist.');

  const openOpportunities = await countOpportunities(_id);
  if (openOpportunities > 0) {
    throw conflict(
      `That contact still has ${String(openOpportunities)} ${
        openOpportunities === 1 ? 'opportunity' : 'opportunities'
      }.`,
      {
        hint: 'Move or delete them first, so no opportunity is left without a customer.',
        details: { opportunityCount: openOpportunities },
      },
    );
  }

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      await ContactModel.deleteOne({ _id, workspaceId: auth.workspaceId }, { session });

      await appendAuditEvent(
        {
          workspaceId: auth.workspaceId,
          type: AUDIT_EVENT_TYPES.CONTACT_DELETED,
          actor: {
            kind: 'user',
            userId: actor.userId,
            membershipId: actor.membershipId,
            label: actor.label,
          },
          target: { kind: 'contact', id: contactId, label: contactDisplayName(existing) },
          before: { name: contactDisplayName(existing), email: existing.email },
          ...(requestId === undefined ? {} : { requestId }),
        },
        session,
      );
    });
  } finally {
    await session.endSession();
  }
}

export async function findContact(auth: AuthContext, contactId: string): Promise<ContactDoc> {
  const _id = objectId(contactId, 'That contact');
  const contact = await ContactModel.findOne({ _id, workspaceId: auth.workspaceId }).lean();

  if (contact === null) throw notFound('That contact does not exist.');
  return contact;
}
