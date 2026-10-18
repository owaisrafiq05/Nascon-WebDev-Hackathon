import { PERMISSIONS } from '@ubmp/domain';
import type { Express } from 'express';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { MembershipModel } from '../../db/models/membership.js';
import { PermissionSetModel } from '../../db/models/permission-set.js';
import { UserModel } from '../../db/models/user.js';
import {
  createTestApp,
  resetDatabase,
  signIn,
  signUpOwner,
  startTestDatabase,
  stopTestDatabase,
  TEST_PASSWORD,
  type TestClient,
} from '../../test/harness.js';

let app: Express;

beforeAll(async () => {
  await startTestDatabase();
  app = createTestApp();
}, 180_000);

afterAll(async () => {
  await stopTestDatabase();
});

afterEach(async () => {
  await resetDatabase();
});

/**
 * Invites someone, accepts the invitation and signs them in, so a test can act
 * as a second member at any level.
 */
async function addMember(
  owner: TestClient,
  email: string,
  baseLevel: 'admin' | 'user',
): Promise<TestClient> {
  const invite = await owner.post('/api/members/invites', { email, baseLevel }).expect(201);

  await request(app)
    .post('/api/members/invites/accept')
    .send({ token: invite.body.token, name: email, password: TEST_PASSWORD })
    .expect(204);

  return signIn(app, email);
}

// ---------------------------------------------------------------------------
// Invitations (F1.2)
// ---------------------------------------------------------------------------

describe('POST /api/members/invites', () => {
  it('lets an Owner invite someone', async () => {
    const owner = await signUpOwner(app);

    const response = await owner
      .post('/api/members/invites', { email: 'new@example.com', baseLevel: 'user' })
      .expect(201);

    expect(response.body.email).toBe('new@example.com');
    expect(response.body.token).toBeTruthy();
  });

  it('lets an Admin invite a User', async () => {
    const owner = await signUpOwner(app);
    const admin = await addMember(owner, 'admin@example.com', 'admin');

    await admin
      .post('/api/members/invites', { email: 'another@example.com', baseLevel: 'user' })
      .expect(201);
  });

  it('refuses a plain User, who has no member management (F1.5)', async () => {
    const owner = await signUpOwner(app);
    const member = await addMember(owner, 'member@example.com', 'user');

    const response = await member
      .post('/api/members/invites', { email: 'nope@example.com', baseLevel: 'user' })
      .expect(403);

    expect(response.body.error.code).toBe('FORBIDDEN');
  });

  it('refuses an anonymous caller', async () => {
    await request(app)
      .post('/api/members/invites')
      .send({ email: 'nope@example.com', baseLevel: 'user' })
      .expect(401);
  });

  it('does not let an Admin invite an Owner', async () => {
    const owner = await signUpOwner(app);
    const admin = await addMember(owner, 'admin@example.com', 'admin');

    const response = await admin
      .post('/api/members/invites', { email: 'coowner@example.com', baseLevel: 'owner' })
      .expect(403);

    expect(response.body.error.details.reason).toBe('only_owner_grants_owner');
  });

  it('defaults the invitee to the workspace set for their level (F1.3)', async () => {
    const owner = await signUpOwner(app);
    const member = await addMember(owner, 'member@example.com', 'user');

    const me = await member.get('/api/auth/me').expect(200);

    // The seeded Member set grants view, create and edit, and not value.
    expect(me.body.membership.permissions).toContain(PERMISSIONS.CRM_VIEW);
    expect(me.body.membership.permissions).not.toContain(PERMISSIONS.OPPORTUNITY_VALUE_VIEW);
  });

  it('refuses inviting someone who is already a member', async () => {
    const owner = await signUpOwner(app);
    await addMember(owner, 'member@example.com', 'user');

    const response = await owner
      .post('/api/members/invites', { email: 'member@example.com', baseLevel: 'user' })
      .expect(409);

    expect(response.body.error.code).toBe('CONFLICT');
  });

  it('replaces a live invitation rather than listing the person twice', async () => {
    const owner = await signUpOwner(app);

    await owner.post('/api/members/invites', { email: 'twice@example.com', baseLevel: 'user' });
    await owner.post('/api/members/invites', { email: 'twice@example.com', baseLevel: 'admin' });

    const members = await owner.get('/api/members').expect(200);
    const pending = members.body.pendingInvites.filter(
      (invite: { email: string }) => invite.email === 'twice@example.com',
    );

    expect(pending).toHaveLength(1);
    expect(pending[0].baseLevel).toBe('admin');
  });

  it('rejects a malformed email (Q3)', async () => {
    const owner = await signUpOwner(app);

    await owner.post('/api/members/invites', { email: 'nope', baseLevel: 'user' }).expect(422);
  });

  it('refuses a permission set belonging to another workspace (F1.6)', async () => {
    const owner = await signUpOwner(app, { email: 'a@example.com' });
    const other = await signUpOwner(app, { email: 'b@example.com' });

    const otherSets = await PermissionSetModel.find({ workspaceId: other.workspaceId })
      .select('_id')
      .lean();

    const response = await owner
      .post('/api/members/invites', {
        email: 'new@example.com',
        baseLevel: 'user',
        permissionSetIds: [otherSets[0]!._id.toString()],
      })
      .expect(404);

    expect(response.body.error.code).toBe('NOT_FOUND');
  });
});

