import { PERMISSIONS } from '@ubmp/domain';
import { paginationQuerySchema } from '@ubmp/shared';
import { Router } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';

import { CompanyModel, type CompanyDoc } from '../../db/models/company.js';
import { ContactModel, type ContactDoc } from '../../db/models/contact.js';
import { OpportunityModel } from '../../db/models/opportunity.js';
import { queryActivity } from '../../repositories/activity-repository.js';
import {
  actorFor,
  createCompany,
  createContact,
  deleteCompany,
  deleteContact,
  escapeRegex,
  findContact,
  listCompanies,
  updateCompany,
  updateContact,
} from '../../services/crm-service.js';
import { authOf, requireSession } from '../middleware/authenticate.js';
import { requirePermission } from '../middleware/require-permission.js';
import { requireParam } from '../params.js';

/**
 * Contacts and companies (F2.1).
 *
 * Every write takes the `version` the caller read and is refused if the record
 * moved underneath them (Q4), so the client must send it back rather than
 * last-write-wins.
 */
const objectIdSchema = z.string().regex(/^[0-9a-fA-F]{24}$/, 'is not a valid id');

const companySchema = z.object({
  name: z.string().trim().min(1, 'is required').max(200),
  domain: z.string().trim().max(253).nullable().optional(),
  phone: z.string().trim().max(40).nullable().optional(),
  customFields: z.record(z.string(), z.unknown()).optional(),
});

const contactSchema = z.object({
  firstName: z.string().trim().min(1, 'is required').max(100),
  lastName: z.string().trim().max(100).optional(),
  email: z.string().trim().email('is not a valid email address').max(320).nullable().optional(),
  phone: z.string().trim().max(40).nullable().optional(),
  companyId: objectIdSchema.nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(50)).max(50).optional(),
  ownerMembershipId: objectIdSchema.nullable().optional(),
  customFields: z.record(z.string(), z.unknown()).optional(),
});

const versionSchema = z.object({ version: z.coerce.number().int().min(0) });

function companyView(doc: CompanyDoc) {
  return {
    id: doc._id.toString(),
    name: doc.name,
    domain: doc.domain,
    phone: doc.phone,
    customFields: doc.customFields,
    version: doc.version,
    createdAt: doc.createdAt.toISOString(),
  };
}

function contactView(doc: ContactDoc) {
  return {
    id: doc._id.toString(),
    companyId: doc.companyId?.toString() ?? null,
    firstName: doc.firstName,
    lastName: doc.lastName,
    email: doc.email,
    phone: doc.phone,
    tags: doc.tags,
    ownerMembershipId: doc.ownerMembershipId?.toString() ?? null,
    customFields: doc.customFields,
    optedOutOfMessaging: doc.optedOutOfMessaging,
    lastActivityAt: doc.lastActivityAt?.toISOString() ?? null,
    version: doc.version,
    createdAt: doc.createdAt.toISOString(),
  };
}

