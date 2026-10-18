import {
  CUSTOM_FIELD_ENTITIES,
  CUSTOM_FIELD_TYPES,
  customFieldKeySchema,
  maskOpportunityValue,
  maskOpportunityValues,
  opportunityValueExportCell,
  PERMISSIONS,
  STAGE_OUTCOMES,
} from '@ubmp/domain';
import { paginationQuerySchema } from '@ubmp/shared';
import { Router } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';

import { OpportunityModel, type OpportunityDoc } from '../../db/models/opportunity.js';
import type { PipelineDoc } from '../../db/models/pipeline.js';
import { actorFor } from '../../services/crm-service.js';
import {
  createOpportunity,
  findOpportunity,
  moveOpportunityToStage,
  updateOpportunity,
} from '../../services/opportunity-service.js';
import {
  addPipelineStage,
  createCustomField,
  createPipeline,
  definitionsFor,
  deleteCustomField,
  deletePipelineStage,
  findPipeline,
  listPipelines,
  renamePipelineStage,
  reorderPipelineStages,
} from '../../services/pipeline-service.js';
import { authOf, requireSession } from '../middleware/authenticate.js';
import { requirePermission } from '../middleware/require-permission.js';
import { requireParam } from '../params.js';

/**
 * Pipelines, stages, custom field definitions and opportunities
 * (F2.2 - F2.5).
 *
 * Configuration is behind `assignment_rules.manage`, the workspace
 * configuration permission; records are behind the CRM permissions. A User who
 * may edit opportunities therefore cannot redefine the pipeline they move
 * through.
 */
const objectIdSchema = z.string().regex(/^[0-9a-fA-F]{24}$/, 'is not a valid id');

const stageSchema = z.object({
  name: z.string().trim().min(1, 'is required').max(100),
  outcome: z.enum(STAGE_OUTCOMES).default('open'),
});

const fieldSchema = z.object({
  entity: z.enum(CUSTOM_FIELD_ENTITIES),
  pipelineId: objectIdSchema.nullable().optional(),
  key: customFieldKeySchema,
  label: z.string().trim().min(1, 'is required').max(100),
  type: z.enum(CUSTOM_FIELD_TYPES),
  options: z.array(z.string().trim().min(1).max(100)).max(100).optional(),
  required: z.boolean().optional(),
  requiredInStageIds: z.array(z.string().max(64)).max(50).optional(),
});

const opportunitySchema = z.object({
  name: z.string().trim().min(1, 'is required').max(200),
  contactId: objectIdSchema,
  pipelineId: objectIdSchema.optional(),
  stageId: z.string().max(64).optional(),
  value: z.number().int().min(0).nullable().optional(),
  currency: z.string().trim().length(3).nullable().optional(),
  customFields: z.record(z.string(), z.unknown()).optional(),
});

const moveSchema = z.object({
  stageId: z.string().min(1, 'is required').max(64),
  version: z.number().int().min(0),
  customFields: z.record(z.string(), z.unknown()).optional(),
});

function pipelineView(doc: PipelineDoc) {
  return {
    id: doc._id.toString(),
    name: doc.name,
    isDefault: doc.isDefault,
    stages: doc.stages.map((stage) => ({
      id: stage.id,
      name: stage.name,
      position: stage.position,
      outcome: stage.outcome,
    })),
    version: doc.version,
  };
}

function opportunityView(doc: OpportunityDoc) {
  return {
    id: doc._id.toString(),
    contactId: doc.contactId?.toString() ?? null,
    pipelineId: doc.pipelineId?.toString() ?? null,
    name: doc.name,
    value: doc.value,
    currency: doc.currency,
    stageId: doc.stageId,
    stageOutcome: doc.stageOutcome,
    ownerMembershipId: doc.ownerMembershipId?.toString() ?? null,
    customFields: doc.customFields,
    version: doc.version,
    createdAt: doc.createdAt.toISOString(),
  };
}

