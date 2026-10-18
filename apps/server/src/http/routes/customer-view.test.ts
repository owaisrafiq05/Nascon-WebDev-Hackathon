import { PERMISSIONS } from '@ubmp/domain';
import type { Express } from 'express';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

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

/**
 * The complete customer view (F2.8) and the activity timeline it carries
 * (F2.7).
 */
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

async function addMember(owner: TestClient, email: string): Promise<TestClient> {
  const invite = await owner.post('/api/members/invites', { email, baseLevel: 'user' }).expect(201);
  await request(app)
    .post('/api/members/invites/accept')
    .send({ token: invite.body.token, name: email, password: TEST_PASSWORD })
    .expect(204);
  return signIn(app, email);
}

describe('GET /api/contacts/:id/view (F2.8)', () => {
  it('returns every section the requirement names, in one request', async () => {
    const owner = await signUpOwner(app, { email: 'owner@example.com' });
    const company = await owner.post('/api/companies', { name: 'Acme Roofing' }).expect(201);
    const contact = await owner
      .post('/api/contacts', {
        firstName: 'Ada',
        lastName: 'Lovelace',
        email: 'ada@acme.example',
        companyId: company.body.id,
      })
      .expect(201);

    await owner
      .post('/api/opportunities', {
        name: 'Roof install',
        contactId: contact.body.id,
        value: 250_000,
        currency: 'USD',
      })
      .expect(201);

    const view = await owner.get(`/api/contacts/${contact.body.id}/view`).expect(200);

    // The contact, its company and the employee it is assigned to.
    expect(view.body.contact.displayName).toBe('Ada Lovelace');
    expect(view.body.company.name).toBe('Acme Roofing');
    expect(view.body.assignedEmployee.email).toBe('owner@example.com');

    // Its opportunities, with the stage resolved to a name.
    expect(view.body.opportunities).toHaveLength(1);
    expect(view.body.opportunities[0].name).toBe('Roof install');
    expect(view.body.opportunities[0].stageName).toBe('New');
    expect(view.body.opportunities[0].pipelineName).toBe('Sales');

    // Its history.
    expect(view.body.activity.length).toBeGreaterThan(0);

    // And the three sections that are not connected yet.
    expect(view.body.conversations).toMatchObject({ items: [], availableFrom: 'P7' });
    expect(view.body.payments).toMatchObject({ items: [], availableFrom: 'P8' });
    expect(view.body.appointments).toMatchObject({ items: [], availableFrom: 'P9' });
  });

  it('explains why a section is empty rather than omitting it', async () => {
    const owner = await signUpOwner(app);
    const contact = await owner.post('/api/contacts', { firstName: 'Ada' }).expect(201);

    const view = await owner.get(`/api/contacts/${contact.body.id}/view`).expect(200);

    // The page can say "not connected yet" instead of rendering a section that
    // looks broken (Q10).
    expect(view.body.conversations.reason).toBe('Messaging is not connected yet.');
    expect(view.body.payments.reason).toBe('Payments are not connected yet.');
    expect(view.body.appointments.reason).toBe('The calendar is not connected yet.');
  });

  it('handles a contact with no company and no opportunities', async () => {
    const owner = await signUpOwner(app);
    const contact = await owner.post('/api/contacts', { firstName: 'Solo' }).expect(201);

    const view = await owner.get(`/api/contacts/${contact.body.id}/view`).expect(200);

    expect(view.body.company).toBeNull();
    expect(view.body.opportunities).toEqual([]);
  });

  it('includes an opportunity activity entry on the contact timeline', async () => {
    const owner = await signUpOwner(app);
    const contact = await owner.post('/api/contacts', { firstName: 'Ada' }).expect(201);
    await owner
      .post('/api/opportunities', { name: 'Roof install', contactId: contact.body.id })
      .expect(201);

    const view = await owner.get(`/api/contacts/${contact.body.id}/view`).expect(200);

    // What makes this a complete history rather than only the contact's own
    // edits (F2.8).
    const types = view.body.activity.map((entry: { type: string }) => entry.type);
    expect(types).toContain('contact.created');
    expect(types).toContain('opportunity.created');
  });

  it('includes a stage change made on an opportunity', async () => {
    const owner = await signUpOwner(app);
    const contact = await owner.post('/api/contacts', { firstName: 'Ada' }).expect(201);
    const opportunity = await owner
      .post('/api/opportunities', { name: 'Roof', contactId: contact.body.id })
      .expect(201);

    const pipelines = await owner.get('/api/pipelines').expect(200);
    const stages = pipelines.body.pipelines[0].stages;

    await owner
      .patch(`/api/opportunities/${opportunity.body.id}/stage`, {
        stageId: stages[1].id,
        version: opportunity.body.version,
      })
      .expect(200);

    const view = await owner.get(`/api/contacts/${contact.body.id}/view`).expect(200);
    const move = view.body.activity.find(
      (entry: { type: string }) => entry.type === 'opportunity.stage_changed',
    );

    expect(move.summary).toContain('Qualifying');
  });

  it('masks opportunity values for a member without the permission (F1.4)', async () => {
    const owner = await signUpOwner(app, { email: 'owner@example.com' });
    const contact = await owner.post('/api/contacts', { firstName: 'Ada' }).expect(201);
    await owner
      .post('/api/opportunities', {
        name: 'Roof',
        contactId: contact.body.id,
        value: 250_000,
        currency: 'USD',
      })
      .expect(201);

    const member = await addMember(owner, 'member@example.com');

    const view = await member.get(`/api/contacts/${contact.body.id}/view`).expect(200);

    // The customer view is a read path like any other.
    expect(view.body.opportunities[0].value).toBeNull();
    expect(view.body.opportunities[0].valueMasked).toBe(true);
    expect(JSON.stringify(view.body)).not.toContain('250000');
  });

  it('shows the value to a permitted member', async () => {
    const owner = await signUpOwner(app);
    const contact = await owner.post('/api/contacts', { firstName: 'Ada' }).expect(201);
    await owner
      .post('/api/opportunities', {
        name: 'Roof',
        contactId: contact.body.id,
        value: 250_000,
        currency: 'USD',
      })
      .expect(201);

    const view = await owner.get(`/api/contacts/${contact.body.id}/view`).expect(200);

    expect(view.body.opportunities[0].value).toBe(250_000);
  });

  it('returns 404 for a contact in another workspace (F1.6)', async () => {
    const first = await signUpOwner(app, { email: 'a@example.com' });
    const second = await signUpOwner(app, { email: 'b@example.com' });

    const theirs = await second.post('/api/contacts', { firstName: 'Secret' }).expect(201);

    // Not a page of empty sections, which would read as a real but inactive
    // contact and confirm the id exists.
    const response = await first.get(`/api/contacts/${theirs.body.id}/view`).expect(404);
    expect(JSON.stringify(response.body)).not.toContain('Secret');
  });

  it('refuses a member without crm.record.view', async () => {
    const owner = await signUpOwner(app, { email: 'owner@example.com' });
    const contact = await owner.post('/api/contacts', { firstName: 'Ada' }).expect(201);
    const member = await addMember(owner, 'member@example.com');

    await owner
      .patch(`/api/members/${member.membershipId}/permissions`, {
        permissionSetIds: [],
        extraPermissions: [],
      })
      .expect(204);

    const stripped = await signIn(app, 'member@example.com');
    const response = await stripped.get(`/api/contacts/${contact.body.id}/view`).expect(403);

    expect(response.body.error.details.requiredPermissions).toContain(PERMISSIONS.CRM_VIEW);
  });

  it('refuses an anonymous caller', async () => {
    await request(app).get('/api/contacts/0123456789abcdef01234567/view').expect(401);
  });
});

