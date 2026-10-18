import { describe, expect, it } from 'vitest';

import {
  ALL_PERMISSIONS,
  ASSIGNABLE_PERMISSIONS,
  BASE_LEVELS,
  type BaseLevel,
  baseLevelPermissions,
  canManageMembership,
  DEFAULT_PERMISSION_SETS,
  effectivePermissions,
  hasAllPermissions,
  hasPermission,
  isBaseLevel,
  isPermission,
  MEMBERSHIP_DENIAL_REASONS,
  type Permission,
  PERMISSIONS,
} from './permissions.js';

describe('PERMISSIONS', () => {
  it('covers everything F1.3 requires to be grantable', () => {
    const required: Permission[] = [
      PERMISSIONS.CRM_VIEW,
      PERMISSIONS.CRM_CREATE,
      PERMISSIONS.CRM_EDIT,
      PERMISSIONS.CRM_DELETE,
      PERMISSIONS.CRM_EXPORT,
      PERMISSIONS.ASSIGNMENT_RULES_MANAGE,
      PERMISSIONS.INTEGRATIONS_MANAGE,
      PERMISSIONS.AUDIT_LOG_VIEW,
    ];

    for (const permission of required) {
      expect(ASSIGNABLE_PERMISSIONS).toContain(permission);
    }
  });

  it('has a separate permission for seeing opportunity value (F1.4)', () => {
    expect(ASSIGNABLE_PERMISSIONS).toContain(PERMISSIONS.OPPORTUNITY_VALUE_VIEW);
  });

  it('keeps workspace administration out of assignable sets', () => {
    expect(ASSIGNABLE_PERMISSIONS).not.toContain(PERMISSIONS.MEMBERS_MANAGE);
    expect(ASSIGNABLE_PERMISSIONS).not.toContain(PERMISSIONS.PERMISSIONS_MANAGE);
    expect(ASSIGNABLE_PERMISSIONS).not.toContain(PERMISSIONS.WORKSPACE_MANAGE);
  });

  it('has no duplicates', () => {
    expect(new Set(ALL_PERMISSIONS).size).toBe(ALL_PERMISSIONS.length);
  });

  it('recognises its own values and nothing else', () => {
    for (const permission of ALL_PERMISSIONS) expect(isPermission(permission)).toBe(true);
    expect(isPermission('crm.record.destroy')).toBe(false);
    expect(isPermission('CRM_VIEW')).toBe(false);
    expect(isPermission(undefined)).toBe(false);
  });
});

describe('BASE_LEVELS', () => {
  it('is exactly the three fixed levels (F1.2)', () => {
    expect(BASE_LEVELS).toEqual(['owner', 'admin', 'user']);
  });

  it('rejects a role name used as a level, since manager is configuration', () => {
    expect(isBaseLevel('manager')).toBe(false);
    expect(isBaseLevel('Owner')).toBe(false);
  });
});

describe('baseLevelPermissions', () => {
  it('gives an Owner everything', () => {
    expect([...baseLevelPermissions('owner')].sort()).toEqual([...ALL_PERMISSIONS].sort());
  });

  it('gives an Admin member and workspace management but not the matrix', () => {
    const admin = baseLevelPermissions('admin');

    expect(admin).toContain(PERMISSIONS.MEMBERS_MANAGE);
    expect(admin).toContain(PERMISSIONS.WORKSPACE_MANAGE);
    expect(admin).not.toContain(PERMISSIONS.PERMISSIONS_MANAGE);
  });

  it('gives a User nothing by level alone', () => {
    expect(baseLevelPermissions('user')).toEqual([]);
  });
});

