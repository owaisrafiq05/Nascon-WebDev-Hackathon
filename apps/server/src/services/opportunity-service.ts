import {
  buildCustomFieldSchema,
  findStage,
  missingFieldsMessage,
  missingRequiredFields,
  type PipelineStage,
} from '@ubmp/domain';
import { notFound, validationFailed, versionConflict } from '@ubmp/shared';
import mongoose, { Types } from 'mongoose';

import { ContactModel, contactDisplayName } from '../db/models/contact.js';
import { OpportunityModel, type OpportunityDoc } from '../db/models/opportunity.js';
import type { PipelineDoc } from '../db/models/pipeline.js';
import { recordActivity } from '../repositories/activity-repository.js';
import type { Actor } from './crm-service.js';
import {
  definitionsFor,
  defaultPipeline,
  findPipeline,
  toDomainDefinition,
} from './pipeline-service.js';
import type { AuthContext } from './session-service.js';

/**
 * Opportunities, including the stage-required field rule (F2.4).
 *
 * Custom field values are validated against a Zod schema **built at runtime**
 * from the workspace's definitions, so a field an Admin adds through the
 * interface takes effect on the very next save with no deployment (F2.2).
 */

function objectId(value: string, what: string): Types.ObjectId {
  if (!Types.ObjectId.isValid(value)) throw notFound(`${what} does not exist.`);
  return new Types.ObjectId(value);
}

/**
 * Raises the error F2.4 asks for: blocked, with a clear message naming exactly
 * which fields are missing.
 */
function refuseIncomplete(
  stage: PipelineStage,
  missing: readonly { key: string; label: string }[],
): never {
  throw validationFailed(missingFieldsMessage(stage.name, missing), {
    hint: 'Fill those fields in, then move it again.',
    details: {
      stageId: stage.id,
      stageName: stage.name,
      // Keyed by field so a form can mark each input, and listed so a plain
      // reader sees the labels (Q10).
      fields: Object.fromEntries(missing.map((field) => [field.key, 'is required in this stage'])),
      missing: missing.map((field) => ({ key: field.key, label: field.label })),
    },
  });
}

/**
 * Validates a record's custom field values for the stage it is in or entering.
 *
 * Returns the parsed values, so a caller writes exactly what passed validation
 * rather than whatever was submitted.
 */
async function validateCustomFields(
  auth: AuthContext,
  pipeline: PipelineDoc,
  stage: PipelineStage,
  submitted: Record<string, unknown>,
  existing: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const definitions = (await definitionsFor(auth, 'opportunity', pipeline._id)).map(
    toDomainDefinition,
  );

  // The merged values are what the record will hold, so a field filled in
  // earlier satisfies a stage requirement without being resent.
  const merged = { ...existing, ...submitted };

  const missing = missingRequiredFields(definitions, merged, stage.id);
  if (missing.length > 0) refuseIncomplete(stage, missing);

  const schema = buildCustomFieldSchema(definitions, { stageId: stage.id });
  const parsed = schema.safeParse(merged);

  if (!parsed.success) {
    throw validationFailed('Some of the custom field values are not valid.', {
      hint: 'Correct the highlighted fields and try again.',
      details: {
        fields: Object.fromEntries(
          parsed.error.issues.map((issue) => [issue.path.join('.') || '(value)', issue.message]),
        ),
      },
    });
  }

  return parsed.data;
}

export interface CreateOpportunityInput {
  readonly name: string;
  readonly contactId: string;
  readonly pipelineId?: string | undefined;
  readonly stageId?: string | undefined;
  readonly value?: number | null | undefined;
  readonly currency?: string | null | undefined;
  readonly customFields?: Record<string, unknown> | undefined;
}

export async function createOpportunity(
  auth: AuthContext,
  input: CreateOpportunityInput,
  actor: Actor,
): Promise<OpportunityDoc> {
  const contactId = objectId(input.contactId, 'That contact');
  const contact = await ContactModel.findOne({
    _id: contactId,
    workspaceId: auth.workspaceId,
  }).lean();

  // A contact from another workspace is simply not found (F1.6).
  if (contact === null) throw notFound('That contact does not exist.');

  const pipeline =
    input.pipelineId === undefined
      ? await defaultPipeline(auth)
      : await findPipeline(auth, input.pipelineId);

  // Lands in the first stage unless one was named.
  const stage =
    input.stageId === undefined ? pipeline.stages[0] : findStage(pipeline.stages, input.stageId);

  if (stage === undefined) throw notFound('That stage does not exist.');

  const customFields = await validateCustomFields(
    auth,
    pipeline,
    stage,
    input.customFields ?? {},
    {},
  );

  const session = await mongoose.startSession();
  try {
    let created: OpportunityDoc | undefined;

    await session.withTransaction(async () => {
      const [opportunity] = await OpportunityModel.create(
        [
          {
            workspaceId: auth.workspaceId,
            contactId,
            pipelineId: pipeline._id,
            name: input.name,
            value: input.value ?? null,
            currency: input.currency ?? null,
            stageId: stage.id,
            // Denormalised from the stage, so the open-pipeline-value metric
            // can exclude won and lost with an index (Section 7).
            stageOutcome: stage.outcome,
            ownerMembershipId: auth.membershipId,
            customFields,
            version: 0,
          },
        ],
        { session, ordered: true },
      );
      if (opportunity === undefined) throw new Error('opportunity was not created');

      await recordActivity(
        {
          workspaceId: auth.workspaceId,
          type: 'opportunity.created',
          targetKind: 'opportunity',
          targetId: opportunity._id,
          // Carried, so this appears on the contact's timeline too (F2.8).
          contactId,
          actor,
          summary: `Created ${opportunity.name} for ${contactDisplayName(contact)}`,
          payload: { pipeline: pipeline.name, stage: stage.name },
        },
        session,
      );

      created = opportunity.toObject();
    });

    if (created === undefined) throw new Error('create opportunity produced no result');
    return created;
  } finally {
    await session.endSession();
  }
}

