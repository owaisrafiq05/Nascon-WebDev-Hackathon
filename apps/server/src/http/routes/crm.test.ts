import { AUDIT_EVENT_TYPES, PERMISSIONS } from '@ubmp/domain';
import type { Express } from 'express';
import { Types } from 'mongoose';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { ActivityModel } from '../../db/models/activity.js';
import { ContactModel } from '../../db/models/contact.js';
import { OpportunityModel } from '../../db/models/opportunity.js';
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
// Companies and contacts, and the relationship between them (F2.1)
// ---------------------------------------------------------------------------

describe('companies', () => {
  it('creates and lists a company', async () => {
    const owner = await signUpOwner(app);

    const created = await owner
      .post('/api/companies', { name: 'Acme Roofing', domain: 'Acme.example' })
      .expect(201);

    expect(created.body.name).toBe('Acme Roofing');
    // Stored lowercase, so one company cannot be entered twice by case.
    expect(created.body.domain).toBe('acme.example');
    expect(created.body.version).toBe(0);

    const list = await owner.get('/api/companies').expect(200);
    expect(list.body.items).toHaveLength(1);
  });

  it('searches by name prefix', async () => {
    const owner = await signUpOwner(app);
    await owner.post('/api/companies', { name: 'Acme Roofing' }).expect(201);
    await owner.post('/api/companies', { name: 'Beta Solar' }).expect(201);

    const found = await owner.get('/api/companies?search=acme').expect(200);

    expect(found.body.items).toHaveLength(1);
    expect(found.body.items[0].name).toBe('Acme Roofing');
  });

  it('does not let a search string act as a regular expression', async () => {
    const owner = await signUpOwner(app);
    await owner.post('/api/companies', { name: 'Acme Roofing' }).expect(201);

    // Unescaped, `.*` would match everything.
    const found = await owner.get('/api/companies?search=.*').expect(200);

    expect(found.body.items).toHaveLength(0);
  });
});

describe('contacts and their company (F2.1)', () => {
  it('links a contact to a company and returns both on the detail page', async () => {
    const owner = await signUpOwner(app);
    const company = await owner.post('/api/companies', { name: 'Acme Roofing' }).expect(201);

    const contact = await owner
      .post('/api/contacts', {
        firstName: 'Ada',
        lastName: 'Lovelace',
        email: 'ada@acme.example',
        companyId: company.body.id,
      })
      .expect(201);

    const detail = await owner.get(`/api/contacts/${contact.body.id}`).expect(200);

    expect(detail.body.contact.firstName).toBe('Ada');
    expect(detail.body.company.name).toBe('Acme Roofing');
  });

  it('allows a contact with no company', async () => {
    const owner = await signUpOwner(app);

    const contact = await owner.post('/api/contacts', { firstName: 'Solo' }).expect(201);
    const detail = await owner.get(`/api/contacts/${contact.body.id}`).expect(200);

    expect(detail.body.company).toBeNull();
  });

  it('refuses a company from another workspace (F1.6)', async () => {
    const first = await signUpOwner(app, { email: 'a@example.com' });
    const second = await signUpOwner(app, { email: 'b@example.com' });

    const otherCompany = await second.post('/api/companies', { name: 'Theirs' }).expect(201);

    const response = await first
      .post('/api/contacts', { firstName: 'Ada', companyId: otherCompany.body.id })
      .expect(404);

    expect(response.body.error.code).toBe('NOT_FOUND');
  });

  it('de-duplicates tags', async () => {
    const owner = await signUpOwner(app);

    const contact = await owner
      .post('/api/contacts', { firstName: 'Ada', tags: ['vip', 'vip', 'roof'] })
      .expect(201);

    expect([...contact.body.tags].sort()).toEqual(['roof', 'vip']);
  });

  it('filters by company, owner and tag (F2.6)', async () => {
    const owner = await signUpOwner(app);
    const company = await owner.post('/api/companies', { name: 'Acme' }).expect(201);

    await owner
      .post('/api/contacts', { firstName: 'Tagged', tags: ['vip'], companyId: company.body.id })
      .expect(201);
    await owner.post('/api/contacts', { firstName: 'Plain' }).expect(201);

    const byTag = await owner.get('/api/contacts?tag=vip').expect(200);
    expect(byTag.body.items).toHaveLength(1);
    expect(byTag.body.items[0].firstName).toBe('Tagged');

    const byCompany = await owner.get(`/api/contacts?companyId=${company.body.id}`).expect(200);
    expect(byCompany.body.items).toHaveLength(1);

    const byOwner = await owner
      .get(`/api/contacts?ownerMembershipId=${owner.membershipId}`)
      .expect(200);
    expect(byOwner.body.items).toHaveLength(2);
  });

  it('searches by name, email and phone', async () => {
    const owner = await signUpOwner(app);
    await owner
      .post('/api/contacts', {
        firstName: 'Grace',
        lastName: 'Hopper',
        email: 'grace@navy.example',
        phone: '+15550101',
      })
      .expect(201);
    await owner.post('/api/contacts', { firstName: 'Someone', lastName: 'Else' }).expect(201);

    for (const term of ['grace', 'hopper', 'navy.example', '5550101']) {
      const found = await owner.get(`/api/contacts?search=${term}`).expect(200);
      expect(found.body.items, `searching for ${term}`).toHaveLength(1);
    }
  });

  it('paginates (Q9)', async () => {
    const owner = await signUpOwner(app);
    for (let index = 0; index < 5; index += 1) {
      await owner.post('/api/contacts', { firstName: `Contact${String(index)}` }).expect(201);
    }

    const page = await owner.get('/api/contacts?page=2&limit=2').expect(200);

    expect(page.body.items).toHaveLength(2);
    expect(page.body.pageInfo).toMatchObject({ page: 2, limit: 2, total: 5, totalPages: 3 });
  });
});

