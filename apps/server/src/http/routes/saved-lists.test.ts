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

interface ListResult {
  items: { id: string; firstName?: string; name?: string }[];
  pageInfo: { total: number };
}

async function makeContact(
  client: TestClient,
  body: Record<string, unknown>,
): Promise<{ id: string; version: number }> {
  const response = await client.post('/api/contacts', body).expect(201);
  return response.body as { id: string; version: number };
}

// ---------------------------------------------------------------------------
// The filter builder's vocabulary
// ---------------------------------------------------------------------------

describe('GET /api/filters/schema', () => {
  it('serves the fields and operators the server accepts', async () => {
    const owner = await signUpOwner(app);

    const response = await owner.get('/api/filters/schema').expect(200);

    // The builder renders from this, so it cannot offer something that would be
    // refused.
    expect(response.body.fields).toContain('tag');
    expect(response.body.fields).toContain('customField');
    expect(response.body.operators).toContain('between');
  });
});

// ---------------------------------------------------------------------------
// Running a filter (F2.6)
// ---------------------------------------------------------------------------

describe('POST /api/filters/run', () => {
  it('combines three criteria, as F2.6 requires', async () => {
    const owner = await signUpOwner(app);
    const company = await owner.post('/api/companies', { name: 'Acme' }).expect(201);

    await makeContact(owner, {
      firstName: 'Match',
      tags: ['vip'],
      companyId: company.body.id,
      email: 'match@example.com',
    });
    await makeContact(owner, { firstName: 'WrongTag', tags: ['cold'] });
    await makeContact(owner, { firstName: 'NoCompany', tags: ['vip'] });

    const response = await owner
      .post('/api/filters/run', {
        entity: 'contact',
        filter: {
          join: 'and',
          criteria: [
            { field: 'tag', operator: 'eq', value: 'vip' },
            { field: 'company', operator: 'eq', value: company.body.id },
            { field: 'email', operator: 'isSet' },
          ],
        },
      })
      .expect(200);

    const result = response.body as ListResult;
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.firstName).toBe('Match');
  });

  it('matches any criterion with or', async () => {
    const owner = await signUpOwner(app);
    await makeContact(owner, { firstName: 'A', tags: ['vip'] });
    await makeContact(owner, { firstName: 'B', tags: ['cold'] });
    await makeContact(owner, { firstName: 'C', tags: ['warm'] });

    const response = await owner
      .post('/api/filters/run', {
        entity: 'contact',
        filter: {
          join: 'or',
          criteria: [
            { field: 'tag', operator: 'eq', value: 'vip' },
            { field: 'tag', operator: 'eq', value: 'cold' },
          ],
        },
      })
      .expect(200);

    expect((response.body as ListResult).items).toHaveLength(2);
  });

  it('filters on a custom field value', async () => {
    const owner = await signUpOwner(app);
    await owner
      .post('/api/custom-fields', {
        entity: 'contact',
        key: 'area',
        label: 'Area',
        type: 'number',
      })
      .expect(201);

    await makeContact(owner, { firstName: 'Big', customFields: { area: 300 } });
    await makeContact(owner, { firstName: 'Small', customFields: { area: 20 } });

    const response = await owner
      .post('/api/filters/run', {
        entity: 'contact',
        filter: {
          join: 'and',
          criteria: [{ field: 'customField', key: 'area', operator: 'gte', value: 100 }],
        },
      })
      .expect(200);

    const result = response.body as ListResult;
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.firstName).toBe('Big');
  });

  it('filters on a date range', async () => {
    const owner = await signUpOwner(app);
    await makeContact(owner, { firstName: 'Recent' });

    const past = new Date(Date.now() - 86_400_000).toISOString();
    const future = new Date(Date.now() + 86_400_000).toISOString();

    const inRange = await owner
      .post('/api/filters/run', {
        entity: 'contact',
        filter: {
          join: 'and',
          criteria: [{ field: 'createdAt', operator: 'between', value: [past, future] }],
        },
      })
      .expect(200);
    expect((inRange.body as ListResult).items).toHaveLength(1);

    const outOfRange = await owner
      .post('/api/filters/run', {
        entity: 'contact',
        filter: {
          join: 'and',
          criteria: [{ field: 'createdAt', operator: 'gt', value: future }],
        },
      })
      .expect(200);
    expect((outOfRange.body as ListResult).items).toHaveLength(0);
  });

  it('matches a substring, case-insensitively, without treating it as a pattern', async () => {
    const owner = await signUpOwner(app);
    await makeContact(owner, { firstName: 'Ada', lastName: 'Lovelace', email: 'ADA@example.com' });

    const found = await owner
      .post('/api/filters/run', {
        entity: 'contact',
        filter: {
          join: 'and',
          criteria: [{ field: 'email', operator: 'contains', value: 'ada@EXAMPLE' }],
        },
      })
      .expect(200);
    expect((found.body as ListResult).items).toHaveLength(1);

    // `.*` is escaped, so it matches literally and finds nothing.
    const injected = await owner
      .post('/api/filters/run', {
        entity: 'contact',
        filter: {
          join: 'and',
          criteria: [{ field: 'email', operator: 'contains', value: '.*' }],
        },
      })
      .expect(200);
    expect((injected.body as ListResult).items).toHaveLength(0);
  });

  it('treats a stored null as not set, not merely absent', async () => {
    const owner = await signUpOwner(app);
    await makeContact(owner, { firstName: 'NoEmail' });
    await makeContact(owner, { firstName: 'HasEmail', email: 'has@example.com' });

    const response = await owner
      .post('/api/filters/run', {
        entity: 'contact',
        filter: { join: 'and', criteria: [{ field: 'email', operator: 'isNotSet' }] },
      })
      .expect(200);

    const result = response.body as ListResult;
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.firstName).toBe('NoEmail');
  });

  it('returns everything for an empty filter', async () => {
    const owner = await signUpOwner(app);
    await makeContact(owner, { firstName: 'A' });
    await makeContact(owner, { firstName: 'B' });

    const response = await owner
      .post('/api/filters/run', { entity: 'contact', filter: { join: 'and', criteria: [] } })
      .expect(200);

    expect((response.body as ListResult).items).toHaveLength(2);
  });

  it('does not let two criteria on one field overwrite each other', async () => {
    const owner = await signUpOwner(app);
    await owner
      .post('/api/custom-fields', { entity: 'contact', key: 'area', label: 'A', type: 'number' })
      .expect(201);

    await makeContact(owner, { firstName: 'Mid', customFields: { area: 50 } });
    await makeContact(owner, { firstName: 'Big', customFields: { area: 500 } });

    // Compiled as $and, so both bounds apply.
    const response = await owner
      .post('/api/filters/run', {
        entity: 'contact',
        filter: {
          join: 'and',
          criteria: [
            { field: 'customField', key: 'area', operator: 'gte', value: 10 },
            { field: 'customField', key: 'area', operator: 'lte', value: 100 },
          ],
        },
      })
      .expect(200);

    const result = response.body as ListResult;
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.firstName).toBe('Mid');
  });

  it('paginates (Q9)', async () => {
    const owner = await signUpOwner(app);
    for (let index = 0; index < 5; index += 1) {
      await makeContact(owner, { firstName: `C${String(index)}`, tags: ['vip'] });
    }

    const response = await owner
      .post('/api/filters/run?page=2&limit=2', {
        entity: 'contact',
        filter: { join: 'and', criteria: [{ field: 'tag', operator: 'eq', value: 'vip' }] },
      })
      .expect(200);

    expect((response.body as ListResult).items).toHaveLength(2);
    expect((response.body as ListResult).pageInfo.total).toBe(5);
  });

  it('refuses a filter whose custom field key could reach the query language', async () => {
    const owner = await signUpOwner(app);

    const response = await owner
      .post('/api/filters/run', {
        entity: 'contact',
        filter: {
          join: 'and',
          criteria: [{ field: 'customField', key: '$where', operator: 'eq', value: 1 }],
        },
      })
      .expect(422);

    expect(response.body.error.details.issues[0].problem).toBe('unsafe_custom_field_key');
  });

  it('refuses a criterion with no value to compare', async () => {
    const owner = await signUpOwner(app);

    const response = await owner
      .post('/api/filters/run', {
        entity: 'contact',
        filter: { join: 'and', criteria: [{ field: 'name', operator: 'eq' }] },
      })
      .expect(422);

    expect(response.body.error.details.issues[0].message).toBe('Enter a value to compare against.');
  });

  it('refuses an unknown field at the schema boundary', async () => {
    const owner = await signUpOwner(app);

    await owner
      .post('/api/filters/run', {
        entity: 'contact',
        filter: { join: 'and', criteria: [{ field: 'password', operator: 'eq', value: 'x' }] },
      })
      .expect(422);
  });
});

