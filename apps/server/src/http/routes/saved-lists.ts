import {
  FILTER_FIELDS,
  FILTER_OPERATORS,
  maskOpportunityValues,
  PERMISSIONS,
  type Filter,
} from '@ubmp/domain';
import { notFound, paginationQuerySchema } from '@ubmp/shared';
import { Router } from 'express';
import { Types, type Model } from 'mongoose';
import { z } from 'zod';

import { CompanyModel } from '../../db/models/company.js';
import { ContactModel } from '../../db/models/contact.js';
import { OpportunityModel } from '../../db/models/opportunity.js';
import {
  SAVED_LIST_ENTITIES,
  SavedListModel,
  type SavedListDoc,
} from '../../db/models/saved-list.js';
import { assertFilterIsValid, compileFilter } from '../../repositories/filter-compiler.js';
import { authOf, requireSession } from '../middleware/authenticate.js';
import { requirePermission } from '../middleware/require-permission.js';
import { requireParam } from '../params.js';
import type { AuthContext } from '../../services/session-service.js';

/**
 * Filtering and saved lists (F2.6).
 *
 * A saved list stores its filter and is executed on request, so it "updates
 * automatically as records start or stop matching" with nothing to invalidate.
 */
const objectIdSchema = z.string().regex(/^[0-9a-fA-F]{24}$/, 'is not a valid id');

const criterionSchema = z.object({
  field: z.enum(FILTER_FIELDS),
  key: z.string().max(64).optional(),
  operator: z.enum(FILTER_OPERATORS),
  value: z.unknown().optional(),
});

const filterSchema = z.object({
  join: z.enum(['and', 'or']).default('and'),
  criteria: z.array(criterionSchema).max(20).default([]),
});

const savedListSchema = z.object({
  name: z.string().trim().min(1, 'is required').max(100),
  entity: z.enum(SAVED_LIST_ENTITIES),
  pipelineId: objectIdSchema.nullable().optional(),
  filter: filterSchema,
  sharedWithWorkspace: z.boolean().optional(),
});

function savedListView(doc: SavedListDoc) {
  return {
    id: doc._id.toString(),
    name: doc.name,
    entity: doc.entity,
    pipelineId: doc.pipelineId?.toString() ?? null,
    filter: doc.filter,
    sharedWithWorkspace: doc.sharedWithWorkspace,
    createdByMembershipId: doc.createdByMembershipId?.toString() ?? null,
    createdAt: doc.createdAt.toISOString(),
  };
}

/**
 * Runs a filter against one entity's collection.
 *
 * The tenant scope is applied *outside* the compiled filter, so no criterion
 * can widen it (F1.6).
 */
async function runFilter(
  auth: AuthContext,
  entity: SavedListDoc['entity'],
  filter: Filter,
  pipelineId: Types.ObjectId | null,
  pagination: { page: number; limit: number },
): Promise<{ items: Record<string, unknown>[]; total: number }> {
  const compiled = compileFilter(filter);
  const scope: Record<string, unknown> = { workspaceId: auth.workspaceId, ...compiled };

  if (entity === 'opportunity' && pipelineId !== null) {
    scope['pipelineId'] = pipelineId;
  }

  // Dispatched per entity rather than through a union of model types: the
  // three models have different document types, so a union of them has no
  // callable `find`.
  const run = async <TDoc>(
    model: Model<TDoc>,
  ): Promise<{ items: Record<string, unknown>[]; total: number }> => {
    const [items, total] = await Promise.all([
      model
        .find(scope)
        .sort({ createdAt: -1 })
        .skip((pagination.page - 1) * pagination.limit)
        .limit(pagination.limit)
        .lean<Record<string, unknown>[]>(),
      model.countDocuments(scope),
    ]);

    return { items, total };
  };

  if (entity === 'contact') return run(ContactModel);
  if (entity === 'company') return run(CompanyModel);
  return run(OpportunityModel);
}

/** Shapes a record for the wire, applying value masking to opportunities (F1.4). */
function toView(
  entity: SavedListDoc['entity'],
  items: readonly Record<string, unknown>[],
  auth: AuthContext,
): readonly Record<string, unknown>[] {
  const base: Record<string, unknown>[] = items.map(({ _id, __v, ...rest }) => ({
    ...rest,
    id: String(_id),
  }));

  if (entity !== 'opportunity') return base;

  // The masking rule is applied here too, because a saved list is a read path
  // like any other, and a CSV writer or a board is not the only place a value
  // could leak.
  return maskOpportunityValues(
    base.map((item) => ({
      ...item,
      value: typeof item['value'] === 'number' ? item['value'] : null,
      currency: typeof item['currency'] === 'string' ? item['currency'] : null,
    })),
    auth.permissions,
  );
}