export function createCrmRouter(): Router {
  const router = Router();

  // -------------------------------------------------------------------------
  // Companies
  // -------------------------------------------------------------------------

  router.get(
    '/companies',
    requireSession(),
    requirePermission(PERMISSIONS.CRM_VIEW),
    async (req, res) => {
      const pagination = paginationQuerySchema.parse(req.query);
      const { search } = z.object({ search: z.string().max(200).optional() }).parse(req.query);

      const page = await listCompanies(authOf(req), { search }, pagination);

      res.status(200).json({ items: page.items.map(companyView), pageInfo: page.pageInfo });
    },
  );

  router.post(
    '/companies',
    requireSession(),
    requirePermission(PERMISSIONS.CRM_CREATE),
    async (req, res) => {
      const input = companySchema.parse(req.body);
      const auth = authOf(req);

      const company = await createCompany(auth, input, await actorFor(auth));

      res.status(201).json(companyView(company));
    },
  );

  router.patch(
    '/companies/:companyId',
    requireSession(),
    requirePermission(PERMISSIONS.CRM_EDIT),
    async (req, res) => {
      const input = companySchema.partial().merge(versionSchema).parse(req.body);
      const auth = authOf(req);

      const company = await updateCompany(
        auth,
        requireParam(req, 'companyId'),
        input,
        await actorFor(auth),
      );

      res.status(200).json(companyView(company));
    },
  );

  router.delete(
    '/companies/:companyId',
    requireSession(),
    requirePermission(PERMISSIONS.CRM_DELETE),
    async (req, res) => {
      const auth = authOf(req);

      const result = await deleteCompany(
        auth,
        requireParam(req, 'companyId'),
        await actorFor(auth),
        req.id,
      );

      // Reported, so the caller can tell the user how many contacts changed.
      res.status(200).json(result);
    },
  );

  // -------------------------------------------------------------------------
  // Contacts
  // -------------------------------------------------------------------------

  /**
   * The contacts list, with search and the simple filters (F2.6). The full
   * saved-list query DSL is a separate endpoint, added in the filters module.
   */
  router.get(
    '/contacts',
    requireSession(),
    requirePermission(PERMISSIONS.CRM_VIEW),
    async (req, res) => {
      const pagination = paginationQuerySchema.parse(req.query);
      const query = z
        .object({
          search: z.string().max(200).optional(),
          companyId: objectIdSchema.optional(),
          ownerMembershipId: objectIdSchema.optional(),
          tag: z.string().max(50).optional(),
        })
        .parse(req.query);

      const auth = authOf(req);
      const filter: Record<string, unknown> = { workspaceId: auth.workspaceId };

      if (query.companyId !== undefined) filter['companyId'] = new Types.ObjectId(query.companyId);
      if (query.ownerMembershipId !== undefined) {
        filter['ownerMembershipId'] = new Types.ObjectId(query.ownerMembershipId);
      }
      if (query.tag !== undefined) filter['tags'] = query.tag;

      if (query.search !== undefined && query.search.trim() !== '') {
        // Escaped, so a caller cannot inject a pattern that scans the
        // collection; anchored on name, matched loosely on email and phone.
        const pattern = escapeRegex(query.search.trim());
        filter['$or'] = [
          { firstName: { $regex: `^${pattern}`, $options: 'i' } },
          { lastName: { $regex: `^${pattern}`, $options: 'i' } },
          { email: { $regex: pattern, $options: 'i' } },
          { phone: { $regex: pattern, $options: 'i' } },
        ];
      }

      const [items, total] = await Promise.all([
        ContactModel.find(filter)
          .sort({ createdAt: -1 })
          .skip((pagination.page - 1) * pagination.limit)
          .limit(pagination.limit)
          .lean<ContactDoc[]>(),
        ContactModel.countDocuments(filter),
      ]);

      res.status(200).json({
        items: items.map(contactView),
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

  router.post(
    '/contacts',
    requireSession(),
    requirePermission(PERMISSIONS.CRM_CREATE),
    async (req, res) => {
      const input = contactSchema.parse(req.body);
      const auth = authOf(req);

      const contact = await createContact(auth, input, await actorFor(auth));

      res.status(201).json(contactView(contact));
    },
  );

  router.get(
    '/contacts/:contactId',
    requireSession(),
    requirePermission(PERMISSIONS.CRM_VIEW),
    async (req, res) => {
      const auth = authOf(req);
      const contact = await findContact(auth, requireParam(req, 'contactId'));

      const company =
        contact.companyId === null
          ? null
          : await CompanyModel.findOne({
              _id: contact.companyId,
              workspaceId: auth.workspaceId,
            }).lean();

      res.status(200).json({
        contact: contactView(contact),
        company: company === null ? null : companyView(company),
      });
    },
  );

  router.patch(
    '/contacts/:contactId',
    requireSession(),
    requirePermission(PERMISSIONS.CRM_EDIT),
    async (req, res) => {
      const input = contactSchema.partial().merge(versionSchema).parse(req.body);
      const auth = authOf(req);

      const contact = await updateContact(
        auth,
        requireParam(req, 'contactId'),
        input,
        await actorFor(auth),
      );

      res.status(200).json(contactView(contact));
    },
  );

  router.delete(
    '/contacts/:contactId',
    requireSession(),
    requirePermission(PERMISSIONS.CRM_DELETE),
    async (req, res) => {
      const auth = authOf(req);

      await deleteContact(
        auth,
        requireParam(req, 'contactId'),
        await actorFor(auth),
        // Counted here rather than inside the service, so the domain rule does
        // not reach across to another collection itself.
        (contactId) =>
          OpportunityModel.countDocuments({ workspaceId: auth.workspaceId, contactId }),
        req.id,
      );

      res.status(204).send();
    },
  );

  /** The activity timeline for one record (F2.7). */
  router.get(
    '/contacts/:contactId/activity',
    requireSession(),
    requirePermission(PERMISSIONS.CRM_VIEW),
    async (req, res) => {
      const pagination = paginationQuerySchema.parse(req.query);
      const auth = authOf(req);

      // Reads the contact first, so another workspace's id is a 404 rather than
      // an empty timeline that looks like a record with no history (F1.6).
      const contact = await findContact(auth, requireParam(req, 'contactId'));

      const page = await queryActivity(
        { workspaceId: auth.workspaceId, targetKind: 'contact', targetId: contact._id },
        pagination,
      );

      res.status(200).json({
        items: page.items.map((entry) => ({
          id: entry._id.toString(),
          type: entry.type,
          summary: entry.summary,
          actor: {
            label: entry.actorLabel,
            membershipId: entry.actorMembershipId?.toString() ?? null,
          },
          payload: entry.payload,
          createdAt: entry.createdAt.toISOString(),
        })),
        pageInfo: page.pageInfo,
      });
    },
  );

  return router;
}
