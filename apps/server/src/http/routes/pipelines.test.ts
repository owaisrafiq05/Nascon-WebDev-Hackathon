import { AUDIT_EVENT_TYPES, PERMISSIONS } from '@ubmp/domain';
import type { Express } from 'express';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

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

interface Stage {
  id: string;
  name: string;
  position: number;
  outcome: string;
}

interface Pipeline {
  id: string;
  name: string;
  isDefault: boolean;
  stages: Stage[];
  version: number;
}

async function defaultPipeline(client: TestClient): Promise<Pipeline> {
  const response = await client.get('/api/pipelines').expect(200);
  const body = response.body as { pipelines: Pipeline[] };

  const pipeline = body.pipelines.find((candidate) => candidate.isDefault);
  if (pipeline === undefined) throw new Error('no default pipeline');

  return pipeline;
}

async function makeContact(client: TestClient, firstName = 'Ada'): Promise<string> {
  const response = await client.post('/api/contacts', { firstName }).expect(201);
  return (response.body as { id: string }).id;
}

// ---------------------------------------------------------------------------
// The seeded pipeline (F2.5)
// ---------------------------------------------------------------------------

describe('the default pipeline', () => {
  it('is seeded on sign-up, so a new workspace can hold an opportunity', async () => {
    const owner = await signUpOwner(app);

    const pipeline = await defaultPipeline(owner);

    expect(pipeline).toBeDefined();
    expect(pipeline.stages.map((stage) => stage.name)).toEqual([
      'New',
      'Qualifying',
      'Proposal',
      'Won',
      'Lost',
    ]);
  });

  it('ends with a winning and a losing stage', async () => {
    const owner = await signUpOwner(app);
    const pipeline = await defaultPipeline(owner);

    expect(pipeline.stages.at(-2)?.outcome).toBe('won');
    expect(pipeline.stages.at(-1)?.outcome).toBe('lost');
  });

  it('gives each stage an opaque id, not its name', async () => {
    const owner = await signUpOwner(app);
    const pipeline = await defaultPipeline(owner);

    // Renaming a stage must not detach its opportunities, so the id is not
    // derived from the name.
    expect(pipeline.stages[0]?.id).not.toBe('New');
    expect(pipeline.stages[0]?.id).toMatch(/^[0-9a-f-]{36}$/);
  });
});

// ---------------------------------------------------------------------------
// Custom fields appear in the next form schema (F2.2)
// ---------------------------------------------------------------------------

