import { model, Schema, type Types } from 'mongoose';

/** A public web form that creates leads (F3.1). */
export interface LeadFormDoc {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  name: string;
  /** The source label every lead from this form carries. */
  sourceLabel: string;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const leadFormSchema = new Schema<LeadFormDoc>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true },
    name: { type: String, required: true, trim: true, maxlength: 100 },
    sourceLabel: { type: String, required: true, trim: true, maxlength: 200 },
    enabled: { type: Boolean, default: true },
  },
  { timestamps: true },
);

export const LeadFormModel = model<LeadFormDoc>('LeadForm', leadFormSchema);