// ---------------------------------------------------------------------------
// Saved lists update automatically (F2.6)
// ---------------------------------------------------------------------------

describe('saved lists (F2.6)', () => {
  it('saves a filter and reopens it', async () => {
    const owner = await signUpOwner(app);

    const created = await owner
      .post('/api/saved-lists', {
        name: 'VIP contacts',
        entity: 'contact',
        filter: { join: 'and', criteria: [{ field: 'tag', operator: 'eq', value: 'vip' }] },
      })
      .expect(201);

    const lists = await owner.get('/api/saved-lists').expect(200);
    expect(lists.body.savedLists).toHaveLength(1);
    expect(lists.body.savedLists[0].name).toBe('VIP contacts');

    // Reopening gives back the filter, so the builder can show it.
    const results = await owner.get(`/api/saved-lists/${created.body.id}/results`).expect(200);
    expect(results.body.savedList.filter.criteria).toHaveLength(1);
  });

  it('changes its result as a record starts and stops matching', async () => {
    const owner = await signUpOwner(app);

    const list = await owner
      .post('/api/saved-lists', {
        name: 'VIP contacts',
        entity: 'contact',
        filter: { join: 'and', criteria: [{ field: 'tag', operator: 'eq', value: 'vip' }] },
      })
      .expect(201);

    const contact = await makeContact(owner, { firstName: 'Ada', tags: ['cold'] });

    // Not matching yet.
    const before = await owner.get(`/api/saved-lists/${list.body.id}/results`).expect(200);
    expect((before.body as ListResult).items).toHaveLength(0);

    // Edited to match: the list is re-run, so it includes the record with no
    // invalidation step.
    await owner
      .patch(`/api/contacts/${contact.id}`, { tags: ['vip'], version: contact.version })
      .expect(200);

    const after = await owner.get(`/api/saved-lists/${list.body.id}/results`).expect(200);
    expect((after.body as ListResult).items).toHaveLength(1);
    expect((after.body as ListResult).items[0]?.firstName).toBe('Ada');

    // Edited to stop matching: it leaves the list again.
    await owner.patch(`/api/contacts/${contact.id}`, { tags: ['warm'], version: 1 }).expect(200);

    const removed = await owner.get(`/api/saved-lists/${list.body.id}/results`).expect(200);
    expect((removed.body as ListResult).items).toHaveLength(0);
  });

  it('includes a record created after the list was saved', async () => {
    const owner = await signUpOwner(app);

    const list = await owner
      .post('/api/saved-lists', {
        name: 'VIP contacts',
        entity: 'contact',
        filter: { join: 'and', criteria: [{ field: 'tag', operator: 'eq', value: 'vip' }] },
      })
      .expect(201);

    await makeContact(owner, { firstName: 'New', tags: ['vip'] });

    const results = await owner.get(`/api/saved-lists/${list.body.id}/results`).expect(200);
    expect((results.body as ListResult).items).toHaveLength(1);
  });

  it('can be edited, and the new filter takes effect at once', async () => {
    const owner = await signUpOwner(app);
    await makeContact(owner, { firstName: 'Cold', tags: ['cold'] });

    const list = await owner
      .post('/api/saved-lists', {
        name: 'Tagged',
        entity: 'contact',
        filter: { join: 'and', criteria: [{ field: 'tag', operator: 'eq', value: 'vip' }] },
      })
      .expect(201);

    expect(
      ((await owner.get(`/api/saved-lists/${list.body.id}/results`).expect(200)).body as ListResult)
        .items,
    ).toHaveLength(0);

    await owner
      .patch(`/api/saved-lists/${list.body.id}`, {
        filter: { join: 'and', criteria: [{ field: 'tag', operator: 'eq', value: 'cold' }] },
      })
      .expect(200);

    expect(
      ((await owner.get(`/api/saved-lists/${list.body.id}/results`).expect(200)).body as ListResult)
        .items,
    ).toHaveLength(1);
  });

  it('refuses an invalid filter rather than storing a list that always fails', async () => {
    const owner = await signUpOwner(app);

    await owner
      .post('/api/saved-lists', {
        name: 'Broken',
        entity: 'contact',
        filter: {
          join: 'and',
          criteria: [{ field: 'customField', key: '$where', operator: 'eq', value: 1 }],
        },
      })
      .expect(422);

    expect((await owner.get('/api/saved-lists').expect(200)).body.savedLists).toHaveLength(0);
  });

  it('refuses a duplicate name as a conflict, not a server error', async () => {
    const owner = await signUpOwner(app);
    const body = {
      name: 'VIP',
      entity: 'contact',
      filter: { join: 'and', criteria: [] },
    };

    await owner.post('/api/saved-lists', body).expect(201);

    const response = await owner.post('/api/saved-lists', body).expect(409);

    expect(response.body.error.code).toBe('CONFLICT');
    expect(response.body.error.hint).toBeTruthy();
    // The index name would expose the schema, so it is not echoed back.
    expect(JSON.stringify(response.body)).not.toContain('index');
  });

  it('deletes a list', async () => {
    const owner = await signUpOwner(app);
    const list = await owner
      .post('/api/saved-lists', {
        name: 'Temp',
        entity: 'contact',
        filter: { join: 'and', criteria: [] },
      })
      .expect(201);

    await owner.delete(`/api/saved-lists/${list.body.id}`).expect(204);
    await owner.get(`/api/saved-lists/${list.body.id}/results`).expect(404);
  });

  it('keeps a private list from the rest of the workspace', async () => {
    const owner = await signUpOwner(app, { email: 'owner@example.com' });
    const invite = await owner
      .post('/api/members/invites', { email: 'member@example.com', baseLevel: 'admin' })
      .expect(201);
    await request(app)
      .post('/api/members/invites/accept')
      .send({ token: invite.body.token, name: 'M', password: TEST_PASSWORD })
      .expect(204);
    const member = await signIn(app, 'member@example.com');

    const privateList = await owner
      .post('/api/saved-lists', {
        name: 'Mine only',
        entity: 'contact',
        filter: { join: 'and', criteria: [] },
        sharedWithWorkspace: false,
      })
      .expect(201);

    expect((await owner.get('/api/saved-lists').expect(200)).body.savedLists).toHaveLength(1);
    expect((await member.get('/api/saved-lists').expect(200)).body.savedLists).toHaveLength(0);

    // Not reachable by id either.
    await member.get(`/api/saved-lists/${privateList.body.id}/results`).expect(404);
  });
});