/** Minimal RFC 4180 quoting, so a name containing a comma cannot shift columns. */
function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function createPipelinesRouter(): Router {
  const router = Router();

  // -------------------------------------------------------------------------
  // Pipelines and stages (F2.5)
  // -------------------------------------------------------------------------

  router.get(
    '/pipelines',
    requireSession(),
    requirePermission(PERMISSIONS.CRM_VIEW),
    async (req, res) => {
      const pipelines = await listPipelines(authOf(req));

      res.status(200).json({ pipelines: pipelines.map(pipelineView) });
    },
  );

  router.post(
    '/pipelines',
    requireSession(),
    requirePermission(PERMISSIONS.ASSIGNMENT_RULES_MANAGE),
    async (req, res) => {
      const input = z
        .object({
          name: z.string().trim().min(1, 'is required').max(100),
          stageNames: z.array(z.string().trim().min(1).max(100)).max(30).optional(),
        })
        .parse(req.body);

      const pipeline = await createPipeline(authOf(req), input, req.id);

      res.status(201).json(pipelineView(pipeline));
    },
  );

  router.get(
    '/pipelines/:pipelineId',
    requireSession(),
    requirePermission(PERMISSIONS.CRM_VIEW),
    async (req, res) => {
      const auth = authOf(req);
      const pipeline = await findPipeline(auth, requireParam(req, 'pipelineId'));

      // The definitions are served with the pipeline, so a form can be built
      // from one response (F2.2, F2.3).
      const definitions = await definitionsFor(auth, 'opportunity', pipeline._id);

      res.status(200).json({
        pipeline: pipelineView(pipeline),
        customFields: definitions.map((definition) => ({
          id: definition._id.toString(),
          key: definition.key,
          label: definition.label,
          type: definition.type,
          options: definition.options,
          required: definition.required,
          requiredInStageIds: definition.requiredInStageIds,
        })),
      });
    },
  );

  router.post(
    '/pipelines/:pipelineId/stages',
    requireSession(),
    requirePermission(PERMISSIONS.ASSIGNMENT_RULES_MANAGE),
    async (req, res) => {
      const input = stageSchema.parse(req.body);

      const pipeline = await addPipelineStage(
        authOf(req),
        requireParam(req, 'pipelineId'),
        input,
        req.id,
      );

      res.status(201).json(pipelineView(pipeline));
    },
  );

  /** Reorder is its own path, so it cannot collide with a stage named "reorder". */
  router.patch(
    '/pipelines/:pipelineId/stage-order',
    requireSession(),
    requirePermission(PERMISSIONS.ASSIGNMENT_RULES_MANAGE),
    async (req, res) => {
      const { stageIds } = z
        .object({ stageIds: z.array(z.string().max(64)).min(1).max(50) })
        .parse(req.body);

      const pipeline = await reorderPipelineStages(
        authOf(req),
        requireParam(req, 'pipelineId'),
        stageIds,
        req.id,
      );

      res.status(200).json(pipelineView(pipeline));
    },
  );

  router.patch(
    '/pipelines/:pipelineId/stages/:stageId',
    requireSession(),
    requirePermission(PERMISSIONS.ASSIGNMENT_RULES_MANAGE),
    async (req, res) => {
      const input = z
        .object({
          name: z.string().trim().min(1).max(100).optional(),
          outcome: z.enum(STAGE_OUTCOMES).optional(),
        })
        .refine((value) => Object.keys(value).length > 0, {
          message: 'provide a name or an outcome',
        })
        .parse(req.body);

      const pipeline = await renamePipelineStage(
        authOf(req),
        requireParam(req, 'pipelineId'),
        requireParam(req, 'stageId'),
        input,
        req.id,
      );

      res.status(200).json(pipelineView(pipeline));
    },
  );

  router.delete(
    '/pipelines/:pipelineId/stages/:stageId',
    requireSession(),
    requirePermission(PERMISSIONS.ASSIGNMENT_RULES_MANAGE),
    async (req, res) => {
      const { moveToStageId } = z
        .object({ moveToStageId: z.string().max(64).optional() })
        .parse(req.query);

      const result = await deletePipelineStage(
        authOf(req),
        requireParam(req, 'pipelineId'),
        requireParam(req, 'stageId'),
        moveToStageId,
        req.id,
      );

      res.status(200).json(result);
    },
  );

  // -------------------------------------------------------------------------
  // Custom field definitions (F2.2)
  // -------------------------------------------------------------------------

  /**
   * The form schema for one entity. A field created through the interface
   * appears here on the next request, with no deployment (F2.2).
   */
  router.get(
    '/custom-fields',
    requireSession(),
    requirePermission(PERMISSIONS.CRM_VIEW),
    async (req, res) => {
      const query = z
        .object({
          entity: z.enum(CUSTOM_FIELD_ENTITIES),
          pipelineId: objectIdSchema.optional(),
        })
        .parse(req.query);

      const auth = authOf(req);
      const definitions = await definitionsFor(
        auth,
        query.entity,
        query.pipelineId === undefined ? null : new Types.ObjectId(query.pipelineId),
      );

      res.status(200).json({
        customFields: definitions.map((definition) => ({
          id: definition._id.toString(),
          entity: definition.entity,
          pipelineId: definition.pipelineId?.toString() ?? null,
          key: definition.key,
          label: definition.label,
          type: definition.type,
          options: definition.options,
          required: definition.required,
          requiredInStageIds: definition.requiredInStageIds,
          position: definition.position,
        })),
      });
    },
  );

  router.post(
    '/custom-fields',
    requireSession(),
    requirePermission(PERMISSIONS.ASSIGNMENT_RULES_MANAGE),
    async (req, res) => {
      const input = fieldSchema.parse(req.body);

      const definition = await createCustomField(authOf(req), input, req.id);

      res.status(201).json({
        id: definition._id.toString(),
        key: definition.key,
        label: definition.label,
        type: definition.type,
        options: definition.options,
        required: definition.required,
        requiredInStageIds: definition.requiredInStageIds,
      });
    },
  );

  router.delete(
    '/custom-fields/:fieldId',
    requireSession(),
    requirePermission(PERMISSIONS.ASSIGNMENT_RULES_MANAGE),
    async (req, res) => {
      await deleteCustomField(authOf(req), requireParam(req, 'fieldId'), req.id);

      res.status(204).send();
    },
  );

  // -------------------------------------------------------------------------
  // Opportunities
  // -------------------------------------------------------------------------

  router.post(
    '/opportunities',
    requireSession(),
    requirePermission(PERMISSIONS.CRM_CREATE),
    async (req, res) => {
      const input = opportunitySchema.parse(req.body);
      const auth = authOf(req);

      const opportunity = await createOpportunity(auth, input, await actorFor(auth));

      res.status(201).json(maskOpportunityValue(opportunityView(opportunity), auth.permissions));
    },
  );

  router.get(
    '/opportunities',
    requireSession(),
    requirePermission(PERMISSIONS.CRM_VIEW),
    async (req, res) => {
      const pagination = paginationQuerySchema.parse(req.query);
      const query = z
        .object({
          pipelineId: objectIdSchema.optional(),
          contactId: objectIdSchema.optional(),
          stageId: z.string().max(64).optional(),
        })
        .parse(req.query);

      const auth = authOf(req);
      const filter: Record<string, unknown> = { workspaceId: auth.workspaceId };

      if (query.pipelineId !== undefined) {
        filter['pipelineId'] = new Types.ObjectId(query.pipelineId);
      }
      if (query.contactId !== undefined) filter['contactId'] = new Types.ObjectId(query.contactId);
      if (query.stageId !== undefined) filter['stageId'] = query.stageId;

      const [items, total] = await Promise.all([
        OpportunityModel.find(filter)
          .sort({ createdAt: -1 })
          .skip((pagination.page - 1) * pagination.limit)
          .limit(pagination.limit)
          .lean<OpportunityDoc[]>(),
        OpportunityModel.countDocuments(filter),
      ]);

      res.status(200).json({
        // The masking rule is applied on the way out, as on every read path
        // (F1.4).
        items: maskOpportunityValues(items.map(opportunityView), auth.permissions),
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

  /**
   * The export path (F1.4). Registered before `/:opportunityId` so the literal
   * segment is not captured as an id.
   *
   * Needs the export permission as well as view, and writes its value cell
   * through the domain's masking helper rather than reading `doc.value`, so a
   * CSV writer cannot bypass the field-level rule.
   */
  router.get(
    '/opportunities/export/csv',
    requireSession(),
    requirePermission(PERMISSIONS.CRM_VIEW, PERMISSIONS.CRM_EXPORT),
    async (req, res) => {
      const auth = authOf(req);

      const docs = await OpportunityModel.find({ workspaceId: auth.workspaceId })
        .sort({ createdAt: -1 })
        .limit(5_000)
        .lean<OpportunityDoc[]>();

      const rows = [
        'name,value,currency,stage',
        ...docs.map((doc) =>
          [
            csvCell(doc.name),
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

  router.get(
    '/opportunities/:opportunityId',
    requireSession(),
    requirePermission(PERMISSIONS.CRM_VIEW),
    async (req, res) => {
      const auth = authOf(req);
      const opportunity = await findOpportunity(auth, requireParam(req, 'opportunityId'));

      res.status(200).json(maskOpportunityValue(opportunityView(opportunity), auth.permissions));
    },
  );

  router.patch(
    '/opportunities/:opportunityId',
    requireSession(),
    requirePermission(PERMISSIONS.CRM_EDIT),
    async (req, res) => {
      const input = z
        .object({
          name: z.string().trim().min(1).max(200).optional(),
          value: z.number().int().min(0).nullable().optional(),
          currency: z.string().trim().length(3).nullable().optional(),
          customFields: z.record(z.string(), z.unknown()).optional(),
          ownerMembershipId: objectIdSchema.nullable().optional(),
          version: z.number().int().min(0),
        })
        .parse(req.body);

      const auth = authOf(req);
      const opportunity = await updateOpportunity(
        auth,
        requireParam(req, 'opportunityId'),
        input,
        await actorFor(auth),
      );

      res.status(200).json(maskOpportunityValue(opportunityView(opportunity), auth.permissions));
    },
  );

  /**
   * Moving between stages, on the board or in the list (F2.4, F2.5).
   *
   * Refused with the missing fields named if the destination stage requires
   * something the record does not have.
   */
  router.patch(
    '/opportunities/:opportunityId/stage',
    requireSession(),
    requirePermission(PERMISSIONS.CRM_EDIT),
    async (req, res) => {
      const input = moveSchema.parse(req.body);
      const auth = authOf(req);

      const opportunity = await moveOpportunityToStage(
        auth,
        requireParam(req, 'opportunityId'),
        input,
        await actorFor(auth),
      );

      res.status(200).json(maskOpportunityValue(opportunityView(opportunity), auth.permissions));
    },
  );

  return router;
}
