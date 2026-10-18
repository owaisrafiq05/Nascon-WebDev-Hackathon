import { STAGE_OUTCOMES, type PipelineStage } from '@ubmp/domain';
import { model, Schema, type Types } from 'mongoose';

/**
 * A pipeline and its stages (F2.5). A workspace may have several, each with its
 * own stages and its own custom field set (F2.3).
 *
 * Stages are embedded rather than a collection of their own: they are always
 * read with their pipeline, never queried across pipelines, and embedding lets
 * a reorder be one atomic write instead of several.
 */
export interface PipelineDoc {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  name: string;
  /** The pipeline new opportunities land in when none is named. */
  isDefault: boolean;
  stages: PipelineStage[];
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

const stageSchema = new Schema<PipelineStage>(
  {
    // A stable id, not the name and not the position: renaming or moving a
    // stage must not detach the opportunities sitting in it.
    id: { type: String, required: true, maxlength: 64 },
    name: { type: String, required: true, trim: true, maxlength: 100 },
    position: { type: Number, required: true, min: 0 },
    outcome: { type: String, required: true, enum: STAGE_OUTCOMES, default: 'open' },
  },
  { _id: false },
);

const pipelineSchema = new Schema<PipelineDoc>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true },
    name: { type: String, required: true, trim: true, maxlength: 100 },
    isDefault: { type: Boolean, default: false },
    stages: { type: [stageSchema], default: [] },
    version: { type: Number, required: true, default: 0 },
  },
  { timestamps: true },
);

pipelineSchema.index({ workspaceId: 1, name: 1 }, { unique: true });
pipelineSchema.index({ workspaceId: 1, isDefault: 1 });

export const PipelineModel = model<PipelineDoc>('Pipeline', pipelineSchema);