describe('POST /api/members/invites/accept', () => {
  it('creates the membership and lets the invitee sign in with their new password', async () => {
    const owner = await signUpOwner(app);
    const invite = await owner.post('/api/members/invites', {
      email: 'joiner@example.com',
      baseLevel: 'user',
    });

    await request(app)
      .post('/api/members/invites/accept')
      .send({ token: invite.body.token, name: 'Joiner', password: TEST_PASSWORD })
      .expect(204);

    const joiner = await signIn(app, 'joiner@example.com');
    const me = await joiner.get('/api/auth/me').expect(200);

    expect(me.body.membership.baseLevel).toBe('user');
  });

  it('is unauthenticated, because the invitee has no session yet', async () => {
    const owner = await signUpOwner(app);
    const invite = await owner.post('/api/members/invites', {
      email: 'joiner@example.com',
      baseLevel: 'user',
    });

    // No cookie, no CSRF token.
    await request(app)
      .post('/api/members/invites/accept')
      .send({ token: invite.body.token, password: TEST_PASSWORD })
      .expect(204);
  });

  it('creates no membership until it is accepted', async () => {
    const owner = await signUpOwner(app);
    await owner.post('/api/members/invites', { email: 'joiner@example.com', baseLevel: 'user' });

    // Only the Owner's own membership exists.
    expect(await MembershipModel.countDocuments()).toBe(1);
  });

  it('cannot be used twice (Q5)', async () => {
    const owner = await signUpOwner(app);
    const invite = await owner.post('/api/members/invites', {
      email: 'joiner@example.com',
      baseLevel: 'user',
    });

    await request(app)
      .post('/api/members/invites/accept')
      .send({ token: invite.body.token, password: TEST_PASSWORD })
      .expect(204);

    await request(app)
      .post('/api/members/invites/accept')
      .send({ token: invite.body.token, password: TEST_PASSWORD })
      .expect(404);

    expect(await MembershipModel.countDocuments()).toBe(2);
  });

  it('gives one message for an unknown token, so tokens cannot be probed', async () => {
    const response = await request(app)
      .post('/api/members/invites/accept')
      .send({ token: 'definitely-not-a-real-token', password: TEST_PASSWORD })
      .expect(404);

    expect(response.body.error.message).toBe('That invitation is no longer valid.');
  });

  it('refuses an expired invitation', async () => {
    const shortLived = createTestApp(
      (await import('../../test/harness.js')).testConfig({ inviteTtlMs: 1 }),
    );
    const owner = await signUpOwner(shortLived);
    const invite = await owner.post('/api/members/invites', {
      email: 'late@example.com',
      baseLevel: 'user',
    });

    await new Promise((resolve) => setTimeout(resolve, 20));

    await request(shortLived)
      .post('/api/members/invites/accept')
      .send({ token: invite.body.token, password: TEST_PASSWORD })
      .expect(404);
  });

  it('requires a password for someone with no account yet', async () => {
    const owner = await signUpOwner(app);
    const invite = await owner.post('/api/members/invites', {
      email: 'joiner@example.com',
      baseLevel: 'user',
    });

    const response = await request(app)
      .post('/api/members/invites/accept')
      .send({ token: invite.body.token })
      .expect(400);

    expect(response.body.error.details.fields.password).toBe('is required');
  });

  it('does not reset the password of someone who already has an account', async () => {
    // The person owns another workspace already.
    const existing = await signUpOwner(app, { email: 'shared@example.com' });
    const owner = await signUpOwner(app, { email: 'owner2@example.com' });

    const invite = await owner.post('/api/members/invites', {
      email: 'shared@example.com',
      baseLevel: 'user',
    });

    await request(app)
      .post('/api/members/invites/accept')
      .send({ token: invite.body.token, password: 'a-completely-different-password' })
      .expect(204);

    // Their original password still works, so an invitation is not a reset.
    await signIn(app, 'shared@example.com', TEST_PASSWORD);
    expect(existing.email).toBe('shared@example.com');
  });
});

