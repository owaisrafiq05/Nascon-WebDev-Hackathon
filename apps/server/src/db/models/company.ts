import { model, Schema, type Types } from 'mongoose';

/**
 * A customer company (F2.1). Contacts belong to one.
 *
 * `customFields` holds values for the workspace's own
 * `CustomFieldDefinition` rows, keyed by definition `key`. It is a free-form
 * map in the schema because its shape is configuration, not code: the Zod
 * schema that validates it is built at runtime from the definitions (F2.2).
 */
export interface CompanyDoc {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  name: string;
  domain: string | null;
  phone: string | null;
  customFields: Record<string, unknown>;
  ownerMembershipId: Types.ObjectId | null;
  /** Optimistic concurrency, so two edits cannot silently overwrite (Q4). */
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

const companySchema = new Schema<CompanyDoc>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true },
    name: { type: String, required: true, trim: true, maxlength: 200 },
    domain: { type: String, default: null, trim: true, lowercase: true, maxlength: 253 },
    phone: { type: String, default: null, trim: true, maxlength: 40 },
    customFields: { type: Schema.Types.Mixed, default: () => ({}) },
    ownerMembershipId: { type: Schema.Types.ObjectId, ref: 'Membership', default: null },
    version: { type: Number, required: true, default: 0 },
  },
  {
    timestamps: true,
    // `minimize: false` keeps `customFields: {}` in the document. Mongoose
    // strips empty objects by default, which would make the field absent rather
    // than empty and force every reader to handle both shapes.
    minimize: false,
  },
);

// Listing and searching, always inside one workspace (F1.6, Q9).
companySchema.index({ workspaceId: 1, name: 1 });
companySchema.index({ workspaceId: 1, createdAt: -1 });

export const CompanyModel = model<CompanyDoc>('Company', companySchema);
