import { randomUUID } from 'node:crypto';

import {
  addStage,
  AUDIT_EVENT_TYPES,
  canDeleteStage,
  DEFAULT_STAGES,
  findStage,
  reorderStages,
  sortedStages,
  type CustomFieldDefinition,
  type CustomFieldEntity,
  type PipelineStage,
  type StageOutcome,
} from '@ubmp/domain';
import { badRequest, conflict, notFound } from '@ubmp/shared';
import mongoose, { type ClientSession, Types } from 'mongoose';

import {
  CustomFieldDefinitionModel,
  type CustomFieldDefinitionDoc,
} from '../db/models/custom-field-definition.js';
import { OpportunityModel } from '../db/models/opportunity.js';
import { PipelineModel, type PipelineDoc } from '../db/models/pipeline.js';
import { UserModel } from '../db/models/user.js';
import { appendAuditEvent } from '../repositories/audit-repository.js';
import type { AuthContext } from './session-service.js';

/**
 * Pipelines, stages and custom field definitions (F2.2 - F2.5).
 *
 * Configuration changes are audited (F4.1), because they change what every
 * record in the workspace means and cannot be seen on any single record.
 */

async function actorLabel(auth: AuthContext): Promise<string> {
  const user = await UserModel.findById(auth.userId).select('email').lean();
  return user?.email ?? auth.userId.toString();
}

function objectId(value: string, what: string): Types.ObjectId {
  if (!Types.ObjectId.isValid(value)) throw notFound(`${what} does not exist.`);
  return new Types.ObjectId(value);
}

async function audit(
  auth: AuthContext,
  type: (typeof AUDIT_EVENT_TYPES)[keyof typeof AUDIT_EVENT_TYPES],
  target: { kind: string; id: string; label: string },
  values: { before?: Record<string, unknown>; after?: Record<string, unknown> },
  session: ClientSession,
  requestId?: string,
): Promise<void> {
  await appendAuditEvent(
    {
      workspaceId: auth.workspaceId,
      type,
      actor: {
        kind: 'user',
        userId: auth.userId,
        membershipId: auth.membershipId,
        label: await actorLabel(auth),
      },
      target,
      ...(values.before === undefined ? {} : { before: values.before }),
      ...(values.after === undefined ? {} : { after: values.after }),
      ...(requestId === undefined ? {} : { requestId }),
    },
    session,
  );
}

// ---------------------------------------------------------------------------
// Pipelines
// ---------------------------------------------------------------------------

/**
 * Creates the pipeline a brand new workspace starts with, so it is usable
 * before an Admin configures anything (F2.5).
 *
 * Called inside the sign-up transaction, so a workspace never exists without
 * somewhere to put an opportunity.
 */
export async function seedDefaultPipeline(
  workspaceId: Types.ObjectId,
  session: ClientSession,
): Promise<PipelineDoc> {
  const [pipeline] = await PipelineModel.create(
    [
      {
        workspaceId,
        name: 'Sales',
        isDefault: true,
        stages: DEFAULT_STAGES.map((stage) => ({ ...stage, id: randomUUID() })),
        version: 0,
      },
    ],
    { session, ordered: true },
  );

  if (pipeline === undefined) throw new Error('default pipeline was not created');
  return pipeline;
}

export async function listPipelines(auth: AuthContext): Promise<readonly PipelineDoc[]> {
  const pipelines = await PipelineModel.find({ workspaceId: auth.workspaceId })
    .sort({ isDefault: -1, name: 1 })
    .lean();

  // Stages are returned in display order, so no caller has to sort them.
  return pipelines.map((pipeline) => ({ ...pipeline, stages: [...sortedStages(pipeline.stages)] }));
}

export async function findPipeline(auth: AuthContext, pipelineId: string): Promise<PipelineDoc> {
  const _id = objectId(pipelineId, 'That pipeline');
  const pipeline = await PipelineModel.findOne({ _id, workspaceId: auth.workspaceId }).lean();

  if (pipeline === null) throw notFound('That pipeline does not exist.');
  return { ...pipeline, stages: [...sortedStages(pipeline.stages)] };
}