export async function findOpportunity(
  auth: AuthContext,
  opportunityId: string,
): Promise<OpportunityDoc> {
  const _id = objectId(opportunityId, 'That opportunity');
  const opportunity = await OpportunityModel.findOne({
    _id,
    workspaceId: auth.workspaceId,
  }).lean();

  if (opportunity === null) throw notFound('That opportunity does not exist.');
  return opportunity;
}

export interface UpdateOpportunityInput {
  readonly name?: string | undefined;
  readonly value?: number | null | undefined;
  readonly currency?: string | null | undefined;
  readonly customFields?: Record<string, unknown> | undefined;
  readonly ownerMembershipId?: string | null | undefined;
  readonly version: number;
}

export async function updateOpportunity(
  auth: AuthContext,
  opportunityId: string,
  input: UpdateOpportunityInput,
  actor: Actor,
): Promise<OpportunityDoc> {
  const existing = await findOpportunity(auth, opportunityId);

  const pipeline =
    existing.pipelineId === null
      ? await defaultPipeline(auth)
      : await findPipeline(auth, existing.pipelineId.toString());

  const stage = findStage(pipeline.stages, existing.stageId);

  // Values are validated for the stage the record is already in, so an edit
  // cannot leave a record in a stage whose requirements it no longer meets.
  const customFields =
    input.customFields === undefined || stage === undefined
      ? undefined
      : await validateCustomFields(
          auth,
          pipeline,
          stage,
          input.customFields,
          existing.customFields,
        );

  const next: Record<string, unknown> = {
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.value === undefined ? {} : { value: input.value }),
    ...(input.currency === undefined ? {} : { currency: input.currency }),
    ...(customFields === undefined ? {} : { customFields }),
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
    let updated: OpportunityDoc | undefined;

    await session.withTransaction(async () => {
      const result = await OpportunityModel.findOneAndUpdate(
        { _id: existing._id, workspaceId: auth.workspaceId, version: input.version },
        { $set: next, $inc: { version: 1 } },
        { new: true, session },
      ).lean();

      if (result === null) throw versionConflict();

      await recordActivity(
        {
          workspaceId: auth.workspaceId,
          type:
            input.ownerMembershipId === undefined ? 'opportunity.updated' : 'opportunity.assigned',
          targetKind: 'opportunity',
          targetId: existing._id,
          contactId: existing.contactId,
          actor,
          summary: `Updated ${result.name}`,
          payload: { changed: Object.keys(next).sort() },
        },
        session,
      );

      updated = result;
    });

    if (updated === undefined) throw new Error('update opportunity produced no result');
    return updated;
  } finally {
    await session.endSession();
  }
}

/**
 * Moves an opportunity to another stage (F2.4, F2.5).
 *
 * The move is refused, with the missing fields named, unless the record meets
 * the destination stage's requirements. The check runs against the record's
 * stored values merged with anything supplied in the same request, so a user
 * can fill the missing fields and move in one action.
 */
export async function moveOpportunityToStage(
  auth: AuthContext,
  opportunityId: string,
  input: {
    readonly stageId: string;
    readonly version: number;
    readonly customFields?: Record<string, unknown> | undefined;
  },
  actor: Actor,
): Promise<OpportunityDoc> {
  const existing = await findOpportunity(auth, opportunityId);

  const pipeline =
    existing.pipelineId === null
      ? await defaultPipeline(auth)
      : await findPipeline(auth, existing.pipelineId.toString());

  const target = findStage(pipeline.stages, input.stageId);
  if (target === undefined) throw notFound('That stage does not exist.');

  const from = findStage(pipeline.stages, existing.stageId);

  const customFields = await validateCustomFields(
    auth,
    pipeline,
    target,
    input.customFields ?? {},
    existing.customFields,
  );

  const session = await mongoose.startSession();
  try {
    let moved: OpportunityDoc | undefined;

    await session.withTransaction(async () => {
      const result = await OpportunityModel.findOneAndUpdate(
        { _id: existing._id, workspaceId: auth.workspaceId, version: input.version },
        {
          // The stage and its outcome move together, so the board and the
          // open-pipeline-value figure can never disagree.
          $set: { stageId: target.id, stageOutcome: target.outcome, customFields },
          $inc: { version: 1 },
        },
        { new: true, session },
      ).lean();

      if (result === null) throw versionConflict();

      await recordActivity(
        {
          workspaceId: auth.workspaceId,
          type: 'opportunity.stage_changed',
          targetKind: 'opportunity',
          targetId: existing._id,
          contactId: existing.contactId,
          actor,
          summary: `Moved ${result.name} from ${from?.name ?? 'an earlier stage'} to ${target.name}`,
          payload: {
            fromStageId: existing.stageId,
            fromStageName: from?.name ?? null,
            toStageId: target.id,
            toStageName: target.name,
            outcome: target.outcome,
          },
        },
        session,
      );

      moved = result;
    });

    if (moved === undefined) throw new Error('move produced no result');
    return moved;
  } finally {
    await session.endSession();
  }
}

export async function deleteOpportunity(auth: AuthContext, opportunityId: string): Promise<void> {
  const existing = await findOpportunity(auth, opportunityId);

  await OpportunityModel.deleteOne({ _id: existing._id, workspaceId: auth.workspaceId });
}