describe('notes (F2.7)', () => {
  it('records a note on the contact timeline', async () => {
    const owner = await signUpOwner(app, { email: 'owner@example.com' });
    const contact = await owner.post('/api/contacts', { firstName: 'Ada' }).expect(201);

    await owner
      .post(`/api/contacts/${contact.body.id}/notes`, { body: 'Rang about the roof survey.' })
      .expect(201);

    const view = await owner.get(`/api/contacts/${contact.body.id}/view`).expect(200);
    const note = view.body.activity.find((entry: { type: string }) => entry.type === 'note.added');

    expect(note.summary).toBe('Rang about the roof survey.');
    expect(note.payload.body).toBe('Rang about the roof survey.');
    expect(note.actor.label).toBe('owner@example.com');
  });

  it('moves the contact activity clock, because a note is a recorded action', async () => {
    const owner = await signUpOwner(app);
    const contact = await owner.post('/api/contacts', { firstName: 'Ada' }).expect(201);

    const before = await owner.get(`/api/contacts/${contact.body.id}/view`).expect(200);
    expect(before.body.contact.lastActivityAt).toBeNull();

    await owner.post(`/api/contacts/${contact.body.id}/notes`, { body: 'Called.' }).expect(201);

    const after = await owner.get(`/api/contacts/${contact.body.id}/view`).expect(200);
    expect(after.body.contact.lastActivityAt).not.toBeNull();
  });

  it('truncates a long note in the summary but keeps it whole in the payload', async () => {
    const owner = await signUpOwner(app);
    const contact = await owner.post('/api/contacts', { firstName: 'Ada' }).expect(201);
    const long = 'x'.repeat(300);

    await owner.post(`/api/contacts/${contact.body.id}/notes`, { body: long }).expect(201);

    const view = await owner.get(`/api/contacts/${contact.body.id}/view`).expect(200);
    const note = view.body.activity.find((entry: { type: string }) => entry.type === 'note.added');

    expect(note.summary).toHaveLength(120);
    expect(note.summary.endsWith('...')).toBe(true);
    expect(note.payload.body).toHaveLength(300);
  });

  it('rejects an empty note', async () => {
    const owner = await signUpOwner(app);
    const contact = await owner.post('/api/contacts', { firstName: 'Ada' }).expect(201);

    await owner.post(`/api/contacts/${contact.body.id}/notes`, { body: '   ' }).expect(422);
  });

  it('needs crm.record.edit', async () => {
    const owner = await signUpOwner(app, { email: 'owner@example.com' });
    const contact = await owner.post('/api/contacts', { firstName: 'Ada' }).expect(201);
    const member = await addMember(owner, 'member@example.com');

    await owner
      .patch(`/api/members/${member.membershipId}/permissions`, {
        permissionSetIds: [],
        extraPermissions: [PERMISSIONS.CRM_VIEW],
      })
      .expect(204);

    const viewer = await signIn(app, 'member@example.com');
    await viewer.post(`/api/contacts/${contact.body.id}/notes`, { body: 'Nope.' }).expect(403);
  });

  it('returns 404 for a contact in another workspace', async () => {
    const first = await signUpOwner(app, { email: 'a@example.com' });
    const second = await signUpOwner(app, { email: 'b@example.com' });

    const theirs = await second.post('/api/contacts', { firstName: 'Secret' }).expect(201);

    await first.post(`/api/contacts/${theirs.body.id}/notes`, { body: 'Hello.' }).expect(404);
  });
});