// ---------------------------------------------------------------------------
// Opportunity lists respect masking (F1.4)
// ---------------------------------------------------------------------------

describe('opportunity filter results respect value masking (F1.4)', () => {
  it('masks the value for a member without the permission', async () => {
    const owner = await signUpOwner(app, { email: 'owner@example.com' });
    const contact = await makeContact(owner, { firstName: 'Ada' });
    await owner
      .post('/api/opportunities', {
        name: 'Roof',
        contactId: contact.id,
        value: 250_000,
        currency: 'USD',
      })
      .expect(201);

    const invite = await owner
      .post('/api/members/invites', { email: 'member@example.com', baseLevel: 'user' })
      .expect(201);
    await request(app)
      .post('/api/members/invites/accept')
      .send({ token: invite.body.token, name: 'M', password: TEST_PASSWORD })
      .expect(204);
    const member = await signIn(app, 'member@example.com');

    const response = await member
      .post('/api/filters/run', {
        entity: 'opportunity',
        filter: { join: 'and', criteria: [] },
      })
      .expect(200);

    // A saved list is a read path like any other.
    expect(response.body.items[0].value).toBeNull();
    expect(response.body.items[0].valueMasked).toBe(true);
    expect(JSON.stringify(response.body)).not.toContain('250000');
  });

  it('shows the value to the Owner', async () => {
    const owner = await signUpOwner(app);
    const contact = await makeContact(owner, { firstName: 'Ada' });
    await owner
      .post('/api/opportunities', {
        name: 'Roof',
        contactId: contact.id,
        value: 250_000,
        currency: 'USD',
      })
      .expect(201);

    const response = await owner
      .post('/api/filters/run', { entity: 'opportunity', filter: { join: 'and', criteria: [] } })
      .expect(200);

    expect(response.body.items[0].value).toBe(250_000);
  });

  it('filters opportunities by stage outcome', async () => {
    const owner = await signUpOwner(app);
    const contact = await makeContact(owner, { firstName: 'Ada' });
    await owner.post('/api/opportunities', { name: 'Open one', contactId: contact.id }).expect(201);

    const response = await owner
      .post('/api/filters/run', {
        entity: 'opportunity',
        filter: {
          join: 'and',
          criteria: [{ field: 'stageOutcome', operator: 'eq', value: 'open' }],
        },
      })
      .expect(200);

    expect((response.body as ListResult).items).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Permissions and isolation (F1.5, F1.6)
// ---------------------------------------------------------------------------

describe('saved list permissions and isolation', () => {
  it('refuses a member without crm.record.view', async () => {
    const owner = await signUpOwner(app, { email: 'owner@example.com' });
    const invite = await owner
      .post('/api/members/invites', { email: 'member@example.com', baseLevel: 'user' })
      .expect(201);
    await request(app)
      .post('/api/members/invites/accept')
      .send({ token: invite.body.token, name: 'M', password: TEST_PASSWORD })
      .expect(204);

    await owner
      .patch(`/api/members/${(await signIn(app, 'member@example.com')).membershipId}/permissions`, {
        permissionSetIds: [],
        extraPermissions: [],
      })
      .expect(204);

    const stripped = await signIn(app, 'member@example.com');

    await stripped.get('/api/saved-lists').expect(403);
    await stripped
      .post('/api/filters/run', { entity: 'contact', filter: { join: 'and', criteria: [] } })
      .expect(403);
  });

  it('refuses an anonymous caller', async () => {
    await request(app).get('/api/saved-lists').expect(401);
    await request(app).post('/api/filters/run').send({}).expect(401);
  });

  it('never returns another workspace records, whatever the filter', async () => {
    const first = await signUpOwner(app, { email: 'a@example.com' });
    const second = await signUpOwner(app, { email: 'b@example.com' });

    await makeContact(second, { firstName: 'Secret', tags: ['vip'] });
    await makeContact(first, { firstName: 'Mine', tags: ['vip'] });

    const response = await first
      .post('/api/filters/run', {
        entity: 'contact',
        filter: { join: 'and', criteria: [{ field: 'tag', operator: 'eq', value: 'vip' }] },
      })
      .expect(200);

    const result = response.body as ListResult;
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.firstName).toBe('Mine');
    expect(JSON.stringify(response.body)).not.toContain('Secret');
  });

  it('cannot be widened by a criterion, because the scope is applied outside it', async () => {
    const first = await signUpOwner(app, { email: 'a@example.com' });
    const second = await signUpOwner(app, { email: 'b@example.com' });

    await makeContact(second, { firstName: 'Secret' });

    // An `or` filter that matches everything still only sees its own workspace.
    const response = await first
      .post('/api/filters/run', {
        entity: 'contact',
        filter: {
          join: 'or',
          criteria: [
            { field: 'name', operator: 'isSet' },
            { field: 'name', operator: 'isNotSet' },
          ],
        },
      })
      .expect(200);

    expect((response.body as ListResult).items).toHaveLength(0);
  });

  it('returns 404 for another workspace saved list', async () => {
    const first = await signUpOwner(app, { email: 'a@example.com' });
    const second = await signUpOwner(app, { email: 'b@example.com' });

    const theirs = await second
      .post('/api/saved-lists', {
        name: 'Theirs',
        entity: 'contact',
        filter: { join: 'and', criteria: [] },
      })
      .expect(201);

    await first.get(`/api/saved-lists/${theirs.body.id}/results`).expect(404);
    await first.patch(`/api/saved-lists/${theirs.body.id}`, { name: 'Mine' }).expect(404);
    await first.delete(`/api/saved-lists/${theirs.body.id}`).expect(404);
  });

  it('lists only its own saved lists', async () => {
    const first = await signUpOwner(app, { email: 'a@example.com' });
    const second = await signUpOwner(app, { email: 'b@example.com' });

    await second
      .post('/api/saved-lists', {
        name: 'Theirs',
        entity: 'contact',
        filter: { join: 'and', criteria: [] },
      })
      .expect(201);

    expect((await first.get('/api/saved-lists').expect(200)).body.savedLists).toEqual([]);
  });
});