/** The pipeline an opportunity lands in when the caller names none. */
export async function defaultPipeline(auth: AuthContext): Promise<PipelineDoc> {
  const pipeline = await PipelineModel.findOne({
    workspaceId: auth.workspaceId,
    isDefault: true,
  }).lean();

  if (pipeline === null) {
    throw notFound('This workspace has no default pipeline.', {
      hint: 'Ask an Admin to create one.',
    });
  }

  return { ...pipeline, stages: [...sortedStages(pipeline.stages)] };
}

export async function createPipeline(
  auth: AuthContext,
  input: { readonly name: string; readonly stageNames?: readonly string[] | undefined },
  requestId?: string,
): Promise<PipelineDoc> {
  const existing = await PipelineModel.findOne({
    workspaceId: auth.workspaceId,
    name: input.name.trim(),
  })
    .select('_id')
    .lean();

  if (existing !== null) throw conflict('A pipeline with that name already exists.');

  // A pipeline given no stages gets the defaults, because a pipeline with no
  // stages could hold nothing.
  const names = input.stageNames ?? [];
  const stages: PipelineStage[] =
    names.length === 0
      ? DEFAULT_STAGES.map((stage) => ({ ...stage, id: randomUUID() }))
      : names.map((name, index) => ({
          id: randomUUID(),
          name,
          position: index,
          // The last stage of an explicit list is treated as the winning one,
          // so a new pipeline can be closed without further configuration.
          outcome: index === names.length - 1 ? 'won' : 'open',
        }));

  const session = await mongoose.startSession();
  try {
    let created: PipelineDoc | undefined;

    await session.withTransaction(async () => {
      const [pipeline] = await PipelineModel.create(
        [
          {
            workspaceId: auth.workspaceId,
            name: input.name.trim(),
            isDefault: false,
            stages,
            version: 0,
          },
        ],
        { session, ordered: true },
      );
      if (pipeline === undefined) throw new Error('pipeline was not created');

      await audit(
        auth,
        AUDIT_EVENT_TYPES.PIPELINE_CREATED,
        { kind: 'pipeline', id: pipeline._id.toString(), label: pipeline.name },
        { after: { name: pipeline.name, stages: stages.map((stage) => stage.name) } },
        session,
        requestId,
      );

      created = pipeline.toObject();
    });

    if (created === undefined) throw new Error('create pipeline produced no result');
    return created;
  } finally {
    await session.endSession();
  }
}

// ---------------------------------------------------------------------------
// Stages (F2.5)
// ---------------------------------------------------------------------------

/** Writes a new stage array, conditional on the pipeline's version (Q4). */
async function writeStages(
  auth: AuthContext,
  pipeline: PipelineDoc,
  stages: readonly PipelineStage[],
  session: ClientSession,
): Promise<void> {
  const result = await PipelineModel.updateOne(
    { _id: pipeline._id, workspaceId: auth.workspaceId, version: pipeline.version },
    { $set: { stages: [...stages] }, $inc: { version: 1 } },
    { session },
  );

  if (result.modifiedCount !== 1) {
    throw conflict('That pipeline was changed while you were editing it.', {
      hint: 'Reload the pipeline and try again.',
    });
  }
}

export async function addPipelineStage(
  auth: AuthContext,
  pipelineId: string,
  input: { readonly name: string; readonly outcome: StageOutcome },
  requestId?: string,
): Promise<PipelineDoc> {
  const pipeline = await findPipeline(auth, pipelineId);
  const stages = addStage(pipeline.stages, {
    id: randomUUID(),
    name: input.name.trim(),
    outcome: input.outcome,
  });

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      await writeStages(auth, pipeline, stages, session);
      await audit(
        auth,
        AUDIT_EVENT_TYPES.STAGE_CREATED,
        { kind: 'stage', id: pipelineId, label: input.name },
        { after: { name: input.name, outcome: input.outcome } },
        session,
        requestId,
      );
    });
  } finally {
    await session.endSession();
  }

  return findPipeline(auth, pipelineId);
}

