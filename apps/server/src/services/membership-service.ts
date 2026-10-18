import { createHash, randomBytes } from 'node:crypto';

import {
  AUDIT_EVENT_TYPES,
  canManageMembership,
  effectivePermissions,
  isPermission,
  type BaseLevel,
  type MembershipAction,
  type MembershipDenialReason,
  type Permission,
} from '@ubmp/domain';
import { badRequest, conflict, forbidden, notFound } from '@ubmp/shared';
import mongoose, { Types } from 'mongoose';

import { InviteModel } from '../db/models/invite.js';
import { MembershipModel } from '../db/models/membership.js';
import { PermissionSetModel } from '../db/models/permission-set.js';
import { normaliseEmail, UserModel } from '../db/models/user.js';
import { appendAuditEvent } from '../repositories/audit-repository.js';
import { hashPassword } from './password.js';
import { revokeAllSessionsForUser, revokeSessionsForMembership } from './session-service.js';
import type { AuthContext } from './session-service.js';

/**
 * Membership and invitation use cases (F1.2, F1.3).
 *
 * Every change runs `canManageMembership` from the domain **in the service**, not
 * only in a route, so no endpoint added later can reach a membership without the
 * rule applying (CLAUDE.md: "checked in middleware AND in services for sensitive
 * actions"). Each change also appends an audit entry in the same transaction, so
 * a change can never commit unaudited (F4.1).
 */

function denialToError(reason: MembershipDenialReason): never {
  const messages: Record<MembershipDenialReason, string> = {
    not_permitted: 'You do not have permission to manage members.',
    admin_cannot_touch_owner: 'Only an Owner can change the Owner of a workspace.',
    only_owner_grants_owner: 'Only an Owner can make someone else an Owner.',
    only_owner_edits_permissions: 'Only an Owner can change what a member may do.',
    would_remove_last_owner: 'A workspace must always have at least one Owner.',
  };

  throw forbidden(messages[reason], { details: { reason } });
}

/** Counting Owners is what protects the last one, so it is always read fresh. */
async function countOwners(workspaceId: Types.ObjectId): Promise<number> {
  return MembershipModel.countDocuments({ workspaceId, baseLevel: 'owner' });
}

async function actorFor(auth: AuthContext): Promise<{
  membershipId: string;
  baseLevel: BaseLevel;
  permissions: ReadonlySet<Permission>;
  label: string;
}> {
  const user = await UserModel.findById(auth.userId).select('email').lean();

  return {
    membershipId: auth.membershipId.toString(),
    baseLevel: auth.baseLevel,
    permissions: auth.permissions,
    label: user?.email ?? auth.userId.toString(),
  };
}

