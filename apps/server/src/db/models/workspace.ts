import { model, Schema, type Types } from 'mongoose';

/**
 * One company's isolated environment (Section 7). Every tenant document in the
 * platform carries a `workspaceId` pointing here, and every query on tenant data
 * filters by it (F1.6).
 */
export interface WorkspaceDoc {
  _id: Types.ObjectId;
  name: string;
  createdByUserId: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const workspaceSchema = new Schema<WorkspaceDoc>(
  {
    name: { type: String, required: true, trim: true, maxlength: 200 },
    createdByUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
);

export const WorkspaceModel = model<WorkspaceDoc>('Workspace', workspaceSchema);