// ---------------------------------------------------------------------------
// An Admin cannot modify the Owner (F1.2)
// ---------------------------------------------------------------------------

describe('an Admin cannot modify the Owner', () => {
  it('cannot demote the Owner', async () => {
    const owner = await signUpOwner(app, { email: 'owner@example.com' });
    const admin = await addMember(owner, 'admin@example.com', 'admin');

    const response = await admin
      .patch(`/api/members/${owner.membershipId}/level`, { baseLevel: 'user' })
      .expect(403);

    expect(response.body.error.details.reason).toBe('admin_cannot_touch_owner');

    // Unchanged in the database, not merely refused in the response.
    const membership = await MembershipModel.findById(owner.membershipId).lean();
    expect(membership?.baseLevel).toBe('owner');
  });

  it('cannot change the Owner permissions', async () => {
    const owner = await signUpOwner(app, { email: 'owner@example.com' });
    const admin = await addMember(owner, 'admin@example.com', 'admin');

    await admin
      .patch(`/api/members/${owner.membershipId}/permissions`, { extraPermissions: [] })
      .expect(403);
  });

  it('cannot remove the Owner', async () => {
    const owner = await signUpOwner(app, { email: 'owner@example.com' });
    const admin = await addMember(owner, 'admin@example.com', 'admin');

    await admin.delete(`/api/members/${owner.membershipId}`).expect(403);

    expect(await MembershipModel.findById(owner.membershipId).lean()).not.toBeNull();
  });

  it('cannot promote anyone to Owner', async () => {
    const owner = await signUpOwner(app, { email: 'owner@example.com' });
    const admin = await addMember(owner, 'admin@example.com', 'admin');
    const member = await addMember(owner, 'member@example.com', 'user');

    const response = await admin
      .patch(`/api/members/${member.membershipId}/level`, { baseLevel: 'owner' })
      .expect(403);

    expect(response.body.error.details.reason).toBe('only_owner_grants_owner');
  });

  it('can still manage a User', async () => {
    const owner = await signUpOwner(app, { email: 'owner@example.com' });
    const admin = await addMember(owner, 'admin@example.com', 'admin');
    const member = await addMember(owner, 'member@example.com', 'user');

    await admin
      .patch(`/api/members/${member.membershipId}/level`, { baseLevel: 'admin' })
      .expect(204);

    const membership = await MembershipModel.findById(member.membershipId).lean();
    expect(membership?.baseLevel).toBe('admin');
  });

  it('cannot edit the permission matrix at all, even for a User (F1.3)', async () => {
    const owner = await signUpOwner(app, { email: 'owner@example.com' });
    const admin = await addMember(owner, 'admin@example.com', 'admin');
    const member = await addMember(owner, 'member@example.com', 'user');

    const response = await admin
      .patch(`/api/members/${member.membershipId}/permissions`, {
        extraPermissions: [PERMISSIONS.CRM_DELETE],
      })
      .expect(403);

    expect(response.body.error.details.reason).toBe('only_owner_edits_permissions');
  });
});

