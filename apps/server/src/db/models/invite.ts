import { BASE_LEVELS, type BaseLevel } from '@ubmp/domain';
import { model, Schema, type Types } from 'mongoose';

/**
 * A pending invitation (F1.2). Like sessions, only the SHA-256 digest of the
 * token is stored, so the link in the email cannot be reconstructed from the
 * database.
 *
 * The membership is created when the invitation is accepted, not when it is
 * sent, so a pending invitation never counts as a member and an unaccepted
 * invitation never receives a lead.
 */
export interface InviteDoc {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  email: string;
  baseLevel: BaseLevel;
  permissionSetIds: Types.ObjectId[];
  tokenHash: string;
  expiresAt: Date;
  invitedByMembershipId: Types.ObjectId;
  acceptedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const inviteSchema = new Schema<InviteDoc>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true, index: true },
    email: { type: String, required: true, lowercase: true, trim: true, maxlength: 320 },
    baseLevel: { type: String, required: true, enum: BASE_LEVELS },
    permissionSetIds: { type: [Schema.Types.ObjectId], ref: 'PermissionSet', default: [] },
    tokenHash: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true },
    invitedByMembershipId: { type: Schema.Types.ObjectId, ref: 'Membership', required: true },
    acceptedAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// One live invitation per address per workspace. Accepted and revoked rows are
// kept for the audit trail, so the uniqueness is partial.
inviteSchema.index(
  { workspaceId: 1, email: 1 },
  { unique: true, partialFilterExpression: { acceptedAt: null, revokedAt: null } },
);

export const InviteModel = model<InviteDoc>('Invite', inviteSchema);
