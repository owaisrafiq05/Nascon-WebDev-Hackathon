import { ASSIGNABLE_PERMISSIONS, BASE_LEVELS, type BaseLevel } from '@ubmp/domain';
import { model, Schema, type Types } from 'mongoose';

/**
 * A workspace's role-like configuration (F1.3). A "Manager" is a row here, not a
 * base level, which is what Section 2 means by a configurable role built from
 * permissions.
 *
 * Stored per workspace, so one company's definition of Manager never affects
 * another's.
 */
export interface PermissionSetDoc {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  name: string;
  description: string;
  permissions: string[];
  /** Applied automatically when someone is invited at this level. */
  defaultForBaseLevel: BaseLevel | null;
  createdAt: Date;
  updatedAt: Date;
}

const permissionSetSchema = new Schema<PermissionSetDoc>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 100 },
    description: { type: String, default: '', trim: true, maxlength: 500 },
    // Only assignable permissions may be stored: workspace administration
    // follows the base level and must not be grantable through a set.
    permissions: { type: [String], default: [], enum: ASSIGNABLE_PERMISSIONS },
    defaultForBaseLevel: { type: String, enum: [...BASE_LEVELS, null], default: null },
  },
  { timestamps: true },
);

// Two sets in one workspace cannot share a name, so the matrix editor and the
// audit log always name an unambiguous set.
permissionSetSchema.index({ workspaceId: 1, name: 1 }, { unique: true });

export const PermissionSetModel = model<PermissionSetDoc>('PermissionSet', permissionSetSchema);
