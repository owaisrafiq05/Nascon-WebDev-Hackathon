import {
  ASSIGNABLE_PERMISSIONS,
  AUDIT_EVENT_TYPES,
  isPermission,
  type BaseLevel,
  type Permission,
} from '@ubmp/domain';
import { badRequest, conflict, forbidden, notFound } from '@ubmp/shared';
import mongoose, { Types } from 'mongoose';

import { MembershipModel } from '../db/models/membership.js';
import { PermissionSetModel } from '../db/models/permission-set.js';
import { UserModel } from '../db/models/user.js';
import { appendAuditEvent } from '../repositories/audit-repository.js';
import type { AuthContext } from './session-service.js';

/**
 * The workspace's permission sets: the configurable, role-like part of F1.3.
 *
 * Only an Owner may change them. An Admin can move people between levels and
 * between existing sets, but redefining what a set grants is how someone would
 * escalate their own access, so it stays with the Owner.
 */

function requireOwner(auth: AuthContext): void {
  if (auth.baseLevel !== 'owner') {
    throw forbidden('Only an Owner can change what a permission set grants.', {
      details: { reason: 'only_owner_edits_permissions' },
    });
  }
}

/** Refuses anything not in `ASSIGNABLE_PERMISSIONS`, including admin rights. */
function validatePermissions(permissions: readonly string[]): Permission[] {
  return permissions.map((permission) => {
    if (!isPermission(permission)) {
      throw badRequest(`Unknown permission: ${permission}`);
    }
    if (!ASSIGNABLE_PERMISSIONS.includes(permission)) {
      // members.manage and the rest follow the base level; granting them
      // through a set would let an Owner-only capability be handed out.
      throw badRequest(`${permission} cannot be granted through a permission set.`, {
        hint: 'Workspace administration follows the base level instead.',
      });
    }
    return permission;
  });
}

export interface PermissionSetView {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly permissions: readonly string[];
  readonly defaultForBaseLevel: BaseLevel | null;
  readonly memberCount: number;
}

export async function listPermissionSets(
  workspaceId: Types.ObjectId,
): Promise<readonly PermissionSetView[]> {
  const sets = await PermissionSetModel.find({ workspaceId }).sort({ name: 1 }).lean();

  const counts = await MembershipModel.aggregate<{ _id: Types.ObjectId; count: number }>([
    { $match: { workspaceId } },
    { $unwind: '$permissionSetIds' },
    { $group: { _id: '$permissionSetIds', count: { $sum: 1 } } },
  ]);

  const countById = new Map(counts.map((entry) => [entry._id.toString(), entry.count]));

  return sets.map((set) => ({
    id: set._id.toString(),
    name: set.name,
    description: set.description,
    permissions: set.permissions,
    defaultForBaseLevel: set.defaultForBaseLevel,
    memberCount: countById.get(set._id.toString()) ?? 0,
  }));
}

async function actorLabel(auth: AuthContext): Promise<string> {
  const user = await UserModel.findById(auth.userId).select('email').lean();
  return user?.email ?? auth.userId.toString();
}

export interface CreatePermissionSetInput {
  readonly name: string;
  readonly description?: string | undefined;
  readonly permissions: readonly string[];
}

export async function createPermissionSet(
  auth: AuthContext,
  input: CreatePermissionSetInput,
  requestId?: string,
): Promise<{ id: string }> {
  requireOwner(auth);

  const permissions = validatePermissions(input.permissions);
  const label = await actorLabel(auth);

  const existing = await PermissionSetModel.findOne({
    workspaceId: auth.workspaceId,
    name: input.name.trim(),
  })
    .select('_id')
    .lean();

  if (existing !== null) throw conflict('A permission set with that name already exists.');

  const session = await mongoose.startSession();
  try {
    let id: string | undefined;

    await session.withTransaction(async () => {
      const [created] = await PermissionSetModel.create(
        [
          {
            workspaceId: auth.workspaceId,
            name: input.name.trim(),
            description: input.description?.trim() ?? '',
            permissions,
            defaultForBaseLevel: null,
          },
        ],
        { session, ordered: true },
      );
      if (created === undefined) throw new Error('permission set was not created');

      await appendAuditEvent(
        {
          workspaceId: auth.workspaceId,
          type: AUDIT_EVENT_TYPES.ROLE_CREATED,
          actor: {
            kind: 'user',
            userId: auth.userId,
            membershipId: auth.membershipId,
            label,
          },
          target: { kind: 'permission_set', id: created._id.toString(), label: created.name },
          after: { name: created.name, permissions },
          ...(requestId === undefined ? {} : { requestId }),
        },
        session,
      );

      id = created._id.toString();
    });

    if (id === undefined) throw new Error('create transaction produced no result');
    return { id };
  } finally {
    await session.endSession();
  }
}