describe('custom fields created from the interface (F2.2)', () => {
  it('appears in the next form schema with no deployment', async () => {
    const owner = await signUpOwner(app);

    const before = await owner.get('/api/custom-fields?entity=contact').expect(200);
    expect(before.body.customFields).toEqual([]);

    await owner
      .post('/api/custom-fields', {
        entity: 'contact',
        key: 'referred_by',
        label: 'Referred by',
        type: 'text',
      })
      .expect(201);

    const after = await owner.get('/api/custom-fields?entity=contact').expect(200);

    expect(after.body.customFields).toHaveLength(1);
    expect(after.body.customFields[0]).toMatchObject({
      key: 'referred_by',
      label: 'Referred by',
      type: 'text',
    });
  });

  it('accepts each of the five types F2.2 names', async () => {
    const owner = await signUpOwner(app);

    const types = [
      { key: 'notes', type: 'text' },
      { key: 'area', type: 'number' },
      { key: 'survey_on', type: 'date' },
      { key: 'tier', type: 'dropdown', options: ['bronze', 'gold'] },
      { key: 'surveyed', type: 'checkbox' },
    ];

    for (const field of types) {
      await owner
        .post('/api/custom-fields', { entity: 'contact', label: field.key, ...field })
        .expect(201);
    }

    const schema = await owner.get('/api/custom-fields?entity=contact').expect(200);
    expect(schema.body.customFields).toHaveLength(5);
  });

  it('validates a stored value against the definition', async () => {
    const owner = await signUpOwner(app);
    await owner
      .post('/api/custom-fields', {
        entity: 'opportunity',
        key: 'area',
        label: 'Area',
        type: 'number',
      })
      .expect(201);

    const contactId = await makeContact(owner);

    // A string where the definition says number is refused.
    const bad = await owner
      .post('/api/opportunities', {
        name: 'Roof',
        contactId,
        customFields: { area: 'fifty' },
      })
      .expect(422);
    expect(bad.body.error.details.fields.area).toBeDefined();

    await owner
      .post('/api/opportunities', { name: 'Roof', contactId, customFields: { area: 50 } })
      .expect(201);
  });

  it('refuses a dropdown with no options, which could hold nothing', async () => {
    const owner = await signUpOwner(app);

    const response = await owner
      .post('/api/custom-fields', {
        entity: 'contact',
        key: 'tier',
        label: 'Tier',
        type: 'dropdown',
      })
      .expect(400);

    expect(response.body.error.message).toContain('at least one option');
  });

  it('refuses a key that MongoDB would read as an operator or a path', async () => {
    const owner = await signUpOwner(app);

    for (const key of ['$where', 'a.b', 'Roof Type']) {
      await owner
        .post('/api/custom-fields', { entity: 'contact', key, label: 'x', type: 'text' })
        .expect(422);
    }
  });

  it('refuses a duplicate key in the same place', async () => {
    const owner = await signUpOwner(app);
    const field = { entity: 'contact', key: 'referred_by', label: 'Referred by', type: 'text' };

    await owner.post('/api/custom-fields', field).expect(201);
    await owner.post('/api/custom-fields', field).expect(409);
  });

  it('refuses requiredInStageIds on a contact field, which has no stages', async () => {
    const owner = await signUpOwner(app);

    const response = await owner
      .post('/api/custom-fields', {
        entity: 'contact',
        key: 'x',
        label: 'X',
        type: 'text',
        requiredInStageIds: ['something'],
      })
      .expect(400);

    expect(response.body.error.message).toContain('Only opportunity fields');
  });

  it('records the creation in the audit log (F4.1)', async () => {
    const owner = await signUpOwner(app);
    await owner
      .post('/api/custom-fields', { entity: 'contact', key: 'x', label: 'X', type: 'text' })
      .expect(201);

    const events = await owner.get('/api/audit-events').expect(200);
    const created = events.body.items.find(
      (event: { type: string }) => event.type === AUDIT_EVENT_TYPES.CUSTOM_FIELD_CREATED,
    );

    expect(created.after.key).toBe('x');
  });

  it('leaves stored values alone when a definition is deleted', async () => {
    const owner = await signUpOwner(app);
    const field = await owner
      .post('/api/custom-fields', {
        entity: 'opportunity',
        key: 'area',
        label: 'Area',
        type: 'number',
      })
      .expect(201);

    const contactId = await makeContact(owner);
    const opportunity = await owner
      .post('/api/opportunities', { name: 'Roof', contactId, customFields: { area: 50 } })
      .expect(201);

    await owner.delete(`/api/custom-fields/${field.body.id}`).expect(204);

    // Unreachable through the schema, but not destroyed: re-adding the field
    // brings the history back.
    const stored = await OpportunityModel.findById(opportunity.body.id).lean();
    expect(stored?.customFields).toEqual({ area: 50 });
  });
});

// ---------------------------------------------------------------------------
// Two pipelines, different fields, one shared contact (F2.3)
// ---------------------------------------------------------------------------

