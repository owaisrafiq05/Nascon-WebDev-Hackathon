import { MASKED_EXPORT_PLACEHOLDER, PERMISSIONS } from '@ubmp/domain';
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
 * Field-level protection for opportunity value (F1.4), proven on all three read
 * paths the requirement names: list, detail and export.
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

/** Grants the value permission directly, as the matrix editor does. */
async function grantValueView(owner: TestClient, membershipId: string): Promise<void> {
  await owner
    .patch(`/api/members/${membershipId}/permissions`, {
      extraPermissions: [PERMISSIONS.OPPORTUNITY_VALUE_VIEW],
    })
    .expect(204);
}

const opportunityBody = {
  name: 'Roof install',
  value: 250_000,
  currency: 'USD',
  stageId: 'proposal',
};

describe('opportunity value masking (F1.4)', () => {
  it('shows the value to a member who holds opportunity.value.view', async () => {
    const owner = await signUpOwner(app);
    await owner.post('/api/opportunities', opportunityBody).expect(201);

    const list = await owner.get('/api/opportunities').expect(200);

    expect(list.body.items[0].value).toBe(250_000);
    expect(list.body.items[0].currency).toBe('USD');
    expect(list.body.items[0].valueMasked).toBe(false);
  });

  describe('for a member without the permission', () => {
    async function setUp(): Promise<{ owner: TestClient; member: TestClient; id: string }> {
      const owner = await signUpOwner(app, { email: 'owner@example.com' });
      const created = await owner.post('/api/opportunities', opportunityBody).expect(201);

      // Granted export and view, but never opportunity.value.view.
      const member = await addMember(owner, 'member@example.com', 'user');
      await owner
        .patch(`/api/members/${member.membershipId}/permissions`, {
          extraPermissions: [PERMISSIONS.CRM_VIEW, PERMISSIONS.CRM_EXPORT],
        })
        .expect(204);

      return { owner, member: await signIn(app, 'member@example.com'), id: created.body.id };
    }

    it('masks the value in the list', async () => {
      const { member } = await setUp();

      const list = await member.get('/api/opportunities').expect(200);

      expect(list.body.items[0].value).toBeNull();
      expect(list.body.items[0].currency).toBeNull();
      expect(list.body.items[0].valueMasked).toBe(true);
      expect(JSON.stringify(list.body)).not.toContain('250000');
    });

    it('masks the value on the detail page', async () => {
      const { member, id } = await setUp();

      const detail = await member.get(`/api/opportunities/${id}`).expect(200);

      expect(detail.body.value).toBeNull();
      expect(detail.body.valueMasked).toBe(true);
      expect(JSON.stringify(detail.body)).not.toContain('250000');
    });

    it('masks the value in the CSV export', async () => {
      const { member } = await setUp();

      const csv = await member.get('/api/opportunities/export/csv').expect(200);

      expect(csv.text).toContain(MASKED_EXPORT_PLACEHOLDER);
      expect(csv.text).not.toContain('2500');
      expect(csv.text).toContain('Roof install');
    });

    it('still shows every other field, so the record stays usable', async () => {
      const { member, id } = await setUp();

      const detail = await member.get(`/api/opportunities/${id}`).expect(200);

      expect(detail.body.name).toBe('Roof install');
      expect(detail.body.stageId).toBe('proposal');
    });
  });

  it('reveals the value once the Owner grants the permission', async () => {
    const owner = await signUpOwner(app, { email: 'owner@example.com' });
    await owner.post('/api/opportunities', opportunityBody).expect(201);
    const member = await addMember(owner, 'member@example.com', 'user');

    const before = await member.get('/api/opportunities').expect(200);
    expect(before.body.items[0].value).toBeNull();

    await grantValueView(owner, member.membershipId);

    const after = await signIn(app, 'member@example.com');
    const list = await after.get('/api/opportunities').expect(200);
    expect(list.body.items[0].value).toBe(250_000);
  });

  it('writes the amount in the export for a permitted member', async () => {
    const owner = await signUpOwner(app);
    await owner.post('/api/opportunities', opportunityBody).expect(201);

    const csv = await owner.get('/api/opportunities/export/csv').expect(200);

    expect(csv.text).toContain('2500.00');
    expect(csv.text).not.toContain(MASKED_EXPORT_PLACEHOLDER);
  });

  it('reports no value differently from a hidden value', async () => {
    const owner = await signUpOwner(app, { email: 'owner@example.com' });
    await owner.post('/api/opportunities', { name: 'Survey', stageId: 'qualify' }).expect(201);
    const member = await addMember(owner, 'member@example.com', 'user');

    const list = await member.get('/api/opportunities').expect(200);

    // Nothing was recorded, so nothing was hidden.
    expect(list.body.items[0].value).toBeNull();
    expect(list.body.items[0].valueMasked).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Server-side permission enforcement (F1.5)
// ---------------------------------------------------------------------------

describe('permission enforcement on opportunities', () => {
  it('refuses a member without crm.record.view, whatever the interface shows', async () => {
    const owner = await signUpOwner(app, { email: 'owner@example.com' });
    const member = await addMember(owner, 'member@example.com', 'user');

    await owner
      .patch(`/api/members/${member.membershipId}/permissions`, {
        permissionSetIds: [],
        extraPermissions: [],
      })
      .expect(204);

    const stripped = await signIn(app, 'member@example.com');
    const response = await stripped.get('/api/opportunities').expect(403);

    expect(response.body.error.details.requiredPermissions).toContain(PERMISSIONS.CRM_VIEW);
  });

  it('refuses creating without crm.record.create', async () => {
    const owner = await signUpOwner(app, { email: 'owner@example.com' });
    const member = await addMember(owner, 'member@example.com', 'user');

    await owner
      .patch(`/api/members/${member.membershipId}/permissions`, {
        permissionSetIds: [],
        extraPermissions: [PERMISSIONS.CRM_VIEW],
      })
      .expect(204);

    const viewer = await signIn(app, 'member@example.com');
    await viewer.post('/api/opportunities', opportunityBody).expect(403);
  });

  it('refuses the export to a member with view but not export', async () => {
    const owner = await signUpOwner(app, { email: 'owner@example.com' });
    const member = await addMember(owner, 'member@example.com', 'user');

    await owner
      .patch(`/api/members/${member.membershipId}/permissions`, {
        permissionSetIds: [],
        extraPermissions: [PERMISSIONS.CRM_VIEW],
      })
      .expect(204);

    const viewer = await signIn(app, 'member@example.com');
    const response = await viewer.get('/api/opportunities/export/csv').expect(403);

    expect(response.body.error.details.requiredPermissions).toContain(PERMISSIONS.CRM_EXPORT);
  });

  it('refuses an anonymous caller', async () => {
    await request(app).get('/api/opportunities').expect(401);
  });
});

// ---------------------------------------------------------------------------
// Workspace isolation (F1.6, Q2)
// ---------------------------------------------------------------------------

describe('opportunity workspace isolation', () => {
  it('returns 404, not the record, for an id from another workspace', async () => {
    const first = await signUpOwner(app, { email: 'a@example.com' });
    const second = await signUpOwner(app, { email: 'b@example.com' });

    const created = await second.post('/api/opportunities', opportunityBody).expect(201);

    const response = await first.get(`/api/opportunities/${created.body.id}`).expect(404);

    expect(response.body.error.code).toBe('NOT_FOUND');
    expect(JSON.stringify(response.body)).not.toContain('Roof install');
  });

  it('lists only its own workspace records', async () => {
    const first = await signUpOwner(app, { email: 'a@example.com' });
    const second = await signUpOwner(app, { email: 'b@example.com' });

    await second.post('/api/opportunities', opportunityBody).expect(201);
    await first.post('/api/opportunities', { name: 'Mine', stageId: 'qualify' }).expect(201);

    const list = await first.get('/api/opportunities').expect(200);

    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0].name).toBe('Mine');
  });

  it('exports only its own workspace records', async () => {
    const first = await signUpOwner(app, { email: 'a@example.com' });
    const second = await signUpOwner(app, { email: 'b@example.com' });

    await second.post('/api/opportunities', opportunityBody).expect(201);

    const csv = await first.get('/api/opportunities/export/csv').expect(200);

    expect(csv.text).not.toContain('Roof install');
  });

  it('cannot be written into another workspace by sending a workspaceId', async () => {
    const first = await signUpOwner(app, { email: 'a@example.com' });
    const second = await signUpOwner(app, { email: 'b@example.com' });

    await first
      .post('/api/opportunities', { ...opportunityBody, workspaceId: second.workspaceId })
      .expect(201);

    // It landed in the caller's own workspace, not the one in the body.
    expect((await second.get('/api/opportunities').expect(200)).body.items).toHaveLength(0);
    expect((await first.get('/api/opportunities').expect(200)).body.items).toHaveLength(1);
  });
});

describe('opportunity list pagination (Q9)', () => {
  it('honours page and limit, and reports the totals', async () => {
    const owner = await signUpOwner(app);

    for (let index = 0; index < 5; index += 1) {
      await owner
        .post('/api/opportunities', { name: `Opp ${String(index)}`, stageId: 'qualify' })
        .expect(201);
    }

    const page = await owner.get('/api/opportunities?page=2&limit=2').expect(200);

    expect(page.body.items).toHaveLength(2);
    expect(page.body.pageInfo).toMatchObject({ page: 2, limit: 2, total: 5, totalPages: 3 });
  });

  it('refuses a limit above the maximum', async () => {
    const owner = await signUpOwner(app);

    await owner.get('/api/opportunities?limit=5000').expect(422);
  });
});