export async function renamePipelineStage(
  auth: AuthContext,
  pipelineId: string,
  stageId: string,
  input: { readonly name?: string | undefined; readonly outcome?: StageOutcome | undefined },
  requestId?: string,
): Promise<PipelineDoc> {
  const pipeline = await findPipeline(auth, pipelineId);
  const stage = findStage(pipeline.stages, stageId);
  if (stage === undefined) throw notFound('That stage does not exist.');

  const next: PipelineStage = {
    ...stage,
    ...(input.name === undefined ? {} : { name: input.name.trim() }),
    ...(input.outcome === undefined ? {} : { outcome: input.outcome }),
  };

  const stages = pipeline.stages.map((candidate) => (candidate.id === stageId ? next : candidate));

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      await writeStages(auth, pipeline, stages, session);

      // Changing a stage's outcome changes what every opportunity in it counts
      // as, so the denormalised copy is corrected in the same transaction. Left
      // alone, the open-pipeline-value figure would disagree with the board.
      if (input.outcome !== undefined && input.outcome !== stage.outcome) {
        await OpportunityModel.updateMany(
          { workspaceId: auth.workspaceId, pipelineId: pipeline._id, stageId },
          { $set: { stageOutcome: input.outcome } },
          { session },
        );
      }

      await audit(
        auth,
        AUDIT_EVENT_TYPES.STAGE_UPDATED,
        { kind: 'stage', id: stageId, label: next.name },
        {
          before: { name: stage.name, outcome: stage.outcome },
          after: { name: next.name, outcome: next.outcome },
        },
        session,
        requestId,
      );
    });
  } finally {
    await session.endSession();
  }

  return findPipeline(auth, pipelineId);
}

export async function reorderPipelineStages(
  auth: AuthContext,
  pipelineId: string,
  orderedStageIds: readonly string[],
  requestId?: string,
): Promise<PipelineDoc> {
  const pipeline = await findPipeline(auth, pipelineId);
  const stages = reorderStages(pipeline.stages, orderedStageIds);

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      await writeStages(auth, pipeline, stages, session);
      await audit(
        auth,
        AUDIT_EVENT_TYPES.STAGE_REORDERED,
        { kind: 'pipeline', id: pipelineId, label: pipeline.name },
        {
          before: { order: pipeline.stages.map((stage) => stage.name) },
          after: { order: stages.map((stage) => stage.name) },
        },
        session,
        requestId,
      );
    });
  } finally {
    await session.endSession();
  }

  return findPipeline(auth, pipelineId);
}

/**
 * Deletes a stage, moving its opportunities if there are any (F2.5).
 *
 * The move and the delete happen in one transaction, so there is no moment at
 * which an opportunity points at a stage that no longer exists (Q4).
 */