describe('GET /api/opportunities/:id/activity (F2.7)', () => {
  it('returns the opportunity own timeline', async () => {
    const owner = await signUpOwner(app);
    const contact = await owner.post('/api/contacts', { firstName: 'Ada' }).expect(201);
    const opportunity = await owner
      .post('/api/opportunities', { name: 'Roof', contactId: contact.body.id })
      .expect(201);

    const timeline = await owner
      .get(`/api/opportunities/${opportunity.body.id}/activity`)
      .expect(200);

    expect(timeline.body.items).toHaveLength(1);
    expect(timeline.body.items[0].type).toBe('opportunity.created');
  });

  it('does not include the contact own entries', async () => {
    const owner = await signUpOwner(app);
    const contact = await owner.post('/api/contacts', { firstName: 'Ada' }).expect(201);
    const opportunity = await owner
      .post('/api/opportunities', { name: 'Roof', contactId: contact.body.id })
      .expect(201);

    const timeline = await owner
      .get(`/api/opportunities/${opportunity.body.id}/activity`)
      .expect(200);

    const types = timeline.body.items.map((entry: { type: string }) => entry.type);
    expect(types).not.toContain('contact.created');
  });

  it('paginates (Q9)', async () => {
    const owner = await signUpOwner(app);
    const contact = await owner.post('/api/contacts', { firstName: 'Ada' }).expect(201);
    const opportunity = await owner
      .post('/api/opportunities', { name: 'Roof', contactId: contact.body.id })
      .expect(201);

    for (let version = 0; version < 3; version += 1) {
      await owner
        .patch(`/api/opportunities/${opportunity.body.id}`, {
          name: `Roof ${String(version)}`,
          version,
        })
        .expect(200);
    }

    const page = await owner
      .get(`/api/opportunities/${opportunity.body.id}/activity?page=1&limit=2`)
      .expect(200);

    expect(page.body.items).toHaveLength(2);
    expect(page.body.pageInfo.total).toBe(4);
  });

  it('returns 404 for another workspace opportunity', async () => {
    const first = await signUpOwner(app, { email: 'a@example.com' });
    const second = await signUpOwner(app, { email: 'b@example.com' });

    const theirContact = await second.post('/api/contacts', { firstName: 'Theirs' }).expect(201);
    const theirs = await second
      .post('/api/opportunities', { name: 'Secret job', contactId: theirContact.body.id })
      .expect(201);

    await first.get(`/api/opportunities/${theirs.body.id}/activity`).expect(404);
  });
});
