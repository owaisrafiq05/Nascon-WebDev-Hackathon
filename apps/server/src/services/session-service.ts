import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { effectivePermissions, type BaseLevel, type Permission } from '@ubmp/domain';
import type { Types } from 'mongoose';

import { MembershipModel } from '../db/models/membership.js';
import { PermissionSetModel } from '../db/models/permission-set.js';
import { SessionModel, type SessionDoc } from '../db/models/session.js';

/**
 * Session issue, lookup and revocation (Q1).
 *
 * The cookie holds 32 random bytes; the database holds only their SHA-256
 * digest. A plain digest is sufficient rather than a keyed one because the token
 * is 256 bits of entropy, so there is nothing to guess and no key to manage.
 */
const TOKEN_BYTES = 32;

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** The authenticated caller, resolved once per request. */
export interface AuthContext {
  readonly sessionId: string;
  readonly userId: Types.ObjectId;
  readonly workspaceId: Types.ObjectId;
  readonly membershipId: Types.ObjectId;
  readonly baseLevel: BaseLevel;
  readonly permissions: ReadonlySet<Permission>;
  readonly csrfToken: string;
}

export interface IssuedSession {
  /** Returned once, to be set as the cookie. Never stored or logged. */
  readonly token: string;
  readonly csrfToken: string;
  readonly expiresAt: Date;
  readonly sessionId: string;
}

export interface IssueSessionInput {
  readonly userId: Types.ObjectId;
  readonly workspaceId: Types.ObjectId;
  readonly membershipId: Types.ObjectId;
  readonly ttlMs: number;
  readonly ip?: string | undefined;
  readonly userAgent?: string | undefined;
}

export async function issueSession(input: IssueSessionInput): Promise<IssuedSession> {
  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  const csrfToken = randomBytes(TOKEN_BYTES).toString('base64url');
  const expiresAt = new Date(Date.now() + input.ttlMs);

  const session = await SessionModel.create({
    tokenHash: hashSessionToken(token),
    userId: input.userId,
    workspaceId: input.workspaceId,
    membershipId: input.membershipId,
    csrfToken,
    expiresAt,
    lastSeenAt: new Date(),
    ip: input.ip ?? null,
    // Truncated: it is only ever displayed, never used for a decision.
    userAgent: input.userAgent?.slice(0, 256) ?? null,
  });

  return { token, csrfToken, expiresAt, sessionId: session._id.toString() };
}

/**
 * Resolves a cookie token into an authorisation context, or `null`.
 *
 * Permissions are read on every request rather than baked into the cookie, so
 * removing someone's permission takes effect immediately instead of when their
 * session happens to expire. That is the reason sessions are server-side.
 */
export async function resolveSession(token: string): Promise<AuthContext | null> {
  const session = await SessionModel.findOne({ tokenHash: hashSessionToken(token) }).lean();
  if (session === null) return null;

  // Checked here as well as by the TTL index, which is best-effort and may not
  // have run yet.
  if (session.revokedAt !== null) return null;
  if (session.expiresAt.getTime() <= Date.now()) return null;

  const membership = await MembershipModel.findOne({
    _id: session.membershipId,
    workspaceId: session.workspaceId,
  }).lean();

  // The membership was removed while the session was alive: the session is no
  // longer usable, whatever the cookie says.
  if (membership === null) return null;

  const permissionSets =
    membership.permissionSetIds.length === 0
      ? []
      : await PermissionSetModel.find({
          _id: { $in: membership.permissionSetIds },
          workspaceId: session.workspaceId,
        })
          .select('permissions')
          .lean();

  return {
    sessionId: session._id.toString(),
    userId: session.userId,
    workspaceId: session.workspaceId,
    membershipId: membership._id,
    baseLevel: membership.baseLevel,
    permissions: effectivePermissions({
      baseLevel: membership.baseLevel,
      permissionSets,
      extraPermissions: membership.extraPermissions,
    }),
    csrfToken: session.csrfToken,
  };
}

/** Records that the session was used, for the "your sessions" list. */
export async function touchSession(sessionId: string): Promise<void> {
  await SessionModel.updateOne({ _id: sessionId }, { $set: { lastSeenAt: new Date() } });
}

/** Ends one session. The row is kept, so the logout remains auditable. */
export async function revokeSession(token: string): Promise<boolean> {
  const result = await SessionModel.updateOne(
    { tokenHash: hashSessionToken(token), revokedAt: null },
    { $set: { revokedAt: new Date() } },
  );

  return result.modifiedCount > 0;
}

/**
 * Ends every session a user holds. Used when a password changes and when a
 * membership is removed, so access cannot outlive either.
 */
export async function revokeAllSessionsForUser(userId: Types.ObjectId): Promise<number> {
  const result = await SessionModel.updateMany(
    { userId, revokedAt: null },
    { $set: { revokedAt: new Date() } },
  );

  return result.modifiedCount;
}

export async function revokeSessionsForMembership(membershipId: Types.ObjectId): Promise<number> {
  const result = await SessionModel.updateMany(
    { membershipId, revokedAt: null },
    { $set: { revokedAt: new Date() } },
  );

  return result.modifiedCount;
}

/** Constant-time comparison, so a CSRF check cannot be probed byte by byte. */
export function csrfTokenMatches(expected: string, supplied: string): boolean {
  const expectedBuffer = Buffer.from(expected, 'utf8');
  const suppliedBuffer = Buffer.from(supplied, 'utf8');

  if (expectedBuffer.length !== suppliedBuffer.length) return false;
  return timingSafeEqual(expectedBuffer, suppliedBuffer);
}

export type { SessionDoc };
