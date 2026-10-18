import {
  AUDIT_EVENT_TYPES,
  DEFAULT_PERMISSION_SETS,
  effectivePermissions,
  type BaseLevel,
  type Permission,
} from '@ubmp/domain';
import { conflict, unauthenticated } from '@ubmp/shared';
import mongoose, { type Types } from 'mongoose';

import { MembershipModel } from '../db/models/membership.js';
import { PermissionSetModel } from '../db/models/permission-set.js';
import { normaliseEmail, UserModel } from '../db/models/user.js';
import { WorkspaceModel } from '../db/models/workspace.js';
import { appendAuditEvent } from '../repositories/audit-repository.js';
import { hashPassword, verifyPassword } from './password.js';

/**
 * Sign up, sign in and the identity behind a session (F1.1).
 *
 * Services never touch `req` or `res`: a route parses and responds, this decides
 * (CLAUDE.md).
 */

/**
 * One message for every failed sign-in, whatever the cause (Q1).
 *
 * "No such account", "wrong password" and "account disabled" are
 * indistinguishable, so the form cannot be used to discover which addresses are
 * registered.
 */
export const GENERIC_LOGIN_FAILURE = 'That email and password do not match an account.';

export interface SignUpInput {
  readonly email: string;
  readonly password: string;
  readonly name: string;
  readonly workspaceName: string;
  readonly requestId?: string | undefined;
}

export interface SignUpResult {
  readonly userId: Types.ObjectId;
  readonly workspaceId: Types.ObjectId;
  readonly membershipId: Types.ObjectId;
}

/**
 * Creates the user, their workspace, the workspace's default permission sets and
 * an Owner membership — all in one transaction (F1.1).
 *
 * A transaction rather than compensating logic: the four documents are
 * meaningless apart, and a half-finished sign-up would leave an account that can
 * authenticate but belongs to no workspace, or a workspace with no Owner, which
 * nothing in the platform could repair. MongoDB runs as a replica set precisely
 * so this is available (see docker-compose.yml).
 */
export async function signUp(input: SignUpInput): Promise<SignUpResult> {
  const email = normaliseEmail(input.email);

  // Hashing is slow by design, so it happens before the transaction opens
  // rather than holding it for the duration.
  const passwordHash = await hashPassword(input.password);

  const existing = await UserModel.findOne({ email }).select('_id').lean();
  if (existing !== null) {
    // The same wording the interface shows; it reveals nothing a sign-up form
    // could not already discover by trying.
    throw conflict('An account already exists for that email address.', {
      hint: 'Sign in instead, or use a different address.',
    });
  }

  const session = await mongoose.startSession();
  try {
    let result: SignUpResult | undefined;

    await session.withTransaction(async () => {
      const [user] = await UserModel.create(
        [{ email, passwordHash, name: input.name.trim(), status: 'active' }],
        { session },
      );
      if (user === undefined) throw new Error('user was not created');

      const [workspace] = await WorkspaceModel.create(
        [{ name: input.workspaceName.trim(), createdByUserId: user._id }],
        { session },
      );
      if (workspace === undefined) throw new Error('workspace was not created');

      // Seeded so the workspace is usable at once and the matrix editor has
      // something to show (F1.3).
      // `ordered` is required by Mongoose for a multi-document create inside a
      // session, and is what we want anyway: the seed either lands whole or not
      // at all.
      await PermissionSetModel.create(
        DEFAULT_PERMISSION_SETS.map((set) => ({
          workspaceId: workspace._id,
          name: set.name,
          description: set.description,
          permissions: [...set.permissions],
          defaultForBaseLevel: set.defaultForBaseLevel,
        })),
        { session, ordered: true },
      );

      // The first user is the Owner (F1.1). No permission sets are attached:
      // an Owner holds everything by level.
      const [membership] = await MembershipModel.create(
        [
          {
            workspaceId: workspace._id,
            userId: user._id,
            baseLevel: 'owner' satisfies BaseLevel,
            permissionSetIds: [],
            extraPermissions: [],
            availabilityStatus: 'available',
            openLeadCount: 0,
          },
        ],
        { session },
      );
      if (membership === undefined) throw new Error('membership was not created');

      await appendAuditEvent(
        {
          workspaceId: workspace._id,
          type: AUDIT_EVENT_TYPES.USER_ROLE_CHANGED,
          actor: { kind: 'user', userId: user._id, membershipId: membership._id, label: email },
          target: { kind: 'membership', id: membership._id.toString(), label: email },
          after: { baseLevel: 'owner', reason: 'workspace created' },
          requestId: input.requestId,
        },
        session,
      );

      result = {
        userId: user._id,
        workspaceId: workspace._id,
        membershipId: membership._id,
      };
    });

    if (result === undefined) throw new Error('sign-up transaction produced no result');
    return result;
  } finally {
    await session.endSession();
  }
}

