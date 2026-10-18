import { model, Schema, type Types } from 'mongoose';

/**
 * A sales opportunity (F2.1).
 *
 * It belongs to a contact and to a pipeline. `stageId` names a stage inside
 * that pipeline, and `stageOutcome` is denormalised from that stage so the
 * open-pipeline-value metric can exclude won and lost with an index rather than
 * a join (Section 7). The two are kept in step by the stage-change service: a
 * stage move writes both or neither.
 *
 * `contactId` and `pipelineId` are nullable in the schema because P2 created
 * opportunities before either existed, for the value-masking rule. P3's
 * creation path requires both.
 */
export const STAGE_OUTCOMES = ['open', 'won', 'lost'] as const;

export interface OpportunityDoc {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  contactId: Types.ObjectId | null;
  pipelineId: Types.ObjectId | null;
  name: string;
  /**
   * Minor units (cents), so totals can be summed without floating-point drift.
   * `null` when no value has been recorded, which masking reports differently
   * from a value the reader may not see.
   */
  value: number | null;
  currency: string | null;
  stageId: string;
  stageOutcome: (typeof STAGE_OUTCOMES)[number];
  ownerMembershipId: Types.ObjectId | null;
  /**
   * Values for this pipeline's custom field definitions, keyed by definition
   * `key`. Two pipelines can therefore carry different fields for the same
   * contact (F2.3).
   */
  customFields: Record<string, unknown>;
  /** Optimistic concurrency, so two edits cannot silently overwrite (Q4). */
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

const opportunitySchema = new Schema<OpportunityDoc>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true, index: true },
    contactId: { type: Schema.Types.ObjectId, ref: 'Contact', default: null },
    pipelineId: { type: Schema.Types.ObjectId, ref: 'Pipeline', default: null },
    name: { type: String, required: true, trim: true, maxlength: 200 },
    value: { type: Number, default: null, min: 0 },
    currency: { type: String, default: null, uppercase: true, minlength: 3, maxlength: 3 },
    stageId: { type: String, required: true, maxlength: 64 },
    stageOutcome: { type: String, required: true, enum: STAGE_OUTCOMES, default: 'open' },
    ownerMembershipId: { type: Schema.Types.ObjectId, ref: 'Membership', default: null },
    customFields: { type: Schema.Types.Mixed, default: () => ({}) },
    version: { type: Number, required: true, default: 0 },
  },
  { timestamps: true },
);

// One index per access path F2.6 and Section 7 need, all led by workspaceId so
// a query can never scan another tenant's documents (F1.6, Q9).
opportunitySchema.index({ workspaceId: 1, stageOutcome: 1, stageId: 1 });
opportunitySchema.index({ workspaceId: 1, createdAt: -1 });
// The contact page's related records, and the refusal to delete a contact that
// still holds opportunities (F2.1, Q4).
opportunitySchema.index({ workspaceId: 1, contactId: 1 });
// The board: one pipeline's opportunities grouped by stage (F2.5).
opportunitySchema.index({ workspaceId: 1, pipelineId: 1, stageId: 1 });
opportunitySchema.index({ workspaceId: 1, ownerMembershipId: 1 });

export const OpportunityModel = model<OpportunityDoc>('Opportunity', opportunitySchema);