describe('two pipelines show different fields for the same contact (F2.3)', () => {
  it('keeps each pipeline field set separate while the contact is shared', async () => {
    const owner = await signUpOwner(app);
    const sales = await defaultPipeline(owner);

    const service = await owner
      .post('/api/pipelines', {
        name: 'Service',
        stageNames: ['Reported', 'Scheduled', 'Resolved'],
      })
      .expect(201);

    // A field on each pipeline, with the same key on purpose: the unique index
    // is per pipeline, so both may exist.
    await owner
      .post('/api/custom-fields', {
        entity: 'opportunity',
        pipelineId: sales.id,
        key: 'roof_type',
        label: 'Roof type',
        type: 'text',
      })
      .expect(201);

    await owner
      .post('/api/custom-fields', {
        entity: 'opportunity',
        pipelineId: service.body.id,
        key: 'fault_code',
        label: 'Fault code',
        type: 'text',
      })
      .expect(201);

    const salesSchema = await owner
      .get(`/api/custom-fields?entity=opportunity&pipelineId=${sales.id}`)
      .expect(200);
    const serviceSchema = await owner
      .get(`/api/custom-fields?entity=opportunity&pipelineId=${service.body.id}`)
      .expect(200);

    expect(salesSchema.body.customFields.map((f: { key: string }) => f.key)).toEqual(['roof_type']);
    expect(serviceSchema.body.customFields.map((f: { key: string }) => f.key)).toEqual([
      'fault_code',
    ]);

    // One contact, an opportunity in each pipeline, each carrying its own field.
    const contactId = await makeContact(owner, 'Shared');

    const salesOpportunity = await owner
      .post('/api/opportunities', {
        name: 'Roof job',
        contactId,
        pipelineId: sales.id,
        customFields: { roof_type: 'tile' },
      })
      .expect(201);

    const serviceOpportunity = await owner
      .post('/api/opportunities', {
        name: 'Leak call',
        contactId,
        pipelineId: service.body.id,
        customFields: { fault_code: 'E12' },
      })
      .expect(201);

    expect(salesOpportunity.body.customFields).toEqual({ roof_type: 'tile' });
    expect(serviceOpportunity.body.customFields).toEqual({ fault_code: 'E12' });

    // Both hang off the same contact.
    const related = await owner.get(`/api/opportunities?contactId=${contactId}`).expect(200);
    expect(related.body.items).toHaveLength(2);
  });

  it('strips a field that belongs to the other pipeline', async () => {
    const owner = await signUpOwner(app);
    const sales = await defaultPipeline(owner);
    const service = await owner.post('/api/pipelines', { name: 'Service' }).expect(201);

    await owner
      .post('/api/custom-fields', {
        entity: 'opportunity',
        pipelineId: sales.id,
        key: 'roof_type',
        label: 'Roof type',
        type: 'text',
      })
      .expect(201);

    const contactId = await makeContact(owner);
    const created = await owner
      .post('/api/opportunities', {
        name: 'Leak call',
        contactId,
        pipelineId: service.body.id,
        customFields: { roof_type: 'tile' },
      })
      .expect(201);

    // The Service pipeline does not define roof_type, so it is not stored.
    expect(created.body.customFields).toEqual({});
  });

  it('refuses a pipeline name that already exists', async () => {
    const owner = await signUpOwner(app);

    await owner.post('/api/pipelines', { name: 'Service' }).expect(201);
    await owner.post('/api/pipelines', { name: 'Service' }).expect(409);
  });
});

// ---------------------------------------------------------------------------
// Stage-required fields block the move (F2.4)
// ---------------------------------------------------------------------------

