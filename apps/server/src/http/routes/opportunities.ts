import {
  maskOpportunityValue,
  maskOpportunityValues,
  opportunityValueExportCell,
  PERMISSIONS,
} from '@ubmp/domain';
import { paginationQuerySchema } from '@ubmp/shared';
import { Router } from 'express';
import { z } from 'zod';

import { OpportunityModel, type OpportunityDoc } from '../../db/models/opportunity.js';
import { scoped } from '../../repositories/scoped.js';
import { requireParam } from '../params.js';
import { authOf, requireSession } from '../middleware/authenticate.js';
import { requirePermission } from '../middleware/require-permission.js';

/**
 * Opportunities, in the minimal form P2 needs to demonstrate field-level
 * protection (F1.4). P3 turns this into the real CRM resource.
 *
 * All three read paths — list, detail and export — go through the domain's
 * masking functions, so a reader without `opportunity.value.view` never
 * receives the number from any of them.
 */
const createSchema = z.object({
  name: z.string().trim().min(1, 'is required').max(200),
  value: z.number().int().min(0).nullable().optional(),
  currency: z.string().trim().length(3).nullable().optional(),
  stageId: z.string().trim().min(1).max(64).default('qualify'),
  stageOutcome: z.enum(['open', 'won', 'lost']).default('open'),
});

/** The shape sent to the browser, before masking is applied. */
function toView(doc: OpportunityDoc) {
  return {
    id: doc._id.toString(),
    name: doc.name,
    value: doc.value,
    currency: doc.currency,
    stageId: doc.stageId,
    stageOutcome: doc.stageOutcome,
    version: doc.version,
  };
}

/** Minimal RFC 4180 quoting, so a name containing a comma cannot shift columns. */
function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function createOpportunitiesRouter(): Router {
  const router = Router();

  router.post(
    '/opportunities',
    requireSession(),
    requirePermission(PERMISSIONS.CRM_CREATE),
    async (req, res) => {
      const input = createSchema.parse(req.body);
      const auth = authOf(req);
      const repository = scoped(OpportunityModel, { workspaceId: auth.workspaceId });

      const created = await repository.create({
        name: input.name,
        value: input.value ?? null,
        currency: input.currency ?? null,
        stageId: input.stageId,
        stageOutcome: input.stageOutcome,
        ownerMembershipId: auth.membershipId,
        version: 0,
      });

      res.status(201).json(maskOpportunityValue(toView(created), auth.permissions));
    },
  );

  // The list path (F1.4), paginated (Q9).
  router.get(
    '/opportunities',
    requireSession(),
    requirePermission(PERMISSIONS.CRM_VIEW),
    async (req, res) => {
      const pagination = paginationQuerySchema.parse(req.query);
      const auth = authOf(req);
      const repository = scoped(OpportunityModel, { workspaceId: auth.workspaceId });

      const [docs, total] = await Promise.all([
        repository.find(
          {},
          {
            sort: { createdAt: -1 },
            skip: (pagination.page - 1) * pagination.limit,
            limit: pagination.limit,
          },
        ),
        repository.count(),
      ]);

      res.status(200).json({
        items: maskOpportunityValues(docs.map(toView), auth.permissions),
        pageInfo: {
          page: pagination.page,
          limit: pagination.limit,
          total,
          totalPages: total === 0 ? 0 : Math.ceil(total / pagination.limit),
        },
      });
    },
  );

  // The detail path (F1.4). Scoped lookup, so another workspace's id is a 404
  // rather than a record (F1.6, Q2).
  router.get(
    '/opportunities/:opportunityId',
    requireSession(),
    requirePermission(PERMISSIONS.CRM_VIEW),
    async (req, res) => {
      const auth = authOf(req);
      const repository = scoped(OpportunityModel, { workspaceId: auth.workspaceId });

      const doc = await repository.findByIdOrFail(requireParam(req, 'opportunityId'));

      res.status(200).json(maskOpportunityValue(toView(doc), auth.permissions));
    },
  );

  // The export path (F1.4). Needs the export permission as well as view.
  router.get(
    '/opportunities/export/csv',
    requireSession(),
    requirePermission(PERMISSIONS.CRM_VIEW, PERMISSIONS.CRM_EXPORT),
    async (req, res) => {
      const auth = authOf(req);
      const repository = scoped(OpportunityModel, { workspaceId: auth.workspaceId });

      const docs = await repository.find({}, { sort: { createdAt: -1 }, limit: 5_000 });

      const rows = [
        'name,value,currency,stage',
        ...docs.map((doc) =>
          [
            csvCell(doc.name),
            // The value never comes from doc.value directly: the masking rule
            // owns what goes in this cell.
            csvCell(opportunityValueExportCell(doc, auth.permissions)),
            csvCell(doc.currency ?? ''),
            csvCell(doc.stageId),
          ].join(','),
        ),
      ];

      res
        .status(200)
        .type('text/csv')
        .send(`${rows.join('\n')}\n`);
    },
  );

  return router;
}
