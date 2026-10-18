import {
  CUSTOM_FIELD_ENTITIES,
  CUSTOM_FIELD_TYPES,
  type CustomFieldEntity,
  type CustomFieldType,
} from '@ubmp/domain';
import { model, Schema, type Types } from 'mongoose';

/**
 * A field a workspace added through the interface (F2.2).
 *
 * `pipelineId` is set only for opportunity fields, and is what makes F2.3 work:
 * two pipelines can define different fields while the contact they share
 * carries neither, because contact fields have no pipeline.
 */
export interface CustomFieldDefinitionDoc {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  entity: CustomFieldEntity;
  /** `null` for contact and company fields, which are workspace-wide. */
  pipelineId: Types.ObjectId | null;
  key: string;
  label: string;
  type: CustomFieldType;
  options: string[];
  required: boolean;
  /** Stages that demand this field before an opportunity may enter (F2.4). */
  requiredInStageIds: string[];
  position: number;
  createdAt: Date;
  updatedAt: Date;
}

const definitionSchema = new Schema<CustomFieldDefinitionDoc>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true },
    entity: { type: String, required: true, enum: CUSTOM_FIELD_ENTITIES },
    pipelineId: { type: Schema.Types.ObjectId, ref: 'Pipeline', default: null },
    key: { type: String, required: true, maxlength: 64 },
    label: { type: String, required: true, trim: true, maxlength: 100 },
    type: { type: String, required: true, enum: CUSTOM_FIELD_TYPES },
    options: { type: [String], default: [] },
    required: { type: Boolean, default: false },
    requiredInStageIds: { type: [String], default: [] },
    position: { type: Number, required: true, default: 0 },
  },
  { timestamps: true },
);

// One key per entity per pipeline. `pipelineId: null` participates, so two
// contact fields cannot share a key either.
definitionSchema.index({ workspaceId: 1, entity: 1, pipelineId: 1, key: 1 }, { unique: true });
// The form schema query: every field for this entity and pipeline, in order.
definitionSchema.index({ workspaceId: 1, entity: 1, pipelineId: 1, position: 1 });

export const CustomFieldDefinitionModel = model<CustomFieldDefinitionDoc>(
  'CustomFieldDefinition',
  definitionSchema,
);