describe('stage-required fields (F2.4)', () => {
  async function setUp(): Promise<{
    owner: TestClient;
    stages: Stage[];
    opportunityId: string;
    version: number;
  }> {
    const owner = await signUpOwner(app);
    const pipeline = await defaultPipeline(owner);
    const proposal = pipeline.stages.find((stage) => stage.name === 'Proposal')!;

    await owner
      .post('/api/custom-fields', {
        entity: 'opportunity',
        pipelineId: pipeline.id,
        key: 'area',
        label: 'Roof area',
        type: 'number',
        requiredInStageIds: [proposal.id],
      })
      .expect(201);

    const contactId = await makeContact(owner);
    const created = await owner
      .post('/api/opportunities', { name: 'Roof install', contactId })
      .expect(201);

    return {
      owner,
      stages: pipeline.stages,
      opportunityId: created.body.id,
      version: created.body.version,
    };
  }

  it('blocks the move with a clear message naming the missing field', async () => {
    const { owner, stages, opportunityId, version } = await setUp();
    const proposal = stages.find((stage) => stage.name === 'Proposal')!;

    const response = await owner
      .patch(`/api/opportunities/${opportunityId}/stage`, { stageId: proposal.id, version })
      .expect(422);

    expect(response.body.error.message).toBe('Fill in Roof area before moving this to Proposal.');
    expect(response.body.error.details.fields.area).toBe('is required in this stage');
    expect(response.body.error.details.missing).toEqual([{ key: 'area', label: 'Roof area' }]);
    expect(response.body.error.hint).toBeTruthy();
  });

  it('leaves the opportunity in its original stage after a blocked move', async () => {
    const { owner, stages, opportunityId, version } = await setUp();
    const proposal = stages.find((stage) => stage.name === 'Proposal')!;
    const before = await owner.get(`/api/opportunities/${opportunityId}`).expect(200);

    await owner
      .patch(`/api/opportunities/${opportunityId}/stage`, { stageId: proposal.id, version })
      .expect(422);

    const after = await owner.get(`/api/opportunities/${opportunityId}`).expect(200);
    expect(after.body.stageId).toBe(before.body.stageId);
    expect(after.body.version).toBe(before.body.version);
  });

  it('allows the move once the field is supplied in the same request', async () => {
    const { owner, stages, opportunityId, version } = await setUp();
    const proposal = stages.find((stage) => stage.name === 'Proposal')!;

    const moved = await owner
      .patch(`/api/opportunities/${opportunityId}/stage`, {
        stageId: proposal.id,
        version,
        customFields: { area: 120 },
      })
      .expect(200);

    expect(moved.body.stageId).toBe(proposal.id);
    expect(moved.body.customFields).toEqual({ area: 120 });
  });

  it('allows the move when the field was filled in earlier', async () => {
    const { owner, stages, opportunityId, version } = await setUp();
    const proposal = stages.find((stage) => stage.name === 'Proposal')!;

    await owner
      .patch(`/api/opportunities/${opportunityId}`, { customFields: { area: 90 }, version })
      .expect(200);

    // Not resent: the stored value satisfies the requirement.
    await owner
      .patch(`/api/opportunities/${opportunityId}/stage`, { stageId: proposal.id, version: 1 })
      .expect(200);
  });

  it('does not block a move into a stage that does not require the field', async () => {
    const { owner, stages, opportunityId, version } = await setUp();
    const qualifying = stages.find((stage) => stage.name === 'Qualifying')!;

    await owner
      .patch(`/api/opportunities/${opportunityId}/stage`, { stageId: qualifying.id, version })
      .expect(200);
  });

  it('names several missing fields in one message', async () => {
    const owner = await signUpOwner(app);
    const pipeline = await defaultPipeline(owner);
    const proposal = pipeline.stages.find((stage) => stage.name === 'Proposal')!;

    for (const field of [
      { key: 'area', label: 'Roof area', type: 'number' },
      { key: 'survey_on', label: 'Survey date', type: 'date' },
    ]) {
      await owner
        .post('/api/custom-fields', {
          entity: 'opportunity',
          pipelineId: pipeline.id,
          requiredInStageIds: [proposal.id],
          ...field,
        })
        .expect(201);
    }

    const contactId = await makeContact(owner);
    const created = await owner.post('/api/opportunities', { name: 'Roof', contactId }).expect(201);

    const response = await owner
      .patch(`/api/opportunities/${created.body.id}/stage`, {
        stageId: proposal.id,
        version: created.body.version,
      })
      .expect(422);

    expect(response.body.error.message).toBe(
      'Fill in Roof area and Survey date before moving this to Proposal.',
    );
  });

  it('updates the stage outcome with the stage, so the board and the figures agree', async () => {
    const { owner, stages, opportunityId, version } = await setUp();
    const won = stages.find((stage) => stage.outcome === 'won')!;

    const moved = await owner
      .patch(`/api/opportunities/${opportunityId}/stage`, { stageId: won.id, version })
      .expect(200);

    expect(moved.body.stageOutcome).toBe('won');
  });

  it('records the move on the timeline, naming both stages (F2.7)', async () => {
    const { owner, stages, opportunityId, version } = await setUp();
    const qualifying = stages.find((stage) => stage.name === 'Qualifying')!;
    const detail = await owner.get(`/api/opportunities/${opportunityId}`).expect(200);

    await owner
      .patch(`/api/opportunities/${opportunityId}/stage`, { stageId: qualifying.id, version })
      .expect(200);

    const timeline = await owner.get(`/api/contacts/${detail.body.contactId}/activity`).expect(200);

    const move = timeline.body.items.find(
      (entry: { type: string }) => entry.type === 'opportunity.stage_changed',
    );

    expect(move.summary).toContain('to Qualifying');
    expect(move.payload.toStageName).toBe('Qualifying');
  });

  it('refuses a stage that is not in the pipeline', async () => {
    const { owner, opportunityId, version } = await setUp();

    await owner
      .patch(`/api/opportunities/${opportunityId}/stage`, { stageId: 'not-a-stage', version })
      .expect(404);
  });

  it('refuses a move with a stale version (Q4)', async () => {
    const { owner, stages, opportunityId, version } = await setUp();
    const qualifying = stages.find((stage) => stage.name === 'Qualifying')!;
    const proposal = stages.find((stage) => stage.name === 'Proposal')!;

    await owner
      .patch(`/api/opportunities/${opportunityId}/stage`, { stageId: qualifying.id, version })
      .expect(200);

    await owner
      .patch(`/api/opportunities/${opportunityId}/stage`, {
        stageId: proposal.id,
        version,
        customFields: { area: 1 },
      })
      .expect(409);
  });
});