export interface UpdatePermissionSetInput {
  readonly name?: string | undefined;
  readonly description?: string | undefined;
  readonly permissions?: readonly string[] | undefined;
}

export async function updatePermissionSet(
  auth: AuthContext,
  setId: string,
  input: UpdatePermissionSetInput,
  requestId?: string,
): Promise<void> {
  requireOwner(auth);

  if (!Types.ObjectId.isValid(setId)) throw notFound('That permission set does not exist.');

  // Scoped, so an id from another workspace is not found rather than editable.
  const set = await PermissionSetModel.findOne({
    _id: new Types.ObjectId(setId),
    workspaceId: auth.workspaceId,
  }).lean();

  if (set === null) throw notFound('That permission set does not exist.');

  const permissions =
    input.permissions === undefined ? set.permissions : validatePermissions(input.permissions);
  const label = await actorLabel(auth);

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      await PermissionSetModel.updateOne(
        { _id: set._id, workspaceId: auth.workspaceId },
        {
          $set: {
            ...(input.name === undefined ? {} : { name: input.name.trim() }),
            ...(input.description === undefined ? {} : { description: input.description.trim() }),
            permissions,
          },
        },
        { session },
      );

      await appendAuditEvent(
        {
          workspaceId: auth.workspaceId,
          type: AUDIT_EVENT_TYPES.ROLE_UPDATED,
          actor: {
            kind: 'user',
            userId: auth.userId,
            membershipId: auth.membershipId,
            label,
          },
          target: { kind: 'permission_set', id: set._id.toString(), label: set.name },
          before: { name: set.name, permissions: set.permissions },
          after: { name: input.name?.trim() ?? set.name, permissions },
          ...(requestId === undefined ? {} : { requestId }),
        },
        session,
      );
    });
  } finally {
    await session.endSession();
  }
}

/**
 * Deleting a set detaches it from every membership in the same transaction, so
 * no membership is left pointing at a set that no longer exists (Q4).
 */
export async function deletePermissionSet(
  auth: AuthContext,
  setId: string,
  requestId?: string,
): Promise<void> {
  requireOwner(auth);

  if (!Types.ObjectId.isValid(setId)) throw notFound('That permission set does not exist.');

  const set = await PermissionSetModel.findOne({
    _id: new Types.ObjectId(setId),
    workspaceId: auth.workspaceId,
  }).lean();

  if (set === null) throw notFound('That permission set does not exist.');

  const label = await actorLabel(auth);

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      await MembershipModel.updateMany(
        { workspaceId: auth.workspaceId, permissionSetIds: set._id },
        { $pull: { permissionSetIds: set._id } },
        { session },
      );

      await PermissionSetModel.deleteOne(
        { _id: set._id, workspaceId: auth.workspaceId },
        { session },
      );

      await appendAuditEvent(
        {
          workspaceId: auth.workspaceId,
          type: AUDIT_EVENT_TYPES.ROLE_DELETED,
          actor: {
            kind: 'user',
            userId: auth.userId,
            membershipId: auth.membershipId,
            label,
          },
          target: { kind: 'permission_set', id: set._id.toString(), label: set.name },
          before: { name: set.name, permissions: set.permissions },
          ...(requestId === undefined ? {} : { requestId }),
        },
        session,
      );
    });
  } finally {
    await session.endSession();
  }
}