/** Runs the domain rule, raising a readable error when it refuses. */
async function authorise(
  auth: AuthContext,
  action: MembershipAction,
  target: { membershipId: string; baseLevel: BaseLevel } | undefined,
  nextBaseLevel: BaseLevel | undefined,
): Promise<void> {
  const decision = canManageMembership({
    actor: {
      membershipId: auth.membershipId.toString(),
      baseLevel: auth.baseLevel,
      permissions: auth.permissions,
    },
    ...(target === undefined ? {} : { target }),
    action,
    ...(nextBaseLevel === undefined ? {} : { nextBaseLevel }),
    ownerCount: await countOwners(auth.workspaceId),
  });

  if (!decision.allowed) denialToError(decision.reason);
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

export interface MemberView {
  readonly membershipId: string;
  readonly userId: string;
  readonly email: string;
  readonly name: string;
  readonly baseLevel: BaseLevel;
  readonly permissionSetIds: readonly string[];
  readonly extraPermissions: readonly string[];
  readonly permissions: readonly Permission[];
  readonly availabilityStatus: string;
}

export interface PendingInviteView {
  readonly inviteId: string;
  readonly email: string;
  readonly baseLevel: BaseLevel;
  readonly permissionSetIds: readonly string[];
  readonly expiresAt: string;
  readonly expired: boolean;
}

/** The Team page: who is in the workspace, and who has been invited. */
export async function listMembers(workspaceId: Types.ObjectId): Promise<readonly MemberView[]> {
  const memberships = await MembershipModel.find({ workspaceId }).sort({ createdAt: 1 }).lean();

  const [users, sets] = await Promise.all([
    UserModel.find({ _id: { $in: memberships.map((membership) => membership.userId) } })
      .select('email name')
      .lean(),
    PermissionSetModel.find({ workspaceId }).select('permissions').lean(),
  ]);

  const userById = new Map(users.map((user) => [user._id.toString(), user]));
  const setById = new Map(sets.map((set) => [set._id.toString(), set]));

  return memberships.map((membership) => {
    const user = userById.get(membership.userId.toString());
    const permissionSets = membership.permissionSetIds
      .map((id) => setById.get(id.toString()))
      .filter((set): set is NonNullable<typeof set> => set !== undefined);

    return {
      membershipId: membership._id.toString(),
      userId: membership.userId.toString(),
      email: user?.email ?? '(removed account)',
      name: user?.name ?? '',
      baseLevel: membership.baseLevel,
      permissionSetIds: membership.permissionSetIds.map((id) => id.toString()),
      extraPermissions: membership.extraPermissions,
      permissions: [
        ...effectivePermissions({
          baseLevel: membership.baseLevel,
          permissionSets,
          extraPermissions: membership.extraPermissions,
        }),
      ].sort(),
      availabilityStatus: membership.availabilityStatus,
    };
  });
}

export async function listPendingInvites(
  workspaceId: Types.ObjectId,
): Promise<readonly PendingInviteView[]> {
  const invites = await InviteModel.find({ workspaceId, acceptedAt: null, revokedAt: null })
    .sort({ createdAt: -1 })
    .lean();

  const now = Date.now();
  return invites.map((invite) => ({
    inviteId: invite._id.toString(),
    email: invite.email,
    baseLevel: invite.baseLevel,
    permissionSetIds: invite.permissionSetIds.map((id) => id.toString()),
    expiresAt: invite.expiresAt.toISOString(),
    expired: invite.expiresAt.getTime() <= now,
  }));
}

// ---------------------------------------------------------------------------
// Inviting
// ---------------------------------------------------------------------------

export interface InviteInput {
  readonly email: string;
  readonly baseLevel: BaseLevel;
  readonly permissionSetIds?: readonly string[] | undefined;
  readonly ttlMs: number;
  readonly requestId?: string | undefined;
}

export interface InviteResult {
  readonly inviteId: string;
  readonly email: string;
  /**
   * Returned once so the caller can deliver the link. Only its digest is
   * stored, so this is the sole opportunity to read it.
   *
   * P10 sends it over the notification provider. Until then the Team page shows
   * it to the inviter, which is why it is returned rather than only emailed.
   */
  readonly token: string;
  readonly expiresAt: string;
}

export async function inviteMember(auth: AuthContext, input: InviteInput): Promise<InviteResult> {
  await authorise(auth, 'invite', undefined, input.baseLevel);

  const email = normaliseEmail(input.email);
  const actor = await actorFor(auth);

  // Already a member of this workspace: an invitation would create a second
  // membership, which the unique index would refuse anyway.
  const existingUser = await UserModel.findOne({ email }).select('_id').lean();
  if (existingUser !== null) {
    const existingMembership = await MembershipModel.findOne({
      workspaceId: auth.workspaceId,
      userId: existingUser._id,
    })
      .select('_id')
      .lean();

    if (existingMembership !== null) {
      throw conflict('That person is already a member of this workspace.');
    }
  }

  const permissionSetIds = await resolvePermissionSetIds(
    auth.workspaceId,
    input.permissionSetIds,
    input.baseLevel,
  );

  const token = randomBytes(32).toString('base64url');
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const expiresAt = new Date(Date.now() + input.ttlMs);

  const session = await mongoose.startSession();
  try {
    let inviteId: string | undefined;

    await session.withTransaction(async () => {
      // A live invitation already exists for this address: replaced rather than
      // duplicated, so the Team page never shows two rows for one person.
      await InviteModel.updateMany(
        { workspaceId: auth.workspaceId, email, acceptedAt: null, revokedAt: null },
        { $set: { revokedAt: new Date() } },
        { session },
      );

      const [invite] = await InviteModel.create(
        [
          {
            workspaceId: auth.workspaceId,
            email,
            baseLevel: input.baseLevel,
            permissionSetIds,
            tokenHash,
            expiresAt,
            invitedByMembershipId: auth.membershipId,
          },
        ],
        { session, ordered: true },
      );
      if (invite === undefined) throw new Error('invite was not created');

      await appendAuditEvent(
        {
          workspaceId: auth.workspaceId,
          type: AUDIT_EVENT_TYPES.USER_INVITED,
          actor: {
            kind: 'user',
            userId: auth.userId,
            membershipId: auth.membershipId,
            label: actor.label,
          },
          target: { kind: 'invite', id: invite._id.toString(), label: email },
          after: { email, baseLevel: input.baseLevel, permissionSetIds },
          requestId: input.requestId,
        },
        session,
      );

      inviteId = invite._id.toString();
    });

    if (inviteId === undefined) throw new Error('invite transaction produced no result');

    return { inviteId, email, token, expiresAt: expiresAt.toISOString() };
  } finally {
    await session.endSession();
  }
}

/**
 * Defaults a new member to the workspace's set for their level, so an invited
 * User can work immediately rather than arriving with no permissions at all.
 */
async function resolvePermissionSetIds(
  workspaceId: Types.ObjectId,
  requested: readonly string[] | undefined,
  baseLevel: BaseLevel,
): Promise<Types.ObjectId[]> {
  if (requested !== undefined) {
    const ids = requested.map((id) => {
      if (!Types.ObjectId.isValid(id)) throw badRequest('That permission set does not exist.');
      return new Types.ObjectId(id);
    });

    // Every set must belong to this workspace: an id from another workspace
    // must not be attachable (F1.6).
    const found = await PermissionSetModel.countDocuments({
      _id: { $in: ids },
      workspaceId,
    });
    if (found !== ids.length) throw notFound('That permission set does not exist.');

    return ids;
  }

  const fallback = await PermissionSetModel.find({ workspaceId, defaultForBaseLevel: baseLevel })
    .select('_id')
    .lean();

  return fallback.map((set) => set._id);
}

// ---------------------------------------------------------------------------
// Accepting an invitation
// ---------------------------------------------------------------------------

export interface AcceptInviteInput {
  readonly token: string;
  readonly name?: string | undefined;
  /** Required only when the invitee has no account yet. */
  readonly password?: string | undefined;
  readonly requestId?: string | undefined;
}

export interface AcceptInviteResult {
  readonly userId: Types.ObjectId;
  readonly workspaceId: Types.ObjectId;
  readonly membershipId: Types.ObjectId;
}

/**
 * Turns an invitation into a membership (F1.2): "the invitee sets password
 * once".
 *
 * The membership is created here rather than at invitation time, so an
 * unaccepted invitation is never counted as a member and never receives a lead.
 */
export async function acceptInvite(input: AcceptInviteInput): Promise<AcceptInviteResult> {
  const tokenHash = createHash('sha256').update(input.token).digest('hex');

  const invite = await InviteModel.findOne({ tokenHash }).lean();

  // One message for every unusable invitation, so a token cannot be probed.
  const invalid = () =>
    notFound('That invitation is no longer valid.', {
      hint: 'Ask an Owner or Admin to send a new one.',
    });

  if (invite === null || invite.acceptedAt !== null || invite.revokedAt !== null) throw invalid();
  if (invite.expiresAt.getTime() <= Date.now()) throw invalid();

  const existingUser = await UserModel.findOne({ email: invite.email }).lean();

  // A brand new person must set a password; someone who already has an account
  // must not be asked for one, and must not be able to reset it this way.
  let passwordHash: string | null = null;
  if (existingUser === null || existingUser.passwordHash === null) {
    if (input.password === undefined) {
      throw badRequest('Choose a password to finish setting up your account.', {
        details: { fields: { password: 'is required' } },
      });
    }
    passwordHash = await hashPassword(input.password);
  }

  const session = await mongoose.startSession();
  try {
    let result: AcceptInviteResult | undefined;

    await session.withTransaction(async () => {
      // Claimed conditionally, so two clicks on the same link create one
      // membership rather than two (Q5).
      const claimed = await InviteModel.updateOne(
        { _id: invite._id, acceptedAt: null, revokedAt: null },
        { $set: { acceptedAt: new Date() } },
        { session },
      );
      if (claimed.modifiedCount !== 1) throw invalid();

      let userId: Types.ObjectId;
      if (existingUser === null) {
        const [user] = await UserModel.create(
          [
            {
              email: invite.email,
              passwordHash,
              name: input.name?.trim() ?? invite.email,
              status: 'active',
            },
          ],
          { session, ordered: true },
        );
        if (user === undefined) throw new Error('user was not created');
        userId = user._id;
      } else {
        userId = existingUser._id;
        await UserModel.updateOne(
          { _id: userId },
          {
            $set: {
              status: 'active',
              ...(passwordHash === null ? {} : { passwordHash }),
              ...(input.name === undefined ? {} : { name: input.name.trim() }),
            },
          },
          { session },
        );
      }

      const [membership] = await MembershipModel.create(
        [
          {
            workspaceId: invite.workspaceId,
            userId,
            baseLevel: invite.baseLevel,
            permissionSetIds: invite.permissionSetIds,
            extraPermissions: [],
            availabilityStatus: 'offline',
            openLeadCount: 0,
          },
        ],
        { session, ordered: true },
      );
      if (membership === undefined) throw new Error('membership was not created');

      await appendAuditEvent(
        {
          workspaceId: invite.workspaceId,
          type: AUDIT_EVENT_TYPES.USER_ROLE_CHANGED,
          actor: { kind: 'user', userId, membershipId: membership._id, label: invite.email },
          target: { kind: 'membership', id: membership._id.toString(), label: invite.email },
          after: { baseLevel: invite.baseLevel, reason: 'invitation accepted' },
          requestId: input.requestId,
        },
        session,
      );

      result = {
        userId,
        workspaceId: invite.workspaceId,
        membershipId: membership._id,
      };
    });

    if (result === undefined) throw new Error('accept transaction produced no result');
    return result;
  } finally {
    await session.endSession();
  }
}

// ---------------------------------------------------------------------------
// Changing a membership
// ---------------------------------------------------------------------------

async function loadTarget(
  workspaceId: Types.ObjectId,
  membershipId: string,
): Promise<{
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  baseLevel: BaseLevel;
  permissionSetIds: Types.ObjectId[];
  extraPermissions: string[];
}> {
  if (!Types.ObjectId.isValid(membershipId)) throw notFound('That member does not exist.');

  // Scoped by workspace, so a membership id from another workspace is simply
  // not found (F1.6, Q2).
  const membership = await MembershipModel.findOne({
    _id: new Types.ObjectId(membershipId),
    workspaceId,
  }).lean();

  if (membership === null) throw notFound('That member does not exist.');
  return membership;
}

export async function changeBaseLevel(
  auth: AuthContext,
  membershipId: string,
  nextBaseLevel: BaseLevel,
  requestId?: string,
): Promise<void> {
  const target = await loadTarget(auth.workspaceId, membershipId);
  await authorise(
    auth,
    'change_base_level',
    { membershipId: target._id.toString(), baseLevel: target.baseLevel },
    nextBaseLevel,
  );

  if (target.baseLevel === nextBaseLevel) return;

  const actor = await actorFor(auth);
  const targetUser = await UserModel.findById(target.userId).select('email').lean();

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      await MembershipModel.updateOne(
        { _id: target._id, workspaceId: auth.workspaceId, baseLevel: target.baseLevel },
        { $set: { baseLevel: nextBaseLevel } },
        { session },
      );

      await appendAuditEvent(
        {
          workspaceId: auth.workspaceId,
          type: AUDIT_EVENT_TYPES.USER_ROLE_CHANGED,
          actor: {
            kind: 'user',
            userId: auth.userId,
            membershipId: auth.membershipId,
            label: actor.label,
          },
          target: {
            kind: 'membership',
            id: target._id.toString(),
            label: targetUser?.email ?? '',
          },
          before: { baseLevel: target.baseLevel },
          after: { baseLevel: nextBaseLevel },
          ...(requestId === undefined ? {} : { requestId }),
        },
        session,
      );
    });
  } finally {
    await session.endSession();
  }

  // The level decides what the member may do, so any session they hold is
  // re-evaluated on its next request anyway; this makes the change immediate
  // even for a request already in flight.
  await revokeSessionsForMembership(target._id);
}

