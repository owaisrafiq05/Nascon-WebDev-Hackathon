import { AUDIT_EVENT_TYPES, PERMISSIONS } from '@ubmp/domain';
import type { Express } from 'express';
import mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { AuditEventModel } from '../../db/models/audit-event.js';
import * as auditRepository from '../../repositories/audit-repository.js';
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
// What gets recorded (F4.1)
// ---------------------------------------------------------------------------

describe('audit recording (F4.1)', () => {
  it('records an invitation with actor, target and the values set', async () => {
    const owner = await signUpOwner(app, { email: 'owner@example.com' });

    await owner.post('/api/members/invites', { email: 'new@example.com', baseLevel: 'user' });

    const response = await owner.get('/api/auth/me');
    expect(response.status).toBe(200);

    const events = await owner.get('/api/audit-events').expect(200);
    const invited = events.body.items.find(
      (event: { type: string }) => event.type === AUDIT_EVENT_TYPES.USER_INVITED,
    );

    expect(invited).toBeDefined();
    expect(invited.actor.label).toBe('owner@example.com');
    expect(invited.target.label).toBe('new@example.com');
    expect(invited.after.baseLevel).toBe('user');
    expect(invited.at).toBeTruthy();
  });

  it('records a level change with before and after', async () => {
    const owner = await signUpOwner(app, { email: 'owner@example.com' });
    const member = await addMember(owner, 'member@example.com', 'user');

    await owner
      .patch(`/api/members/${member.membershipId}/level`, { baseLevel: 'admin' })
      .expect(204);

    const events = await owner.get('/api/audit-events').expect(200);
    const change = events.body.items.find(
      (event: { type: string; before?: { baseLevel?: string } }) =>
        event.type === AUDIT_EVENT_TYPES.USER_ROLE_CHANGED && event.before?.baseLevel === 'user',
    );

    expect(change.before.baseLevel).toBe('user');
    expect(change.after.baseLevel).toBe('admin');
    expect(change.actor.label).toBe('owner@example.com');
  });

  it('records a permission change with before and after', async () => {
    const owner = await signUpOwner(app, { email: 'owner@example.com' });
    const member = await addMember(owner, 'member@example.com', 'user');

    await owner
      .patch(`/api/members/${member.membershipId}/permissions`, {
        extraPermissions: [PERMISSIONS.CRM_DELETE],
      })
      .expect(204);

    const events = await owner.get('/api/audit-events').expect(200);
    const change = events.body.items.find(
      (event: { type: string }) => event.type === AUDIT_EVENT_TYPES.USER_PERMISSIONS_CHANGED,
    );

    expect(change.before.extraPermissions).toEqual([]);
    expect(change.after.extraPermissions).toEqual([PERMISSIONS.CRM_DELETE]);
  });

  it('records a deletion', async () => {
    const owner = await signUpOwner(app, { email: 'owner@example.com' });
    const member = await addMember(owner, 'member@example.com', 'user');

    await owner.delete(`/api/members/${member.membershipId}`).expect(204);

    const events = await owner.get('/api/audit-events').expect(200);
    const deleted = events.body.items.find(
      (event: { type: string }) => event.type === AUDIT_EVENT_TYPES.USER_DELETED,
    );

    expect(deleted.target.label).toBe('member@example.com');
    expect(deleted.before.baseLevel).toBe('user');
  });

  it('records permission set creation and deletion', async () => {
    const owner = await signUpOwner(app);

    const created = await owner
      .post('/api/permission-sets', { name: 'Auditors', permissions: [PERMISSIONS.CRM_VIEW] })
      .expect(201);
    await owner.delete(`/api/permission-sets/${created.body.id}`).expect(204);

    const events = await owner.get('/api/audit-events').expect(200);
    const types = events.body.items.map((event: { type: string }) => event.type);

    expect(types).toContain(AUDIT_EVENT_TYPES.ROLE_CREATED);
    expect(types).toContain(AUDIT_EVENT_TYPES.ROLE_DELETED);
  });

  it('writes nothing when the change it describes was refused', async () => {
    const owner = await signUpOwner(app, { email: 'owner@example.com' });
    const admin = await addMember(owner, 'admin@example.com', 'admin');

    const before = await AuditEventModel.countDocuments();
    await admin
      .patch(`/api/members/${owner.membershipId}/level`, { baseLevel: 'user' })
      .expect(403);

    expect(await AuditEventModel.countDocuments()).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Restricted visibility (F4.2)
// ---------------------------------------------------------------------------

describe('GET /api/audit-events permission (F4.2)', () => {
  it('lets a member with audit_log.view read it', async () => {
    const owner = await signUpOwner(app);

    await owner.get('/api/audit-events').expect(200);
  });

  it('refuses a member without the permission', async () => {
    const owner = await signUpOwner(app, { email: 'owner@example.com' });
    const member = await addMember(owner, 'member@example.com', 'user');

    const response = await member.get('/api/audit-events').expect(403);

    expect(response.body.error.details.requiredPermissions).toContain(PERMISSIONS.AUDIT_LOG_VIEW);
  });

  it('refuses an Admin who was not granted it, since the level does not carry it', async () => {
    const owner = await signUpOwner(app, { email: 'owner@example.com' });
    const admin = await addMember(owner, 'admin@example.com', 'admin');

    await owner
      .patch(`/api/members/${admin.membershipId}/permissions`, {
        permissionSetIds: [],
        extraPermissions: [],
      })
      .expect(204);

    const stripped = await signIn(app, 'admin@example.com');
    await stripped.get('/api/audit-events').expect(403);
  });

  it('allows it once the Owner grants it', async () => {
    const owner = await signUpOwner(app, { email: 'owner@example.com' });
    const member = await addMember(owner, 'member@example.com', 'user');

    await owner
      .patch(`/api/members/${member.membershipId}/permissions`, {
        extraPermissions: [PERMISSIONS.AUDIT_LOG_VIEW],
      })
      .expect(204);

    const granted = await signIn(app, 'member@example.com');
    await granted.get('/api/audit-events').expect(200);
  });

  it('refuses an anonymous caller', async () => {
    await request(app).get('/api/audit-events').expect(401);
  });
});

// ---------------------------------------------------------------------------
// Filters and pagination (F4.2, Q9)
// ---------------------------------------------------------------------------

describe('audit filters (F4.2)', () => {
  it('filters by event type', async () => {
    const owner = await signUpOwner(app, { email: 'owner@example.com' });
    await owner.post('/api/members/invites', { email: 'x@example.com', baseLevel: 'user' });

    const response = await owner
      .get(`/api/audit-events?types=${AUDIT_EVENT_TYPES.USER_INVITED}`)
      .expect(200);

    expect(response.body.items.length).toBeGreaterThan(0);
    expect(
      response.body.items.every(
        (event: { type: string }) => event.type === AUDIT_EVENT_TYPES.USER_INVITED,
      ),
    ).toBe(true);
  });

  it('accepts several types at once', async () => {
    const owner = await signUpOwner(app, { email: 'owner@example.com' });
    await owner.post('/api/members/invites', { email: 'x@example.com', baseLevel: 'user' });

    const response = await owner
      .get(
        `/api/audit-events?types=${AUDIT_EVENT_TYPES.USER_INVITED},${AUDIT_EVENT_TYPES.ROLE_CREATED}`,
      )
      .expect(200);

    expect(response.body.items.length).toBeGreaterThan(0);
  });

  it('ignores an unknown type rather than failing the request', async () => {
    const owner = await signUpOwner(app);

    await owner.get('/api/audit-events?types=lead.exploded').expect(200);
  });

  it('filters by the user who acted', async () => {
    const owner = await signUpOwner(app, { email: 'owner@example.com' });
    const admin = await addMember(owner, 'admin@example.com', 'admin');
    await admin.post('/api/members/invites', { email: 'byadmin@example.com', baseLevel: 'user' });

    const response = await owner.get(`/api/audit-events?actorUserId=${admin.userId}`).expect(200);

    expect(response.body.items.length).toBeGreaterThan(0);
    expect(
      response.body.items.every(
        (event: { actor: { userId: string } }) => event.actor.userId === admin.userId,
      ),
    ).toBe(true);
  });

  it('filters by date range', async () => {
    const owner = await signUpOwner(app, { email: 'owner@example.com' });
    await owner.post('/api/members/invites', { email: 'x@example.com', baseLevel: 'user' });

    const future = new Date(Date.now() + 60 * 60 * 1_000).toISOString();
    const empty = await owner.get(`/api/audit-events?from=${future}`).expect(200);
    expect(empty.body.items).toHaveLength(0);

    const past = new Date(Date.now() - 60 * 60 * 1_000).toISOString();
    const found = await owner.get(`/api/audit-events?from=${past}`).expect(200);
    expect(found.body.items.length).toBeGreaterThan(0);
  });

  it('rejects a malformed date (Q3)', async () => {
    const owner = await signUpOwner(app);

    await owner.get('/api/audit-events?from=yesterday').expect(422);
  });

  it('returns the newest entry first', async () => {
    const owner = await signUpOwner(app, { email: 'owner@example.com' });
    const member = await addMember(owner, 'member@example.com', 'user');
    await owner
      .patch(`/api/members/${member.membershipId}/level`, { baseLevel: 'admin' })
      .expect(204);

    const response = await owner.get('/api/audit-events').expect(200);
    const times = response.body.items.map((event: { at: string }) => Date.parse(event.at));

    expect(times).toEqual([...times].sort((left: number, right: number) => right - left));
  });

  it('paginates (Q9)', async () => {
    const owner = await signUpOwner(app, { email: 'owner@example.com' });
    for (let index = 0; index < 4; index += 1) {
      await owner.post('/api/members/invites', {
        email: `x${String(index)}@example.com`,
        baseLevel: 'user',
      });
    }

    const page = await owner.get('/api/audit-events?page=1&limit=2').expect(200);

    expect(page.body.items).toHaveLength(2);
    expect(page.body.pageInfo.limit).toBe(2);
    expect(page.body.pageInfo.total).toBeGreaterThan(2);
    expect(page.body.pageInfo.hasNextPage).toBe(true);
  });

  it('serves the type catalogue for the viewer filter', async () => {
    const owner = await signUpOwner(app);

    const response = await owner.get('/api/audit-events/types').expect(200);

    expect(response.body.types).toContain(AUDIT_EVENT_TYPES.USER_ROLE_CHANGED);
  });
});

describe('audit workspace isolation (F1.6)', () => {
  it('never shows another workspace entries', async () => {
    const first = await signUpOwner(app, { email: 'a@example.com' });
    const second = await signUpOwner(app, { email: 'b@example.com' });

    await second.post('/api/members/invites', {
      email: 'secret@example.com',
      baseLevel: 'user',
    });

    const response = await first.get('/api/audit-events').expect(200);

    expect(JSON.stringify(response.body)).not.toContain('secret@example.com');
  });

  it('ignores a workspaceId supplied in the query string', async () => {
    const first = await signUpOwner(app, { email: 'a@example.com' });
    const second = await signUpOwner(app, { email: 'b@example.com' });

    await second.post('/api/members/invites', {
      email: 'secret@example.com',
      baseLevel: 'user',
    });

    const response = await first
      .get(`/api/audit-events?workspaceId=${second.workspaceId}`)
      .expect(200);

    expect(JSON.stringify(response.body)).not.toContain('secret@example.com');
  });
});

// ---------------------------------------------------------------------------
// Tamper resistance (F4.3)
// ---------------------------------------------------------------------------

describe('audit entries cannot be edited or removed (F4.3)', () => {
  it('exposes no mutating method on the repository', () => {
    const exported = Object.keys(auditRepository);

    expect(exported).toEqual(['appendAuditEvent', 'queryAuditEvents']);

    for (const name of exported) {
      expect(name).not.toMatch(/update|delete|remove|destroy|patch|edit/i);
    }
  });

  it.each(['patch', 'put', 'delete', 'post'] as const)(
    'has no %s route on /api/audit-events',
    async (method) => {
      const owner = await signUpOwner(app);

      const response = await owner[method]('/api/audit-events');

      // Unroutable, so it falls through to the 404 handler.
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('NOT_FOUND');
    },
  );

  it.each(['patch', 'put', 'delete'] as const)(
    'has no %s route on a single audit event',
    async (method) => {
      const owner = await signUpOwner(app, { email: 'owner@example.com' });
      await owner.post('/api/members/invites', { email: 'x@example.com', baseLevel: 'user' });

      const events = await owner.get('/api/audit-events').expect(200);
      const id = events.body.items[0].id;

      const response = await owner[method](`/api/audit-events/${id}`);

      expect(response.status).toBe(404);
    },
  );

  it('refuses an update through the model, which is the schema guard', async () => {
    const owner = await signUpOwner(app, { email: 'owner@example.com' });
    await owner.post('/api/members/invites', { email: 'x@example.com', baseLevel: 'user' });

    await expect(
      AuditEventModel.updateOne({}, { $set: { actorLabel: 'someone else' } }),
    ).rejects.toThrow(/append-only/);
  });

  it('refuses a delete through the model', async () => {
    const owner = await signUpOwner(app, { email: 'owner@example.com' });
    await owner.post('/api/members/invites', { email: 'x@example.com', baseLevel: 'user' });

    await expect(AuditEventModel.deleteMany({})).rejects.toThrow(/append-only/);
    await expect(AuditEventModel.findOneAndUpdate({}, { $set: {} })).rejects.toThrow(/append-only/);
  });

  it('refuses saving a loaded entry back, so an entry cannot be rewritten', async () => {
    const owner = await signUpOwner(app, { email: 'owner@example.com' });
    await owner.post('/api/members/invites', { email: 'x@example.com', baseLevel: 'user' });

    const entry = await AuditEventModel.findOne({});
    expect(entry).not.toBeNull();
    entry!.actorLabel = 'tampered';

    await expect(entry!.save()).rejects.toThrow(/append-only/);
  });

  it('leaves the stored entry unchanged after every refused attempt', async () => {
    const owner = await signUpOwner(app, { email: 'owner@example.com' });
    await owner.post('/api/members/invites', { email: 'x@example.com', baseLevel: 'user' });

    const before = await AuditEventModel.findOne({}).lean();

    await AuditEventModel.updateOne({}, { $set: { actorLabel: 'nope' } }).catch(() => undefined);
    await AuditEventModel.deleteMany({}).catch(() => undefined);

    const after = await AuditEventModel.findOne({}).lean();
    expect(after?.actorLabel).toBe(before?.actorLabel);
    expect(await AuditEventModel.countDocuments()).toBeGreaterThan(0);
  });

  it('has no updatedAt, because nothing about an entry may move', async () => {
    const owner = await signUpOwner(app, { email: 'owner@example.com' });
    await owner.post('/api/members/invites', { email: 'x@example.com', baseLevel: 'user' });

    const entry = await AuditEventModel.findOne({}).lean();

    expect(entry).not.toHaveProperty('updatedAt');
    expect(entry).not.toHaveProperty('createdAt');
  });

  it('writes the entry and the change it describes together (F4.1)', async () => {
    // The invite service appends inside the same transaction as the insert, so
    // an entry without its change, or a change without its entry, cannot exist.
    const owner = await signUpOwner(app, { email: 'owner@example.com' });
    await owner.post('/api/members/invites', { email: 'x@example.com', baseLevel: 'user' });

    const invites = await mongoose.connection.db?.collection('invites').countDocuments();
    const invitedEvents = await AuditEventModel.countDocuments({
      type: AUDIT_EVENT_TYPES.USER_INVITED,
    });

    expect(invites).toBe(1);
    expect(invitedEvents).toBe(1);
  });
});