describe('the last Owner is protected', () => {
  it('refuses to demote the only Owner, even by themselves', async () => {
    const owner = await signUpOwner(app);

    const response = await owner
      .patch(`/api/members/${owner.membershipId}/level`, { baseLevel: 'admin' })
      .expect(403);

    expect(response.body.error.details.reason).toBe('would_remove_last_owner');
  });

  it('allows it once a second Owner exists', async () => {
    const owner = await signUpOwner(app, { email: 'owner@example.com' });
    const second = await addMember(owner, 'second@example.com', 'admin');

    await owner
      .patch(`/api/members/${second.membershipId}/level`, { baseLevel: 'owner' })
      .expect(204);

    await owner
      .patch(`/api/members/${owner.membershipId}/level`, { baseLevel: 'admin' })
      .expect(204);
  });
});

// ---------------------------------------------------------------------------
// Workspace isolation (F1.6, Q2)
// ---------------------------------------------------------------------------

describe('workspace isolation', () => {
  it('returns 404, not data, for a membership id from another workspace', async () => {
    const first = await signUpOwner(app, { email: 'a@example.com' });
    const second = await signUpOwner(app, { email: 'b@example.com' });

    const response = await first
      .patch(`/api/members/${second.membershipId}/level`, { baseLevel: 'user' })
      .expect(404);

    // Not 403: a 403 would confirm the id exists somewhere.
    expect(response.body.error.code).toBe('NOT_FOUND');
  });

  it('returns 404 for deleting another workspace membership', async () => {
    const first = await signUpOwner(app, { email: 'a@example.com' });
    const second = await signUpOwner(app, { email: 'b@example.com' });

    await first.delete(`/api/members/${second.membershipId}`).expect(404);

    expect(await MembershipModel.findById(second.membershipId).lean()).not.toBeNull();
  });

  it('returns 404 for changing permissions of another workspace membership', async () => {
    const first = await signUpOwner(app, { email: 'a@example.com' });
    const second = await signUpOwner(app, { email: 'b@example.com' });

    await first
      .patch(`/api/members/${second.membershipId}/permissions`, { extraPermissions: [] })
      .expect(404);
  });

  it('lists only its own workspace members', async () => {
    const first = await signUpOwner(app, { email: 'a@example.com' });
    const second = await signUpOwner(app, { email: 'b@example.com' });
    await addMember(second, 'b-member@example.com', 'user');

    const response = await first.get('/api/members').expect(200);

    expect(response.body.members).toHaveLength(1);
    expect(response.body.members[0].email).toBe('a@example.com');
  });

  it('answers 404 the same way for a well-formed id that exists nowhere', async () => {
    const owner = await signUpOwner(app);

    await owner
      .patch('/api/members/0123456789abcdef01234567/level', { baseLevel: 'user' })
      .expect(404);
  });

  it('answers 404, not 422, for a malformed id, so the two cannot be told apart', async () => {
    const owner = await signUpOwner(app);

    await owner.patch('/api/members/not-an-id/level', { baseLevel: 'user' }).expect(404);
  });
});

// ---------------------------------------------------------------------------
// The matrix editor (F1.3)
// ---------------------------------------------------------------------------