// ---------------------------------------------------------------------------
// Optimistic concurrency (Q4)
// ---------------------------------------------------------------------------

describe('concurrent edits do not silently overwrite (Q4)', () => {
  it('accepts the first write and refuses the second with the same version', async () => {
    const owner = await signUpOwner(app);
    const contact = await owner.post('/api/contacts', { firstName: 'Ada' }).expect(201);

    // Two people both read version 0.
    await owner
      .patch(`/api/contacts/${contact.body.id}`, { firstName: 'First', version: 0 })
      .expect(200);

    const second = await owner
      .patch(`/api/contacts/${contact.body.id}`, { firstName: 'Second', version: 0 })
      .expect(409);

    expect(second.body.error.code).toBe('VERSION_CONFLICT');
    expect(second.body.error.hint).toContain('Reload');

    // The first write stands; the second did not land.
    const detail = await owner.get(`/api/contacts/${contact.body.id}`).expect(200);
    expect(detail.body.contact.firstName).toBe('First');
  });

  it('bumps the version on each accepted write', async () => {
    const owner = await signUpOwner(app);
    const contact = await owner.post('/api/contacts', { firstName: 'Ada' }).expect(201);

    const first = await owner
      .patch(`/api/contacts/${contact.body.id}`, { firstName: 'One', version: 0 })
      .expect(200);
    expect(first.body.version).toBe(1);

    const second = await owner
      .patch(`/api/contacts/${contact.body.id}`, { firstName: 'Two', version: 1 })
      .expect(200);
    expect(second.body.version).toBe(2);
  });

  it('applies the same rule to companies', async () => {
    const owner = await signUpOwner(app);
    const company = await owner.post('/api/companies', { name: 'Acme' }).expect(201);

    await owner
      .patch(`/api/companies/${company.body.id}`, { name: 'First', version: 0 })
      .expect(200);
    await owner
      .patch(`/api/companies/${company.body.id}`, { name: 'Second', version: 0 })
      .expect(409);
  });
});

// ---------------------------------------------------------------------------
// Deletion leaves nothing orphaned or contradictory (Q4)
// ---------------------------------------------------------------------------

describe('deletion keeps related records consistent (Q4)', () => {
  it('detaches contacts when their company is deleted, rather than deleting them', async () => {
    const owner = await signUpOwner(app);
    const company = await owner.post('/api/companies', { name: 'Acme' }).expect(201);
    const contact = await owner
      .post('/api/contacts', { firstName: 'Ada', companyId: company.body.id })
      .expect(201);

    const deleted = await owner.delete(`/api/companies/${company.body.id}`).expect(200);
    expect(deleted.body.detachedContacts).toBe(1);

    // The person survives, pointing at nothing rather than at a missing row.
    const detail = await owner.get(`/api/contacts/${contact.body.id}`).expect(200);
    expect(detail.body.contact.companyId).toBeNull();
    expect(detail.body.company).toBeNull();
  });

  it('refuses to delete a contact that still holds opportunities, with the count', async () => {
    const owner = await signUpOwner(app);
    const contact = await owner.post('/api/contacts', { firstName: 'Ada' }).expect(201);

    await OpportunityModel.create({
      workspaceId: new Types.ObjectId(owner.workspaceId),
      contactId: new Types.ObjectId(contact.body.id),
      name: 'Roof install',
      stageId: 'qualify',
      stageOutcome: 'open',
      version: 0,
    });

    const response = await owner.delete(`/api/contacts/${contact.body.id}`).expect(409);

    expect(response.body.error.code).toBe('CONFLICT');
    expect(response.body.error.message).toContain('1 opportunity');
    expect(response.body.error.details.opportunityCount).toBe(1);
    expect(response.body.error.hint).toContain('Move or delete them first');

    // Still there: the refusal is real, not cosmetic.
    expect(await ContactModel.countDocuments()).toBe(1);
  });

  it('deletes a contact that holds none, and audits it (F4.1)', async () => {
    const owner = await signUpOwner(app, { email: 'owner@example.com' });
    const contact = await owner.post('/api/contacts', { firstName: 'Ada' }).expect(201);

    await owner.delete(`/api/contacts/${contact.body.id}`).expect(204);

    expect(await ContactModel.countDocuments()).toBe(0);

    const events = await owner.get('/api/audit-events').expect(200);
    const deleted = events.body.items.find(
      (event: { type: string }) => event.type === AUDIT_EVENT_TYPES.CONTACT_DELETED,
    );
    expect(deleted.target.label).toBe('Ada');
  });
});