// ---------------------------------------------------------------------------
// Stage management (F2.5)
// ---------------------------------------------------------------------------

describe('stage management (F2.5)', () => {
  it('adds a stage before the closing stages', async () => {
    const owner = await signUpOwner(app);
    const pipeline = await defaultPipeline(owner);

    const updated = await owner
      .post(`/api/pipelines/${pipeline.id}/stages`, { name: 'Negotiation', outcome: 'open' })
      .expect(201);

    expect(updated.body.stages.map((stage: Stage) => stage.name)).toEqual([
      'New',
      'Qualifying',
      'Proposal',
      'Negotiation',
      'Won',
      'Lost',
    ]);
  });

  it('renames a stage without detaching its opportunities', async () => {
    const owner = await signUpOwner(app);
    const pipeline = await defaultPipeline(owner);
    const first = pipeline.stages[0]!;

    const contactId = await makeContact(owner);
    const opportunity = await owner
      .post('/api/opportunities', { name: 'Roof', contactId })
      .expect(201);

    await owner
      .patch(`/api/pipelines/${pipeline.id}/stages/${first.id}`, { name: 'Fresh' })
      .expect(200);

    const after = await owner.get(`/api/opportunities/${opportunity.body.id}`).expect(200);
    expect(after.body.stageId).toBe(first.id);
  });

  it('reorders stages and renumbers contiguously', async () => {
    const owner = await signUpOwner(app);
    const pipeline = await defaultPipeline(owner);
    const reversed = [...pipeline.stages].reverse().map((stage) => stage.id);

    const updated = await owner
      .patch(`/api/pipelines/${pipeline.id}/stage-order`, { stageIds: reversed })
      .expect(200);

    expect(updated.body.stages.map((stage: Stage) => stage.id)).toEqual(reversed);
    expect(updated.body.stages.map((stage: Stage) => stage.position)).toEqual([0, 1, 2, 3, 4]);
  });

  it('deletes an empty stage', async () => {
    const owner = await signUpOwner(app);
    const pipeline = await defaultPipeline(owner);
    const proposal = pipeline.stages.find((stage) => stage.name === 'Proposal')!;

    const result = await owner
      .delete(`/api/pipelines/${pipeline.id}/stages/${proposal.id}`)
      .expect(200);

    expect(result.body.movedOpportunities).toBe(0);

    const after = await defaultPipeline(owner);
    expect(after.stages.map((stage) => stage.name)).not.toContain('Proposal');
  });

  it('refuses to delete a populated stage without a destination, with the count', async () => {
    const owner = await signUpOwner(app);
    const pipeline = await defaultPipeline(owner);
    const first = pipeline.stages[0]!;

    const contactId = await makeContact(owner);
    await owner.post('/api/opportunities', { name: 'One', contactId }).expect(201);
    await owner.post('/api/opportunities', { name: 'Two', contactId }).expect(201);

    const response = await owner
      .delete(`/api/pipelines/${pipeline.id}/stages/${first.id}`)
      .expect(409);

    expect(response.body.error.message).toBe('2 opportunities are still in New.');
    expect(response.body.error.details.opportunityCount).toBe(2);
    expect(response.body.error.details.availableStageIds).toHaveLength(4);
    expect(response.body.error.hint).toContain('Choose a stage to move them to');

    // Nothing was deleted.
    const after = await defaultPipeline(owner);
    expect(after.stages).toHaveLength(5);
  });

  it('uses the singular for one opportunity', async () => {
    const owner = await signUpOwner(app);
    const pipeline = await defaultPipeline(owner);
    const first = pipeline.stages[0]!;

    const contactId = await makeContact(owner);
    await owner.post('/api/opportunities', { name: 'One', contactId }).expect(201);

    const response = await owner
      .delete(`/api/pipelines/${pipeline.id}/stages/${first.id}`)
      .expect(409);

    expect(response.body.error.message).toBe('1 opportunity is still in New.');
  });

  it('deletes a populated stage once a destination is given, moving them', async () => {
    const owner = await signUpOwner(app);
    const pipeline = await defaultPipeline(owner);
    const first = pipeline.stages[0]!;
    const qualifying = pipeline.stages.find((stage) => stage.name === 'Qualifying')!;

    const contactId = await makeContact(owner);
    const opportunity = await owner
      .post('/api/opportunities', { name: 'One', contactId })
      .expect(201);

    const result = await owner
      .delete(`/api/pipelines/${pipeline.id}/stages/${first.id}?moveToStageId=${qualifying.id}`)
      .expect(200);

    expect(result.body.movedOpportunities).toBe(1);

    const moved = await owner.get(`/api/opportunities/${opportunity.body.id}`).expect(200);
    expect(moved.body.stageId).toBe(qualifying.id);
    expect(moved.body.stageOutcome).toBe('open');
  });

  it('refuses moving the opportunities into the stage being deleted', async () => {
    const owner = await signUpOwner(app);
    const pipeline = await defaultPipeline(owner);
    const first = pipeline.stages[0]!;

    const contactId = await makeContact(owner);
    await owner.post('/api/opportunities', { name: 'One', contactId }).expect(201);

    await owner
      .delete(`/api/pipelines/${pipeline.id}/stages/${first.id}?moveToStageId=${first.id}`)
      .expect(400);
  });

  it('carries the destination outcome onto the moved opportunities', async () => {
    const owner = await signUpOwner(app);
    const pipeline = await defaultPipeline(owner);
    const first = pipeline.stages[0]!;
    const won = pipeline.stages.find((stage) => stage.outcome === 'won')!;

    const contactId = await makeContact(owner);
    const opportunity = await owner
      .post('/api/opportunities', { name: 'One', contactId })
      .expect(201);

    await owner
      .delete(`/api/pipelines/${pipeline.id}/stages/${first.id}?moveToStageId=${won.id}`)
      .expect(200);

    const moved = await owner.get(`/api/opportunities/${opportunity.body.id}`).expect(200);
    expect(moved.body.stageOutcome).toBe('won');
  });

  it('corrects the denormalised outcome when a stage outcome changes', async () => {
    const owner = await signUpOwner(app);
    const pipeline = await defaultPipeline(owner);
    const first = pipeline.stages[0]!;

    const contactId = await makeContact(owner);
    const opportunity = await owner
      .post('/api/opportunities', { name: 'One', contactId })
      .expect(201);
    expect(opportunity.body.stageOutcome).toBe('open');

    await owner
      .patch(`/api/pipelines/${pipeline.id}/stages/${first.id}`, { outcome: 'won' })
      .expect(200);

    // Left alone, the open-pipeline-value figure would disagree with the board.
    const after = await owner.get(`/api/opportunities/${opportunity.body.id}`).expect(200);
    expect(after.body.stageOutcome).toBe('won');
  });

  it('records stage changes in the audit log (F4.1)', async () => {
    const owner = await signUpOwner(app);
    const pipeline = await defaultPipeline(owner);

    await owner.post(`/api/pipelines/${pipeline.id}/stages`, { name: 'Negotiation' }).expect(201);

    const events = await owner.get('/api/audit-events').expect(200);
    const types = events.body.items.map((event: { type: string }) => event.type);

    expect(types).toContain(AUDIT_EVENT_TYPES.STAGE_CREATED);
  });
});

