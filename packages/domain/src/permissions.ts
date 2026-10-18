/**
 * The permission vocabulary and the rules for deciding what a member may do
 * (F1.2, F1.3).
 *
 * Permissions are configurable per workspace and are never keyed on a role name:
 * a "Manager" is a permission set an Owner defines, not a fourth base level
 * (Section 2). Code therefore asks "does this member hold
 * `crm.record.delete`?", never "is this member a manager?".
 *
 * Pure, and shared by the server (which enforces) and the web app (which draws
 * the permission matrix), so the interface cannot offer a permission the server
 * does not understand.
 */

export const PERMISSIONS = {
  // --- CRM records (F1.3)
  CRM_VIEW: 'crm.record.view',
  CRM_CREATE: 'crm.record.create',
  CRM_EDIT: 'crm.record.edit',
  CRM_DELETE: 'crm.record.delete',
  CRM_EXPORT: 'crm.record.export',

  /**
   * Field-level protection (F1.4). Without this, an opportunity's value is
   * masked in lists, on detail pages and in exports, even for a member who may
   * otherwise view and edit the record.
   */
  OPPORTUNITY_VALUE_VIEW: 'opportunity.value.view',

  // --- Configuration
  ASSIGNMENT_RULES_MANAGE: 'assignment_rules.manage',
  INTEGRATIONS_MANAGE: 'integrations.manage',
  AUDIT_LOG_VIEW: 'audit_log.view',

  // --- Workspace administration. Carried by the base level rather than granted
  // through a permission set, so a workspace cannot accidentally define a set
  // that hands out member management.
  MEMBERS_MANAGE: 'members.manage',
  PERMISSIONS_MANAGE: 'permissions.manage',
  WORKSPACE_MANAGE: 'workspace.manage',
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const ALL_PERMISSIONS: readonly Permission[] = Object.values(PERMISSIONS);

export function isPermission(value: unknown): value is Permission {
  return typeof value === 'string' && (ALL_PERMISSIONS as readonly string[]).includes(value);
}

/**
 * Permissions a workspace may put into a permission set. The administration
 * permissions are excluded: they follow the base level.
 */
export const ASSIGNABLE_PERMISSIONS: readonly Permission[] = ALL_PERMISSIONS.filter(
  (permission) =>
    permission !== PERMISSIONS.MEMBERS_MANAGE &&
    permission !== PERMISSIONS.PERMISSIONS_MANAGE &&
    permission !== PERMISSIONS.WORKSPACE_MANAGE,
);

// ---------------------------------------------------------------------------
// Base levels
// ---------------------------------------------------------------------------

/** The three fixed levels (F1.2). Everything else is configuration. */
export const BASE_LEVELS = ['owner', 'admin', 'user'] as const;
export type BaseLevel = (typeof BASE_LEVELS)[number];

export function isBaseLevel(value: unknown): value is BaseLevel {
  return typeof value === 'string' && (BASE_LEVELS as readonly string[]).includes(value);
}

/**
 * What the level itself carries, before any permission set.
 *
 * An Owner holds everything and cannot be reduced: they pay for the workspace
 * and must never be able to lock themselves out of it. An Admin can run the
 * workspace and its members but cannot edit the permission matrix, which is the
 * Owner's alone. A User carries nothing; everything they can do comes from a
 * permission set an Owner gave them.
 */
const BASE_LEVEL_PERMISSIONS: Record<BaseLevel, readonly Permission[]> = {
  owner: ALL_PERMISSIONS,
  admin: [PERMISSIONS.MEMBERS_MANAGE, PERMISSIONS.WORKSPACE_MANAGE],
  user: [],
};

export function baseLevelPermissions(level: BaseLevel): readonly Permission[] {
  return BASE_LEVEL_PERMISSIONS[level];
}

// ---------------------------------------------------------------------------
// Effective permissions
// ---------------------------------------------------------------------------

export interface PermissionSetLike {
  readonly permissions: readonly string[];
}

export interface MembershipPermissionInput {
  readonly baseLevel: BaseLevel;
  /** Permission sets the member belongs to; the role-like configuration. */
  readonly permissionSets: readonly PermissionSetLike[];
  /** Permissions granted to this one member, outside any set. */
  readonly extraPermissions?: readonly string[];
}

/**
 * Everything a member may do: the union of their base level, their permission
 * sets and any direct grants.
 *
 * Unknown strings are dropped rather than carried, so a permission removed from
 * the codebase cannot keep granting access through a stale stored set.
 */
export function effectivePermissions(
  membership: MembershipPermissionInput,
): ReadonlySet<Permission> {
  if (membership.baseLevel === 'owner') return new Set(ALL_PERMISSIONS);

  const effective = new Set<Permission>(baseLevelPermissions(membership.baseLevel));

  for (const set of membership.permissionSets) {
    for (const permission of set.permissions) {
      if (isPermission(permission)) effective.add(permission);
    }
  }

  for (const permission of membership.extraPermissions ?? []) {
    if (isPermission(permission)) effective.add(permission);
  }

  return effective;
}

export function hasPermission(effective: ReadonlySet<Permission>, permission: Permission): boolean {
  return effective.has(permission);
}

export function hasAllPermissions(
  effective: ReadonlySet<Permission>,
  permissions: readonly Permission[],
): boolean {
  return permissions.every((permission) => effective.has(permission));
}

// ---------------------------------------------------------------------------
// Who may change whom
// ---------------------------------------------------------------------------

export const MEMBERSHIP_ACTIONS = [
  'invite',
  'change_base_level',
  'change_permissions',
  'remove',
] as const;
export type MembershipAction = (typeof MEMBERSHIP_ACTIONS)[number];

export const MEMBERSHIP_DENIAL_REASONS = {
  NOT_PERMITTED: 'not_permitted',
  /** F1.2: an Admin cannot modify the Owner. */
  ADMIN_CANNOT_TOUCH_OWNER: 'admin_cannot_touch_owner',
  /** Only an Owner may create another Owner. */
  ONLY_OWNER_GRANTS_OWNER: 'only_owner_grants_owner',
  /** The permission matrix is the Owner's alone. */
  ONLY_OWNER_EDITS_PERMISSIONS: 'only_owner_edits_permissions',
  /** A workspace must keep at least one Owner, or nobody can administer it. */
  WOULD_REMOVE_LAST_OWNER: 'would_remove_last_owner',
} as const;

export type MembershipDenialReason =
  (typeof MEMBERSHIP_DENIAL_REASONS)[keyof typeof MEMBERSHIP_DENIAL_REASONS];

export type MembershipDecision =
  { readonly allowed: true } | { readonly allowed: false; readonly reason: MembershipDenialReason };

const ALLOWED: MembershipDecision = { allowed: true };
const deny = (reason: MembershipDenialReason): MembershipDecision => ({
  allowed: false,
  reason,
});

export interface MembershipChangeRequest {
  readonly actor: {
    readonly membershipId: string;
    readonly baseLevel: BaseLevel;
    readonly permissions: ReadonlySet<Permission>;
  };
  /** Absent for an invite, which has no existing membership to act on. */
  readonly target?: {
    readonly membershipId: string;
    readonly baseLevel: BaseLevel;
  };
  readonly action: MembershipAction;
  /** The level being granted, for `invite` and `change_base_level`. */
  readonly nextBaseLevel?: BaseLevel;
  /** Owners currently in the workspace, to protect the last one. */
  readonly ownerCount: number;
}

/**
 * Decides whether `actor` may perform `action` on `target`.
 *
 * This is the rule F1.2's "an Admin cannot modify the Owner" names, and it is
 * applied in the service rather than only in a route, so no future endpoint can
 * reach a membership without passing through it.
 */
export function canManageMembership(request: MembershipChangeRequest): MembershipDecision {
  const { actor, target, action, nextBaseLevel, ownerCount } = request;

  if (action === 'change_permissions') {
    // The matrix is the Owner's. An Admin may move people between levels but
    // not redefine what a level can do.
    if (actor.baseLevel !== 'owner')
      return deny(MEMBERSHIP_DENIAL_REASONS.ONLY_OWNER_EDITS_PERMISSIONS);
  } else if (!hasPermission(actor.permissions, PERMISSIONS.MEMBERS_MANAGE)) {
    return deny(MEMBERSHIP_DENIAL_REASONS.NOT_PERMITTED);
  }

  // Creating or promoting to Owner is the Owner's alone.
  if (nextBaseLevel === 'owner' && actor.baseLevel !== 'owner') {
    return deny(MEMBERSHIP_DENIAL_REASONS.ONLY_OWNER_GRANTS_OWNER);
  }

  if (target === undefined) return ALLOWED;

  // An Admin may not touch an Owner's membership in any way (F1.2).
  if (target.baseLevel === 'owner' && actor.baseLevel !== 'owner') {
    return deny(MEMBERSHIP_DENIAL_REASONS.ADMIN_CANNOT_TOUCH_OWNER);
  }

  // Even an Owner may not leave the workspace without one.
  const losesAnOwner =
    target.baseLevel === 'owner' &&
    (action === 'remove' || (action === 'change_base_level' && nextBaseLevel !== 'owner'));

  if (losesAnOwner && ownerCount <= 1) {
    return deny(MEMBERSHIP_DENIAL_REASONS.WOULD_REMOVE_LAST_OWNER);
  }

  return ALLOWED;
}

// ---------------------------------------------------------------------------
// Default permission sets
// ---------------------------------------------------------------------------

export interface DefaultPermissionSet {
  readonly name: string;
  readonly description: string;
  readonly permissions: readonly Permission[];
  /** Which base level is given this set when invited. */
  readonly defaultForBaseLevel: BaseLevel | null;
}

/**
 * Seeded into every new workspace so it is usable immediately, and editable
 * afterwards like any other set. "Manager" is the configurable role Section 2
 * describes: built from permissions, not a hard-coded level.
 */
export const DEFAULT_PERMISSION_SETS: readonly DefaultPermissionSet[] = [
  {
    name: 'Administrator',
    description: 'Full access to records, configuration, integrations and the audit log.',
    permissions: ASSIGNABLE_PERMISSIONS,
    defaultForBaseLevel: 'admin',
  },
  {
    name: 'Manager',
    description: 'Sees values and the audit log, and manages how leads are distributed.',
    permissions: [
      PERMISSIONS.CRM_VIEW,
      PERMISSIONS.CRM_CREATE,
      PERMISSIONS.CRM_EDIT,
      PERMISSIONS.CRM_EXPORT,
      PERMISSIONS.OPPORTUNITY_VALUE_VIEW,
      PERMISSIONS.ASSIGNMENT_RULES_MANAGE,
      PERMISSIONS.AUDIT_LOG_VIEW,
    ],
    defaultForBaseLevel: null,
  },
  {
    name: 'Member',
    description: 'Works on records. Opportunity values are hidden.',
    permissions: [PERMISSIONS.CRM_VIEW, PERMISSIONS.CRM_CREATE, PERMISSIONS.CRM_EDIT],
    defaultForBaseLevel: 'user',
  },
];
