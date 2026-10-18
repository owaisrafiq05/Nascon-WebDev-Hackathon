import type { Filter } from '@ubmp/domain';
import { model, Schema, type Types } from 'mongoose';

/**
 * A saved list (F2.6).
 *
 * It stores the **filter**, never a result set, because the requirement is that
 * the list "updates automatically as records start or stop matching". The query
 * is re-run on each request, so nothing can go stale and a record changed by
 * any path is reflected at once.
 */
export const SAVED_LIST_ENTITIES = ['contact', 'company', 'opportunity'] as const;
export type SavedListEntity = (typeof SAVED_LIST_ENTITIES)[number];

export interface SavedListDoc {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  name: string;
  entity: SavedListEntity;
  /** Opportunity lists may be scoped to one pipeline. */
  pipelineId: Types.ObjectId | null;
  filter: Filter;
  /** The member who saved it; `null` for a list shared with the workspace. */
  createdByMembershipId: Types.ObjectId | null;
  /** When false, only its creator sees it. */
  sharedWithWorkspace: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const savedListSchema = new Schema<SavedListDoc>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true },
    name: { type: String, required: true, trim: true, maxlength: 100 },
    entity: { type: String, required: true, enum: SAVED_LIST_ENTITIES },
    pipelineId: { type: Schema.Types.ObjectId, ref: 'Pipeline', default: null },
    // Mixed: the filter's shape is the domain's DSL, validated by
    // `validateFilter` before it is ever stored, not by Mongoose.
    filter: { type: Schema.Types.Mixed, required: true },
    createdByMembershipId: { type: Schema.Types.ObjectId, ref: 'Membership', default: null },
    sharedWithWorkspace: { type: Boolean, default: true },
  },
  { timestamps: true, minimize: false },
);

savedListSchema.index({ workspaceId: 1, entity: 1, name: 1 }, { unique: true });

export const SavedListModel = model<SavedListDoc>('SavedList', savedListSchema);
