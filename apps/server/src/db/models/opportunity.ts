import { model, Schema, type Types } from 'mongoose';

/**
 * A sales opportunity, in the minimal form P2 needs.
 *
 * P2 owns it only because F1.4 requires opportunity *value* to be masked in
 * lists, on detail pages and in exports, and that rule cannot be shown to work
 * without a record carrying a value. P3 is what makes it a real CRM object:
 * pipelines and stages, custom field values, a contact and company
 * relationship, and stage-required fields (F2.1 - F2.5).
 *
 * `stageOutcome` is already here because the open-pipeline-value metric excludes
 * won and lost (Section 7), and adding it later would mean rewriting documents.
 */
export const STAGE_OUTCOMES = ['open', 'won', 'lost'] as const;

export interface OpportunityDoc {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
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
  /** Optimistic concurrency, so two edits cannot silently overwrite (Q4). */
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

const opportunitySchema = new Schema<OpportunityDoc>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 200 },
    value: { type: Number, default: null, min: 0 },
    currency: { type: String, default: null, uppercase: true, minlength: 3, maxlength: 3 },
    stageId: { type: String, required: true, maxlength: 64 },
    stageOutcome: { type: String, required: true, enum: STAGE_OUTCOMES, default: 'open' },
    ownerMembershipId: { type: Schema.Types.ObjectId, ref: 'Membership', default: null },
    version: { type: Number, required: true, default: 0 },
  },
  { timestamps: true },
);

// Listing and the open-pipeline-value figure, both scoped to one workspace.
opportunitySchema.index({ workspaceId: 1, stageOutcome: 1, stageId: 1 });
opportunitySchema.index({ workspaceId: 1, createdAt: -1 });

export const OpportunityModel = model<OpportunityDoc>('Opportunity', opportunitySchema);