export function createSavedListsRouter(): Router {
  const router = Router();

  /** The builder's vocabulary, so it can only offer what the server accepts. */
  router.get(
    '/filters/schema',
    requireSession(),
    requirePermission(PERMISSIONS.CRM_VIEW),
    (_req, res) => {
      res.status(200).json({ fields: FILTER_FIELDS, operators: FILTER_OPERATORS });
    },
  );

  /**
   * Runs a filter without saving it, which is what the builder previews
   * against while the user assembles criteria.
   */
  router.post(
    '/filters/run',
    requireSession(),
    requirePermission(PERMISSIONS.CRM_VIEW),
    async (req, res) => {
      const input = z
        .object({
          entity: z.enum(SAVED_LIST_ENTITIES),
          pipelineId: objectIdSchema.optional(),
          filter: filterSchema,
        })
        .parse(req.body);

      const pagination = paginationQuerySchema.parse(req.query);
      const auth = authOf(req);

      const { items, total } = await runFilter(
        auth,
        input.entity,
        input.filter,
        input.pipelineId === undefined ? null : new Types.ObjectId(input.pipelineId),
        pagination,
      );

      res.status(200).json({
        items: toView(input.entity, items, auth),
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

  router.get(
    '/saved-lists',
    requireSession(),
    requirePermission(PERMISSIONS.CRM_VIEW),
    async (req, res) => {
      const auth = authOf(req);

      const lists = await SavedListModel.find({
        workspaceId: auth.workspaceId,
        // A private list is visible only to its creator.
        $or: [{ sharedWithWorkspace: true }, { createdByMembershipId: auth.membershipId }],
      })
        .sort({ name: 1 })
        .lean();

      res.status(200).json({ savedLists: lists.map(savedListView) });
    },
  );

  router.post(
    '/saved-lists',
    requireSession(),
    requirePermission(PERMISSIONS.CRM_VIEW),
    async (req, res) => {
      const input = savedListSchema.parse(req.body);
      const auth = authOf(req);

      // Validated before it is stored, so an invalid filter never becomes a
      // saved list that fails every time it is opened.
      assertFilterIsValid(input.filter);

      const created = await SavedListModel.create({
        workspaceId: auth.workspaceId,
        name: input.name,
        entity: input.entity,
        pipelineId:
          input.pipelineId === undefined || input.pipelineId === null
            ? null
            : new Types.ObjectId(input.pipelineId),
        filter: input.filter,
        createdByMembershipId: auth.membershipId,
        sharedWithWorkspace: input.sharedWithWorkspace ?? true,
      });

      res.status(201).json(savedListView(created.toObject()));
    },
  );

  /**
   * Opening a saved list runs its stored filter now, which is what makes it
   * update automatically (F2.6).
   */
  router.get(
    '/saved-lists/:listId/results',
    requireSession(),
    requirePermission(PERMISSIONS.CRM_VIEW),
    async (req, res) => {
      const pagination = paginationQuerySchema.parse(req.query);
      const auth = authOf(req);
      const listId = requireParam(req, 'listId');

      if (!Types.ObjectId.isValid(listId)) throw notFound('That list does not exist.');

      const list = await SavedListModel.findOne({
        _id: new Types.ObjectId(listId),
        workspaceId: auth.workspaceId,
        $or: [{ sharedWithWorkspace: true }, { createdByMembershipId: auth.membershipId }],
      }).lean();

      if (list === null) throw notFound('That list does not exist.');

      const { items, total } = await runFilter(
        auth,
        list.entity,
        list.filter,
        list.pipelineId,
        pagination,
      );

      res.status(200).json({
        savedList: savedListView(list),
        items: toView(list.entity, items, auth),
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

  router.patch(
    '/saved-lists/:listId',
    requireSession(),
    requirePermission(PERMISSIONS.CRM_VIEW),
    async (req, res) => {
      const input = z
        .object({
          name: z.string().trim().min(1).max(100).optional(),
          filter: filterSchema.optional(),
          sharedWithWorkspace: z.boolean().optional(),
        })
        .parse(req.body);

      const auth = authOf(req);
      const listId = requireParam(req, 'listId');
      if (!Types.ObjectId.isValid(listId)) throw notFound('That list does not exist.');

      if (input.filter !== undefined) assertFilterIsValid(input.filter);

      const updated = await SavedListModel.findOneAndUpdate(
        { _id: new Types.ObjectId(listId), workspaceId: auth.workspaceId },
        {
          $set: {
            ...(input.name === undefined ? {} : { name: input.name }),
            ...(input.filter === undefined ? {} : { filter: input.filter }),
            ...(input.sharedWithWorkspace === undefined
              ? {}
              : { sharedWithWorkspace: input.sharedWithWorkspace }),
          },
        },
        { new: true },
      ).lean();

      if (updated === null) throw notFound('That list does not exist.');

      res.status(200).json(savedListView(updated));
    },
  );

  router.delete(
    '/saved-lists/:listId',
    requireSession(),
    requirePermission(PERMISSIONS.CRM_VIEW),
    async (req, res) => {
      const auth = authOf(req);
      const listId = requireParam(req, 'listId');
      if (!Types.ObjectId.isValid(listId)) throw notFound('That list does not exist.');

      const result = await SavedListModel.deleteOne({
        _id: new Types.ObjectId(listId),
        workspaceId: auth.workspaceId,
      });

      if (result.deletedCount === 0) throw notFound('That list does not exist.');

      res.status(204).send();
    },
  );

  return router;
}