// ---------------------------------------------------------------------------
// Activity history (F2.7)
// ---------------------------------------------------------------------------

describe('activity history (F2.7)', () => {
  it('records creation with who and when', async () => {
    const owner = await signUpOwner(app, { email: 'owner@example.com' });
    const contact = await owner.post('/api/contacts', { firstName: 'Ada' }).expect(201);

    const timeline = await owner.get(`/api/contacts/${contact.body.id}/activity`).expect(200);

    expect(timeline.body.items).toHaveLength(1);
    expect(timeline.body.items[0]).toMatchObject({
      type: 'contact.created',
      summary: 'Created contact Ada',
    });
    expect(timeline.body.items[0].actor.label).toBe('owner@example.com');
    expect(timeline.body.items[0].createdAt).toBeTruthy();
  });

  it('records an edit and names the fields that changed', async () => {
    const owner = await signUpOwner(app);
    const contact = await owner.post('/api/contacts', { firstName: 'Ada' }).expect(201);

    await owner
      .patch(`/api/contacts/${contact.body.id}`, {
        firstName: 'Augusta',
        email: 'augusta@example.com',
        version: 0,
      })
      .expect(200);

    const timeline = await owner.get(`/api/contacts/${contact.body.id}/activity`).expect(200);
    const updated = timeline.body.items.find(
      (entry: { type: string }) => entry.type === 'contact.updated',
    );

    expect(updated.payload.changed).toEqual(['email', 'firstName']);
  });

  it('is newest first', async () => {
    const owner = await signUpOwner(app);
    const contact = await owner.post('/api/contacts', { firstName: 'Ada' }).expect(201);
    await owner
      .patch(`/api/contacts/${contact.body.id}`, { firstName: 'Augusta', version: 0 })
      .expect(200);

    const timeline = await owner.get(`/api/contacts/${contact.body.id}/activity`).expect(200);

    expect(timeline.body.items[0].type).toBe('contact.updated');
    expect(timeline.body.items[1].type).toBe('contact.created');
  });

  it('writes nothing when the change was refused', async () => {
    const owner = await signUpOwner(app);
    const contact = await owner.post('/api/contacts', { firstName: 'Ada' }).expect(201);

    const before = await ActivityModel.countDocuments();
    await owner
      .patch(`/api/contacts/${contact.body.id}`, { firstName: 'Nope', version: 99 })
      .expect(409);

    expect(await ActivityModel.countDocuments()).toBe(before);
  });

  it('returns 404 for a timeline in another workspace, not an empty list (F1.6)', async () => {
    const first = await signUpOwner(app, { email: 'a@example.com' });
    const second = await signUpOwner(app, { email: 'b@example.com' });

    const theirs = await second.post('/api/contacts', { firstName: 'Theirs' }).expect(201);

    // An empty timeline would read as "a contact with no history".
    await first.get(`/api/contacts/${theirs.body.id}/activity`).expect(404);
  });

  it('paginates (Q9)', async () => {
    const owner = await signUpOwner(app);
    const contact = await owner.post('/api/contacts', { firstName: 'Ada' }).expect(201);

    for (let version = 0; version < 4; version += 1) {
      await owner
        .patch(`/api/contacts/${contact.body.id}`, { firstName: `Name${String(version)}`, version })
        .expect(200);
    }

    const page = await owner
      .get(`/api/contacts/${contact.body.id}/activity?page=1&limit=2`)
      .expect(200);

    expect(page.body.items).toHaveLength(2);
    expect(page.body.pageInfo.total).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Permissions and isolation on every new endpoint (F1.5, F1.6)
// ---------------------------------------------------------------------------

describe('CRM permissions (F1.5)', () => {
  async function memberWith(permissions: string[]): Promise<TestClient> {
    const owner = await signUpOwner(app, { email: 'owner@example.com' });
    const member = await addMember(owner, 'member@example.com', 'user');

    await owner
      .patch(`/api/members/${member.membershipId}/permissions`, {
        permissionSetIds: [],
        extraPermissions: permissions,
      })
      .expect(204);

    return signIn(app, 'member@example.com');
  }

  it('refuses listing without crm.record.view', async () => {
    const member = await memberWith([]);

    await member.get('/api/contacts').expect(403);
    await member.get('/api/companies').expect(403);
  });

  it('refuses creating without crm.record.create', async () => {
    const member = await memberWith([PERMISSIONS.CRM_VIEW]);

    await member.post('/api/contacts', { firstName: 'Nope' }).expect(403);
    await member.post('/api/companies', { name: 'Nope' }).expect(403);
  });

  it('refuses editing without crm.record.edit', async () => {
    const member = await memberWith([PERMISSIONS.CRM_VIEW, PERMISSIONS.CRM_CREATE]);
    const contact = await member.post('/api/contacts', { firstName: 'Ada' }).expect(201);

    await member
      .patch(`/api/contacts/${contact.body.id}`, { firstName: 'Augusta', version: 0 })
      .expect(403);
  });

  it('refuses deleting without crm.record.delete', async () => {
    const member = await memberWith([
      PERMISSIONS.CRM_VIEW,
      PERMISSIONS.CRM_CREATE,
      PERMISSIONS.CRM_EDIT,
    ]);
    const contact = await member.post('/api/contacts', { firstName: 'Ada' }).expect(201);

    await member.delete(`/api/contacts/${contact.body.id}`).expect(403);
  });

  it('refuses an anonymous caller on every endpoint', async () => {
    await request(app).get('/api/contacts').expect(401);
    await request(app).get('/api/companies').expect(401);
    await request(app).post('/api/contacts').send({ firstName: 'x' }).expect(401);
  });
});

describe('CRM workspace isolation (F1.6, Q2)', () => {
  it('returns 404 for a contact in another workspace', async () => {
    const first = await signUpOwner(app, { email: 'a@example.com' });
    const second = await signUpOwner(app, { email: 'b@example.com' });

    const theirs = await second
      .post('/api/contacts', { firstName: 'Secret', lastName: 'Person' })
      .expect(201);

    const response = await first.get(`/api/contacts/${theirs.body.id}`).expect(404);
    expect(JSON.stringify(response.body)).not.toContain('Secret');
  });

  it('returns 404 when editing or deleting another workspace contact', async () => {
    const first = await signUpOwner(app, { email: 'a@example.com' });
    const second = await signUpOwner(app, { email: 'b@example.com' });

    const theirs = await second.post('/api/contacts', { firstName: 'Secret' }).expect(201);

    await first
      .patch(`/api/contacts/${theirs.body.id}`, { firstName: 'Hijacked', version: 0 })
      .expect(404);
    await first.delete(`/api/contacts/${theirs.body.id}`).expect(404);

    // Untouched.
    const detail = await second.get(`/api/contacts/${theirs.body.id}`).expect(200);
    expect(detail.body.contact.firstName).toBe('Secret');
  });

  it('returns 404 for another workspace company', async () => {
    const first = await signUpOwner(app, { email: 'a@example.com' });
    const second = await signUpOwner(app, { email: 'b@example.com' });

    const theirs = await second.post('/api/companies', { name: 'Theirs' }).expect(201);

    await first.patch(`/api/companies/${theirs.body.id}`, { name: 'Mine', version: 0 }).expect(404);
    await first.delete(`/api/companies/${theirs.body.id}`).expect(404);
  });

  it('lists only its own records', async () => {
    const first = await signUpOwner(app, { email: 'a@example.com' });
    const second = await signUpOwner(app, { email: 'b@example.com' });

    await second.post('/api/contacts', { firstName: 'Theirs' }).expect(201);
    await first.post('/api/contacts', { firstName: 'Mine' }).expect(201);

    const list = await first.get('/api/contacts').expect(200);

    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0].firstName).toBe('Mine');
  });

  it('answers 404 for a malformed id, so it cannot be told from "not yours"', async () => {
    const owner = await signUpOwner(app);

    await owner.get('/api/contacts/not-an-id').expect(404);
    await owner.get('/api/contacts/0123456789abcdef01234567').expect(404);
  });
});