describe('effectivePermissions', () => {
  it('gives an Owner every permission, whatever their sets', () => {
    const effective = effectivePermissions({ baseLevel: 'owner', permissionSets: [] });

    expect(effective.size).toBe(ALL_PERMISSIONS.length);
  });

  it('cannot reduce an Owner, so they can never lock themselves out', () => {
    const effective = effectivePermissions({
      baseLevel: 'owner',
      permissionSets: [{ permissions: [] }],
      extraPermissions: [],
    });

    expect(hasPermission(effective, PERMISSIONS.PERMISSIONS_MANAGE)).toBe(true);
  });

  it('unions the permission sets a member belongs to', () => {
    const effective = effectivePermissions({
      baseLevel: 'user',
      permissionSets: [
        { permissions: [PERMISSIONS.CRM_VIEW] },
        { permissions: [PERMISSIONS.CRM_EDIT] },
      ],
    });

    expect(hasAllPermissions(effective, [PERMISSIONS.CRM_VIEW, PERMISSIONS.CRM_EDIT])).toBe(true);
    expect(hasPermission(effective, PERMISSIONS.CRM_DELETE)).toBe(false);
  });

  it('adds direct grants on top of the sets', () => {
    const effective = effectivePermissions({
      baseLevel: 'user',
      permissionSets: [{ permissions: [PERMISSIONS.CRM_VIEW] }],
      extraPermissions: [PERMISSIONS.CRM_EXPORT],
    });

    expect(hasPermission(effective, PERMISSIONS.CRM_EXPORT)).toBe(true);
  });

  it('drops a stored permission the codebase no longer knows', () => {
    const effective = effectivePermissions({
      baseLevel: 'user',
      permissionSets: [{ permissions: ['crm.record.teleport', PERMISSIONS.CRM_VIEW] }],
    });

    expect(effective.size).toBe(1);
    expect(hasPermission(effective, PERMISSIONS.CRM_VIEW)).toBe(true);
  });

  it('leaves a User with nothing when they have no sets', () => {
    expect(effectivePermissions({ baseLevel: 'user', permissionSets: [] }).size).toBe(0);
  });

  it('does not let a permission set hand out member management', () => {
    const effective = effectivePermissions({
      baseLevel: 'user',
      // A workspace could store this; it must still not take effect, because
      // ASSIGNABLE_PERMISSIONS excludes it and the level is what carries it.
      permissionSets: [{ permissions: [PERMISSIONS.CRM_VIEW] }],
    });

    expect(hasPermission(effective, PERMISSIONS.MEMBERS_MANAGE)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// canManageMembership
// ---------------------------------------------------------------------------

function actor(baseLevel: BaseLevel, membershipId = 'actor-1') {
  return {
    membershipId,
    baseLevel,
    permissions: effectivePermissions({ baseLevel, permissionSets: [] }),
  };
}

describe('canManageMembership', () => {
  it('lets an Owner invite', () => {
    expect(
      canManageMembership({
        actor: actor('owner'),
        action: 'invite',
        nextBaseLevel: 'user',
        ownerCount: 1,
      }),
    ).toEqual({ allowed: true });
  });

  it('lets an Admin invite a User', () => {
    expect(
      canManageMembership({
        actor: actor('admin'),
        action: 'invite',
        nextBaseLevel: 'user',
        ownerCount: 1,
      }).allowed,
    ).toBe(true);
  });

  it('refuses a plain User, who has no member management', () => {
    const decision = canManageMembership({
      actor: actor('user'),
      action: 'invite',
      nextBaseLevel: 'user',
      ownerCount: 1,
    });

    expect(decision).toEqual({
      allowed: false,
      reason: MEMBERSHIP_DENIAL_REASONS.NOT_PERMITTED,
    });
  });

  describe('an Admin cannot modify the Owner (F1.2)', () => {
    const owner = { membershipId: 'owner-1', baseLevel: 'owner' as BaseLevel };

    it('cannot demote the Owner', () => {
      const decision = canManageMembership({
        actor: actor('admin'),
        target: owner,
        action: 'change_base_level',
        nextBaseLevel: 'user',
        ownerCount: 2,
      });

      expect(decision).toEqual({
        allowed: false,
        reason: MEMBERSHIP_DENIAL_REASONS.ADMIN_CANNOT_TOUCH_OWNER,
      });
    });

    it('cannot change the Owner permissions', () => {
      const decision = canManageMembership({
        actor: actor('admin'),
        target: owner,
        action: 'change_permissions',
        ownerCount: 2,
      });

      expect(decision.allowed).toBe(false);
    });

    it('cannot remove the Owner', () => {
      const decision = canManageMembership({
        actor: actor('admin'),
        target: owner,
        action: 'remove',
        ownerCount: 2,
      });

      expect(decision).toEqual({
        allowed: false,
        reason: MEMBERSHIP_DENIAL_REASONS.ADMIN_CANNOT_TOUCH_OWNER,
      });
    });

    it('cannot promote anyone to Owner', () => {
      const decision = canManageMembership({
        actor: actor('admin'),
        target: { membershipId: 'user-1', baseLevel: 'user' },
        action: 'change_base_level',
        nextBaseLevel: 'owner',
        ownerCount: 1,
      });

      expect(decision).toEqual({
        allowed: false,
        reason: MEMBERSHIP_DENIAL_REASONS.ONLY_OWNER_GRANTS_OWNER,
      });
    });

    it('can still manage a User or another Admin', () => {
      expect(
        canManageMembership({
          actor: actor('admin'),
          target: { membershipId: 'user-1', baseLevel: 'user' },
          action: 'change_base_level',
          nextBaseLevel: 'admin',
          ownerCount: 1,
        }).allowed,
      ).toBe(true);

      expect(
        canManageMembership({
          actor: actor('admin'),
          target: { membershipId: 'admin-2', baseLevel: 'admin' },
          action: 'remove',
          ownerCount: 1,
        }).allowed,
      ).toBe(true);
    });
  });

  describe('the permission matrix is the Owner alone', () => {
    it('refuses an Admin editing permissions even of a User', () => {
      const decision = canManageMembership({
        actor: actor('admin'),
        target: { membershipId: 'user-1', baseLevel: 'user' },
        action: 'change_permissions',
        ownerCount: 1,
      });

      expect(decision).toEqual({
        allowed: false,
        reason: MEMBERSHIP_DENIAL_REASONS.ONLY_OWNER_EDITS_PERMISSIONS,
      });
    });

    it('allows the Owner', () => {
      expect(
        canManageMembership({
          actor: actor('owner'),
          target: { membershipId: 'user-1', baseLevel: 'user' },
          action: 'change_permissions',
          ownerCount: 1,
        }).allowed,
      ).toBe(true);
    });
  });

  describe('the last Owner is protected', () => {
    it('refuses demoting the only Owner, even by themselves', () => {
      const decision = canManageMembership({
        actor: actor('owner', 'owner-1'),
        target: { membershipId: 'owner-1', baseLevel: 'owner' },
        action: 'change_base_level',
        nextBaseLevel: 'admin',
        ownerCount: 1,
      });

      expect(decision).toEqual({
        allowed: false,
        reason: MEMBERSHIP_DENIAL_REASONS.WOULD_REMOVE_LAST_OWNER,
      });
    });

    it('refuses removing the only Owner', () => {
      const decision = canManageMembership({
        actor: actor('owner', 'owner-1'),
        target: { membershipId: 'owner-1', baseLevel: 'owner' },
        action: 'remove',
        ownerCount: 1,
      });

      expect(decision.allowed).toBe(false);
    });

    it('allows demoting an Owner when another remains', () => {
      expect(
        canManageMembership({
          actor: actor('owner'),
          target: { membershipId: 'owner-2', baseLevel: 'owner' },
          action: 'change_base_level',
          nextBaseLevel: 'admin',
          ownerCount: 2,
        }).allowed,
      ).toBe(true);
    });

    it('allows an Owner to keep being an Owner', () => {
      expect(
        canManageMembership({
          actor: actor('owner', 'owner-1'),
          target: { membershipId: 'owner-1', baseLevel: 'owner' },
          action: 'change_base_level',
          nextBaseLevel: 'owner',
          ownerCount: 1,
        }).allowed,
      ).toBe(true);
    });
  });
});

describe('DEFAULT_PERMISSION_SETS', () => {
  it('seeds a set for each of Admin and User', () => {
    expect(
      DEFAULT_PERMISSION_SETS.find((set) => set.defaultForBaseLevel === 'admin'),
    ).toBeDefined();
    expect(DEFAULT_PERMISSION_SETS.find((set) => set.defaultForBaseLevel === 'user')).toBeDefined();
  });

  it('includes Manager as a configurable set, not a base level (Section 2)', () => {
    const manager = DEFAULT_PERMISSION_SETS.find((set) => set.name === 'Manager');

    expect(manager).toBeDefined();
    expect(manager?.defaultForBaseLevel).toBeNull();
    expect(isBaseLevel('manager')).toBe(false);
  });

  it('does not give the Member set opportunity value or the audit log', () => {
    const member = DEFAULT_PERMISSION_SETS.find((set) => set.name === 'Member');

    expect(member?.permissions).not.toContain(PERMISSIONS.OPPORTUNITY_VALUE_VIEW);
    expect(member?.permissions).not.toContain(PERMISSIONS.AUDIT_LOG_VIEW);
  });

  it('only ever contains assignable permissions', () => {
    for (const set of DEFAULT_PERMISSION_SETS) {
      for (const permission of set.permissions) {
        expect(ASSIGNABLE_PERMISSIONS).toContain(permission);
      }
    }
  });
});