export async function deletePipelineStage(
  auth: AuthContext,
  pipelineId: string,
  stageId: string,
  moveToStageId: string | undefined,
  requestId?: string,
): Promise<{ movedOpportunities: number }> {
  const pipeline = await findPipeline(auth, pipelineId);
  const stage = findStage(pipeline.stages, stageId);
  if (stage === undefined) throw notFound('That stage does not exist.');

  const occupiedBy = await OpportunityModel.countDocuments({
    workspaceId: auth.workspaceId,
    pipelineId: pipeline._id,
    stageId,
  });

  const decision = canDeleteStage({
    stages: pipeline.stages,
    stageId,
    occupiedBy,
    moveToStageId,
  });

  if (!decision.allowed) {
    if (decision.reason === 'last_stage') {
      throw conflict('A pipeline must keep at least one stage.', {
        details: { reason: decision.reason },
      });
    }

    if (decision.reason === 'invalid_destination') {
      throw badRequest('Choose a different stage to move those opportunities to.', {
        details: { reason: decision.reason, opportunityCount: occupiedBy },
      });
    }

    // Needs a destination: the count is what makes the message actionable.
    throw conflict(
      `${String(occupiedBy)} ${
        occupiedBy === 1 ? 'opportunity is' : 'opportunities are'
      } still in ${stage.name}.`,
      {
        hint: 'Choose a stage to move them to, then delete this one.',
        details: {
          reason: decision.reason,
          opportunityCount: occupiedBy,
          availableStageIds: pipeline.stages
            .filter((candidate) => candidate.id !== stageId)
            .map((candidate) => candidate.id),
        },
      },
    );
  }

  const destination =
    decision.moveToStageId === null ? null : findStage(pipeline.stages, decision.moveToStageId);

  const remaining = pipeline.stages
    .filter((candidate) => candidate.id !== stageId)
    .map((candidate, index) => ({ ...candidate, position: index }));

  const session = await mongoose.startSession();
  try {
    let movedOpportunities = 0;

    await session.withTransaction(async () => {
      if (destination !== null && destination !== undefined) {
        const moved = await OpportunityModel.updateMany(
          { workspaceId: auth.workspaceId, pipelineId: pipeline._id, stageId },
          { $set: { stageId: destination.id, stageOutcome: destination.outcome } },
          { session },
        );
        movedOpportunities = moved.modifiedCount;
      }

      await writeStages(auth, pipeline, remaining, session);

      await audit(
        auth,
        AUDIT_EVENT_TYPES.STAGE_DELETED,
        { kind: 'stage', id: stageId, label: stage.name },
        {
          before: { name: stage.name, outcome: stage.outcome },
          after: { movedTo: destination?.name ?? null, movedOpportunities },
        },
        session,
        requestId,
      );
    });

    return { movedOpportunities };
  } finally {
    await session.endSession();
  }
}

// ---------------------------------------------------------------------------
// Custom field definitions (F2.2)
// ---------------------------------------------------------------------------

/** Maps a stored definition onto the domain shape the validator understands. */
export function toDomainDefinition(doc: CustomFieldDefinitionDoc): CustomFieldDefinition {
  return {
    key: doc.key,
    label: doc.label,
    type: doc.type,
    options: doc.options,
    required: doc.required,
    requiredInStageIds: doc.requiredInStageIds,
  };
}

/**
 * The definitions that apply to one record, in display order.
 *
 * For an opportunity that means the fields of *its* pipeline only, which is
 * what lets two pipelines show different fields for the same contact (F2.3).
 */
export async function definitionsFor(
  auth: AuthContext,
  entity: CustomFieldEntity,
  pipelineId?: Types.ObjectId | null,
): Promise<readonly CustomFieldDefinitionDoc[]> {
  return CustomFieldDefinitionModel.find({
    workspaceId: auth.workspaceId,
    entity,
    pipelineId: entity === 'opportunity' ? (pipelineId ?? null) : null,
  })
    .sort({ position: 1, key: 1 })
    .lean();
}

export interface CreateFieldInput {
  readonly entity: CustomFieldEntity;
  readonly pipelineId?: string | null | undefined;
  readonly key: string;
  readonly label: string;
  readonly type: CustomFieldDefinition['type'];
  readonly options?: readonly string[] | undefined;
  readonly required?: boolean | undefined;
  readonly requiredInStageIds?: readonly string[] | undefined;
}