describe('the permission matrix editor', () => {
  it('lets an Owner grant a permission directly', async () => {
    const owner = await signUpOwner(app, { email: 'owner@example.com' });
    const member = await addMember(owner, 'member@example.com', 'user');

    await owner
      .patch(`/api/members/${member.membershipId}/permissions`, {
        extraPermissions: [PERMISSIONS.OPPORTUNITY_VALUE_VIEW],
      })
      .expect(204);

    const me = await signIn(app, 'member@example.com');
    const response = await me.get('/api/auth/me').expect(200);

    expect(response.body.membership.permissions).toContain(PERMISSIONS.OPPORTUNITY_VALUE_VIEW);
  });

  it('lets an Owner remove a permission by emptying the sets', async () => {
    const owner = await signUpOwner(app, { email: 'owner@example.com' });
    const member = await addMember(owner, 'member@example.com', 'user');

    await owner
      .patch(`/api/members/${member.membershipId}/permissions`, {
        permissionSetIds: [],
        extraPermissions: [],
      })
      .expect(204);

    const me = await signIn(app, 'member@example.com');
    const response = await me.get('/api/auth/me').expect(200);

    expect(response.body.membership.permissions).toEqual([]);
  });

  it('refuses a permission the codebase does not know', async () => {
    const owner = await signUpOwner(app, { email: 'owner@example.com' });
    const member = await addMember(owner, 'member@example.com', 'user');

    const response = await owner
      .patch(`/api/members/${member.membershipId}/permissions`, {
        extraPermissions: ['crm.record.teleport'],
      })
      .expect(400);

    expect(response.body.error.message).toContain('Unknown permission');
  });

  it('serves the assignable catalogue, so the editor cannot offer the impossible', async () => {
    const owner = await signUpOwner(app);

    const response = await owner.get('/api/permission-sets').expect(200);

    expect(response.body.assignablePermissions).toContain(PERMISSIONS.CRM_VIEW);
    expect(response.body.assignablePermissions).not.toContain(PERMISSIONS.MEMBERS_MANAGE);
  });

  it('refuses a set that would grant member management', async () => {
    const owner = await signUpOwner(app);

    const response = await owner
      .post('/api/permission-sets', {
        name: 'Sneaky',
        permissions: [PERMISSIONS.MEMBERS_MANAGE],
      })
      .expect(400);

    expect(response.body.error.message).toContain('cannot be granted through a permission set');
  });

  it('refuses an Admin creating a permission set', async () => {
    const owner = await signUpOwner(app, { email: 'owner@example.com' });
    const admin = await addMember(owner, 'admin@example.com', 'admin');

    await admin
      .post('/api/permission-sets', { name: 'Admin made', permissions: [PERMISSIONS.CRM_VIEW] })
      .expect(403);
  });

  it('detaches a deleted set from every membership, leaving no dangling ids (Q4)', async () => {
    const owner = await signUpOwner(app, { email: 'owner@example.com' });
    const member = await addMember(owner, 'member@example.com', 'user');

    const before = await MembershipModel.findById(member.membershipId).lean();
    const setId = before!.permissionSetIds[0]!.toString();

    await owner.delete(`/api/permission-sets/${setId}`).expect(204);

    const after = await MembershipModel.findById(member.membershipId).lean();
    expect(after?.permissionSetIds.map((id) => id.toString())).not.toContain(setId);
  });
});

// ---------------------------------------------------------------------------
// Removing a member
// ---------------------------------------------------------------------------

describe('DELETE /api/members/:membershipId', () => {
  it('removes the membership and ends their sessions', async () => {
    const owner = await signUpOwner(app, { email: 'owner@example.com' });
    const member = await addMember(owner, 'member@example.com', 'user');

    await member.get('/api/auth/me').expect(200);

    await owner.delete(`/api/members/${member.membershipId}`).expect(204);

    // Access must not outlive the membership.
    await member.get('/api/auth/me').expect(401);
    expect(await MembershipModel.findById(member.membershipId).lean()).toBeNull();
  });

  it('leaves the user account intact, since they may belong elsewhere', async () => {
    const owner = await signUpOwner(app, { email: 'owner@example.com' });
    const member = await addMember(owner, 'member@example.com', 'user');

    await owner.delete(`/api/members/${member.membershipId}`).expect(204);

    expect(await UserModel.findOne({ email: 'member@example.com' }).lean()).not.toBeNull();
  });
});
