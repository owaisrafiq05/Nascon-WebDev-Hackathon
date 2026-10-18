import {
  ASSIGNABLE_PERMISSIONS,
  AVAILABILITY_STATUSES,
  BASE_LEVELS,
  type AvailabilityStatus,
  type BaseLevel,
} from '@ubmp/domain';
import { model, Schema, type Types } from 'mongoose';

/**
 * One person's place in one workspace: their base level (F1.2) and the
 * permission sets they hold (F1.3).
 *
 * Membership, not the user, is the unit of authorisation. The same person can be
 * an Owner of one workspace and a User in another, and a session is always bound
 * to one membership.
 */
export interface MembershipDoc {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  userId: Types.ObjectId;
  baseLevel: BaseLevel;
  permissionSetIds: Types.ObjectId[];
  /** Permissions granted to this member alone, outside any set. */
  extraPermissions: string[];
  /** F3.2. Set here in P4; declared now so the model is not reshaped later. */
  availabilityStatus: AvailabilityStatus;
  /** Denormalised for the assignment engine's max-open-leads rule (F3.3). */
  openLeadCount: number;
  createdAt: Date;
  updatedAt: Date;
}

const membershipSchema = new Schema<MembershipDoc>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    baseLevel: { type: String, required: true, enum: BASE_LEVELS },
    permissionSetIds: { type: [Schema.Types.ObjectId], ref: 'PermissionSet', default: [] },
    extraPermissions: { type: [String], default: [], enum: ASSIGNABLE_PERMISSIONS },
    availabilityStatus: { type: String, enum: AVAILABILITY_STATUSES, default: 'offline' },
    openLeadCount: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true },
);

// One membership per person per workspace.
membershipSchema.index({ workspaceId: 1, userId: 1 }, { unique: true });
// Counting Owners, to protect the last one.
membershipSchema.index({ workspaceId: 1, baseLevel: 1 });

export const MembershipModel = model<MembershipDoc>('Membership', membershipSchema);