export interface ChangePermissionsInput {
  readonly permissionSetIds?: readonly string[] | undefined;
  readonly extraPermissions?: readonly string[] | undefined;
}

/** The permission matrix editor (F1.3). Owner only. */
export async function changePermissions(
  auth: AuthContext,
  membershipId: string,
  input: ChangePermissionsInput,
  requestId?: string,
): Promise<void> {
  const target = await loadTarget(auth.workspaceId, membershipId);
  await authorise(
    auth,
    'change_permissions',
    { membershipId: target._id.toString(), baseLevel: target.baseLevel },
    undefined,
  );

  const actor = await actorFor(auth);
  const targetUser = await UserModel.findById(target.userId).select('email').lean();

  const nextSetIds =
    input.permissionSetIds === undefined
      ? target.permissionSetIds
      : await resolvePermissionSetIds(auth.workspaceId, input.permissionSetIds, target.baseLevel);

  const nextExtras =
    input.extraPermissions === undefined
      ? target.extraPermissions
      : // Unknown strings are refused rather than stored, so the matrix cannot
        // accumulate permissions nothing understands.
        input.extraPermissions.map((permission) => {
          if (!isPermission(permission)) {
            throw badRequest(`Unknown permission: ${permission}`);
          }
          return permission;
        });

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      await MembershipModel.updateOne(
        { _id: target._id, workspaceId: auth.workspaceId },
        { $set: { permissionSetIds: nextSetIds, extraPermissions: nextExtras } },
        { session },
      );

      await appendAuditEvent(
        {
          workspaceId: auth.workspaceId,
          type: AUDIT_EVENT_TYPES.USER_PERMISSIONS_CHANGED,
          actor: {
            kind: 'user',
            userId: auth.userId,
            membershipId: auth.membershipId,
            label: actor.label,
          },
          target: {
            kind: 'membership',
            id: target._id.toString(),
            label: targetUser?.email ?? '',
          },
          before: {
            permissionSetIds: target.permissionSetIds.map((id) => id.toString()),
            extraPermissions: target.extraPermissions,
          },
          after: {
            permissionSetIds: nextSetIds.map((id) => id.toString()),
            extraPermissions: nextExtras,
          },
          ...(requestId === undefined ? {} : { requestId }),
        },
        session,
      );
    });
  } finally {
    await session.endSession();
  }
}

export async function removeMember(
  auth: AuthContext,
  membershipId: string,
  requestId?: string,
): Promise<void> {
  const target = await loadTarget(auth.workspaceId, membershipId);
  await authorise(
    auth,
    'remove',
    { membershipId: target._id.toString(), baseLevel: target.baseLevel },
    undefined,
  );

  const actor = await actorFor(auth);
  const targetUser = await UserModel.findById(target.userId).select('email').lean();

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      await MembershipModel.deleteOne(
        { _id: target._id, workspaceId: auth.workspaceId },
        { session },
      );

      await appendAuditEvent(
        {
          workspaceId: auth.workspaceId,
          type: AUDIT_EVENT_TYPES.USER_DELETED,
          actor: {
            kind: 'user',
            userId: auth.userId,
            membershipId: auth.membershipId,
            label: actor.label,
          },
          target: {
            kind: 'membership',
            id: target._id.toString(),
            label: targetUser?.email ?? '',
          },
          before: { baseLevel: target.baseLevel },
          ...(requestId === undefined ? {} : { requestId }),
        },
        session,
      );
    });
  } finally {
    await session.endSession();
  }

  // Access must not outlive the membership.
  await revokeAllSessionsForUser(target.userId);
}