// ---------------------------------------------------------------------------
// Permissions and isolation (F1.5, F1.6)
// ---------------------------------------------------------------------------

describe('configuration needs its own permission (F1.5)', () => {
  async function memberWith(permissions: string[]): Promise<TestClient> {
    const owner = await signUpOwner(app, { email: 'owner@example.com' });
    const member = await (async () => {
      const invite = await owner
        .post('/api/members/invites', { email: 'member@example.com', baseLevel: 'user' })
        .expect(201);
      await request(app)
        .post('/api/members/invites/accept')
        .send({ token: invite.body.token, name: 'Member', password: TEST_PASSWORD })
        .expect(204);
      return signIn(app, 'member@example.com');
    })();

    await owner
      .patch(`/api/members/${member.membershipId}/permissions`, {
        permissionSetIds: [],
        extraPermissions: permissions,
      })
      .expect(204);

    return signIn(app, 'member@example.com');
  }

  it('lets a member who may edit records move a stage, but not redefine one', async () => {
    const member = await memberWith([
      PERMISSIONS.CRM_VIEW,
      PERMISSIONS.CRM_CREATE,
      PERMISSIONS.CRM_EDIT,
    ]);

    const pipeline = await defaultPipeline(member);

    // Editing records: allowed.
    const contactId = await makeContact(member);
    const opportunity = await member
      .post('/api/opportunities', { name: 'Roof', contactId })
      .expect(201);
    await member
      .patch(`/api/opportunities/${opportunity.body.id}/stage`, {
        stageId: pipeline.stages[1]!.id,
        version: opportunity.body.version,
      })
      .expect(200);

    // Redefining the pipeline they move through: refused.
    await member.post(`/api/pipelines/${pipeline.id}/stages`, { name: 'Sneaky' }).expect(403);
    await member
      .patch(`/api/pipelines/${pipeline.id}/stages/${pipeline.stages[0]!.id}`, { name: 'Nope' })
      .expect(403);
    await member
      .delete(`/api/pipelines/${pipeline.id}/stages/${pipeline.stages[0]!.id}`)
      .expect(403);
    await member
      .post('/api/custom-fields', { entity: 'contact', key: 'x', label: 'X', type: 'text' })
      .expect(403);
  });

  it('refuses reading pipelines without crm.record.view', async () => {
    const member = await memberWith([]);

    await member.get('/api/pipelines').expect(403);
    await member.get('/api/custom-fields?entity=contact').expect(403);
  });

  it('refuses an anonymous caller', async () => {
    await request(app).get('/api/pipelines').expect(401);
    await request(app).post('/api/custom-fields').send({}).expect(401);
  });
});