export interface LoginInput {
  readonly email: string;
  readonly password: string;
}

export interface LoginResult {
  readonly userId: Types.ObjectId;
  readonly workspaceId: Types.ObjectId;
  readonly membershipId: Types.ObjectId;
}

/**
 * Verifies credentials and returns the membership a session should be bound to.
 *
 * Every failure path raises the same error with the same message, and a password
 * is verified even when no user was found, so a missing account and a wrong
 * password take the same time and cannot be told apart by timing either.
 */
export async function login(input: LoginInput): Promise<LoginResult> {
  const email = normaliseEmail(input.email);
  const user = await UserModel.findOne({ email }).select('_id passwordHash status').lean();

  const matches = await verifyPassword(user?.passwordHash ?? null, input.password);

  if (user === null || !matches || user.status !== 'active') {
    throw unauthenticated(GENERIC_LOGIN_FAILURE, {
      hint: 'Check both fields and try again.',
    });
  }

  // A user may belong to several workspaces. The most recently created
  // membership is used; P3 adds an explicit workspace switcher.
  const membership = await MembershipModel.findOne({ userId: user._id })
    .sort({ createdAt: -1 })
    .select('_id workspaceId')
    .lean();

  if (membership === null) {
    // Authenticated but belongs to nothing. Reported the same generic way, so
    // the form cannot be used to learn that the address exists.
    throw unauthenticated(GENERIC_LOGIN_FAILURE, {
      hint: 'Check both fields and try again.',
    });
  }

  return {
    userId: user._id,
    workspaceId: membership.workspaceId,
    membershipId: membership._id,
  };
}

export interface CurrentIdentity {
  readonly user: { readonly id: string; readonly email: string; readonly name: string };
  readonly workspace: { readonly id: string; readonly name: string };
  readonly membership: {
    readonly id: string;
    readonly baseLevel: BaseLevel;
    readonly permissions: readonly Permission[];
  };
}

/** Everything the web app needs to render for the signed-in member (`/me`). */
export async function currentIdentity(
  userId: Types.ObjectId,
  workspaceId: Types.ObjectId,
  membershipId: Types.ObjectId,
): Promise<CurrentIdentity | null> {
  const [user, workspace, membership] = await Promise.all([
    UserModel.findById(userId).select('email name').lean(),
    WorkspaceModel.findById(workspaceId).select('name').lean(),
    MembershipModel.findOne({ _id: membershipId, workspaceId }).lean(),
  ]);

  if (user === null || workspace === null || membership === null) return null;

  const permissionSets =
    membership.permissionSetIds.length === 0
      ? []
      : await PermissionSetModel.find({
          _id: { $in: membership.permissionSetIds },
          workspaceId,
        })
          .select('permissions')
          .lean();

  const permissions = effectivePermissions({
    baseLevel: membership.baseLevel,
    permissionSets,
    extraPermissions: membership.extraPermissions,
  });

  return {
    user: { id: user._id.toString(), email: user.email, name: user.name },
    workspace: { id: workspace._id.toString(), name: workspace.name },
    membership: {
      id: membership._id.toString(),
      baseLevel: membership.baseLevel,
      // Sorted so the response is stable and easy to assert on.
      permissions: [...permissions].sort(),
    },
  };
}
