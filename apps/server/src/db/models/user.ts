import { model, Schema, type Types } from 'mongoose';

/**
 * A person. Users are global, not per workspace: one person may be a member of
 * several workspaces with a different level in each, which is what the
 * `memberships` collection records.
 */
export const USER_STATUSES = ['invited', 'active', 'disabled'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export interface UserDoc {
  _id: Types.ObjectId;
  email: string;
  /**
   * argon2id digest. `null` only while the user is `invited` and has not yet
   * chosen a password. Plaintext is never stored or logged (Q1).
   */
  passwordHash: string | null;
  name: string;
  status: UserStatus;
  createdAt: Date;
  updatedAt: Date;
}

const userSchema = new Schema<UserDoc>(
  {
    // Stored lowercase and trimmed so one person cannot register twice with
    // different capitalisation and end up with two accounts.
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      maxlength: 320,
    },
    passwordHash: { type: String, default: null },
    name: { type: String, required: true, trim: true, maxlength: 200 },
    status: { type: String, required: true, enum: USER_STATUSES, default: 'invited' },
  },
  {
    timestamps: true,
    // The hash must never leave the server, even by accident, so it is excluded
    // from every serialisation of the document.
    toJSON: {
      transform: (_doc, record: Record<string, unknown>) => {
        delete record['passwordHash'];
        return record;
      },
    },
  },
);

export const UserModel = model<UserDoc>('User', userSchema);

/** Normalises an address the same way the schema stores it, for lookups. */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}