describe('pipeline workspace isolation (F1.6)', () => {
  it('returns 404 for another workspace pipeline', async () => {
    const first = await signUpOwner(app, { email: 'a@example.com' });
    const second = await signUpOwner(app, { email: 'b@example.com' });

    const theirs = await defaultPipeline(second);

    await first.get(`/api/pipelines/${theirs.id}`).expect(404);
    await first.post(`/api/pipelines/${theirs.id}/stages`, { name: 'Mine' }).expect(404);
    await first.patch(`/api/pipelines/${theirs.id}/stage-order`, { stageIds: ['x'] }).expect(404);
  });

  it('lists only its own pipelines', async () => {
    const first = await signUpOwner(app, { email: 'a@example.com' });
    const second = await signUpOwner(app, { email: 'b@example.com' });

    await second.post('/api/pipelines', { name: 'Theirs' }).expect(201);

    const list = await first.get('/api/pipelines').expect(200);

    expect(list.body.pipelines.map((pipeline: { name: string }) => pipeline.name)).toEqual([
      'Sales',
    ]);
  });

  it('refuses attaching an opportunity to another workspace contact', async () => {
    const first = await signUpOwner(app, { email: 'a@example.com' });
    const second = await signUpOwner(app, { email: 'b@example.com' });

    const theirContact = await makeContact(second, 'Theirs');

    await first.post('/api/opportunities', { name: 'Roof', contactId: theirContact }).expect(404);
  });

  it('shows only its own custom fields', async () => {
    const first = await signUpOwner(app, { email: 'a@example.com' });
    const second = await signUpOwner(app, { email: 'b@example.com' });

    await second
      .post('/api/custom-fields', {
        entity: 'contact',
        key: 'secret',
        label: 'Secret',
        type: 'text',
      })
      .expect(201);

    const schema = await first.get('/api/custom-fields?entity=contact').expect(200);

    expect(schema.body.customFields).toEqual([]);
  });
});
