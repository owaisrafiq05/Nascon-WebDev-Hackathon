import { model, Schema, type Types } from 'mongoose';

/**
 * A server-side session (Q1). The cookie carries a random token; this collection
 * stores only its SHA-256 digest, so a database leak yields nothing that can be
 * replayed as a cookie.
 *
 * Keeping sessions in MongoDB rather than in a signed stateless token is what
 * makes revocation real: ending a session, or changing someone's level, takes
 * effect on the next request rather than whenever a token happens to expire.
 */
export interface SessionDoc {
  _id: Types.ObjectId;
  /** SHA-256 of the cookie token. The token itself is never stored. */
  tokenHash: string;
  userId: Types.ObjectId;
  /** The workspace this session acts in. Scoping comes from here, never a URL. */
  workspaceId: Types.ObjectId;
  membershipId: Types.ObjectId;
  /** Synchroniser token compared against the X-CSRF-Token header (Q3). */
  csrfToken: string;
  expiresAt: Date;
  lastSeenAt: Date;
  /** Set when the session is ended; the row is kept so logout is auditable. */
  revokedAt: Date | null;
  /** Truncated, for the "your sessions" list. Never used for authorisation. */
  ip: string | null;
  userAgent: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const sessionSchema = new Schema<SessionDoc>(
  {
    tokenHash: { type: String, required: true, unique: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true },
    membershipId: { type: Schema.Types.ObjectId, ref: 'Membership', required: true },
    csrfToken: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    lastSeenAt: { type: Date, required: true, default: () => new Date() },
    revokedAt: { type: Date, default: null },
    ip: { type: String, default: null, maxlength: 64 },
    userAgent: { type: String, default: null, maxlength: 256 },
  },
  { timestamps: true },
);

// MongoDB removes expired sessions on its own. Authorisation never relies on
// this having run: every lookup also checks `expiresAt` and `revokedAt`.
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const SessionModel = model<SessionDoc>('Session', sessionSchema);