export async function createCustomField(
  auth: AuthContext,
  input: CreateFieldInput,
  requestId?: string,
): Promise<CustomFieldDefinitionDoc> {
  // A dropdown with no options could hold nothing, so it is refused at
  // creation rather than producing a field nobody can fill.
  if (input.type === 'dropdown' && (input.options === undefined || input.options.length === 0)) {
    throw badRequest('A dropdown needs at least one option.', {
      details: { fields: { options: 'is required for a dropdown' } },
    });
  }

  let pipelineId: Types.ObjectId | null = null;
  if (input.entity === 'opportunity') {
    // An opportunity field belongs to one pipeline; without that, F2.3 cannot
    // hold. Defaults to the workspace's default pipeline.
    const pipeline =
      input.pipelineId === undefined || input.pipelineId === null
        ? await defaultPipeline(auth)
        : await findPipeline(auth, input.pipelineId);
    pipelineId = pipeline._id;

    // Every named stage must exist in that pipeline, or the field would be
    // required in a stage nothing can reach.
    for (const stageId of input.requiredInStageIds ?? []) {
      if (findStage(pipeline.stages, stageId) === undefined) {
        throw badRequest('That stage is not in this pipeline.', {
          details: { stageId },
        });
      }
    }
  } else if (input.requiredInStageIds !== undefined && input.requiredInStageIds.length > 0) {
    throw badRequest('Only opportunity fields can be required in a stage.', {
      hint: 'Stages belong to pipelines, which only opportunities move through.',
    });
  }

  const existing = await CustomFieldDefinitionModel.findOne({
    workspaceId: auth.workspaceId,
    entity: input.entity,
    pipelineId,
    key: input.key,
  })
    .select('_id')
    .lean();

  if (existing !== null) {
    throw conflict(`A field with the key "${input.key}" already exists here.`);
  }

  const position = await CustomFieldDefinitionModel.countDocuments({
    workspaceId: auth.workspaceId,
    entity: input.entity,
    pipelineId,
  });

  const session = await mongoose.startSession();
  try {
    let created: CustomFieldDefinitionDoc | undefined;

    await session.withTransaction(async () => {
      const [definition] = await CustomFieldDefinitionModel.create(
        [
          {
            workspaceId: auth.workspaceId,
            entity: input.entity,
            pipelineId,
            key: input.key,
            label: input.label.trim(),
            type: input.type,
            options: input.options === undefined ? [] : [...input.options],
            required: input.required ?? false,
            requiredInStageIds:
              input.requiredInStageIds === undefined ? [] : [...input.requiredInStageIds],
            position,
          },
        ],
        { session, ordered: true },
      );
      if (definition === undefined) throw new Error('field was not created');

      await audit(
        auth,
        AUDIT_EVENT_TYPES.CUSTOM_FIELD_CREATED,
        { kind: 'custom_field', id: definition._id.toString(), label: definition.label },
        {
          after: {
            entity: input.entity,
            key: input.key,
            type: input.type,
            required: definition.required,
            requiredInStageIds: definition.requiredInStageIds,
          },
        },
        session,
        requestId,
      );

      created = definition.toObject();
    });

    if (created === undefined) throw new Error('create field produced no result');
    return created;
  } finally {
    await session.endSession();
  }
}

/**
 * Deleting a definition leaves the stored values alone.
 *
 * The values become unreachable rather than destroyed, so re-adding a field
 * with the same key brings the history back. Stripping them from every record
 * would be a large destructive write to undo a configuration mistake.
 */
export async function deleteCustomField(
  auth: AuthContext,
  fieldId: string,
  requestId?: string,
): Promise<void> {
  const _id = objectId(fieldId, 'That field');
  const definition = await CustomFieldDefinitionModel.findOne({
    _id,
    workspaceId: auth.workspaceId,
  }).lean();

  if (definition === null) throw notFound('That field does not exist.');

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      await CustomFieldDefinitionModel.deleteOne(
        { _id, workspaceId: auth.workspaceId },
        { session },
      );

      await audit(
        auth,
        AUDIT_EVENT_TYPES.CUSTOM_FIELD_DELETED,
        { kind: 'custom_field', id: fieldId, label: definition.label },
        { before: { entity: definition.entity, key: definition.key, type: definition.type } },
        session,
        requestId,
      );
    });
  } finally {
    await session.endSession();
  }
}
