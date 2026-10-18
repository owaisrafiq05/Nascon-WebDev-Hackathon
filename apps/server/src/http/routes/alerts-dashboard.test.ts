import type { Express } from 'express';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { LeadModel } from '../../db/models/lead.js';
import { NotificationModel } from '../../db/models/notification.js';
import { ScheduledJobModel } from '../../db/models/scheduled-job.js';
import { ProviderError } from '../../integrations/http.js';
import { resetProviders } from '../../integrations/registry.js';
import { runDueJobs } from '../../services/job-runner.js';
import { escalateLead } from '../../services/lead-service.js';
import { addMember, installFakes, TELEGRAM_CREDENTIALS, type FakeState } from '../../test/fakes.js';
import {
  createTestApp,
  resetDatabase,
  signUpOwner,
  startTestDatabase,
  stopTestDatabase,
  testConfig,
  type TestClient,
} from '../../test/harness.js';

let app: Express;
let fakes: FakeState;
const config = testConfig();

beforeAll(async () => {
  await startTestDatabase();
  app = createTestApp(config);
}, 180_000);

afterAll(async () => {
  resetProviders();
  await stopTestDatabase();
});

beforeEach(() => {
  fakes = installFakes();
});

afterEach(async () => {
  await resetDatabase();
});

async function team(): Promise<{ owner: TestClient; rep: TestClient }> {
  const owner = await signUpOwner(app);
  const rep = await addMember(app, owner, `rep-${Date.now().toString(36)}@example.com`);
  for (const member of [owner, rep]) {
    await owner
      .patch(`/api/availability/${member.membershipId}`, { status: 'available' })
      .expect(200);
  }
  return { owner, rep };
}

/** Creates a lead and forces its window to expire, escalating it once. */
async function escalatedLead(owner: TestClient): Promise<string> {
  const created = await owner
    .post('/api/leads', { firstName: 'Esc', sourceLabel: 'Website form' })
    .expect(201);
  const lead = await LeadModel.findById(created.body.leadId).lean();
  const outcome = await escalateLead(lead!._id, lead!.version, new Date(Date.now() + 3_600_000));
  expect(outcome.escalated).toBe(true);
  return created.body.leadId as string;
}

describe('escalation alerts (F3.9, I4.1 - I4.4)', () => {
  it('alerts the new owner on Telegram with the lead, source, reason and a link', async () => {
    const { owner, rep } = await team();
    await owner.put('/api/integrations/telegram', TELEGRAM_CREDENTIALS).expect(200);
    for (const member of [owner, rep]) {
      await member
        .put('/api/me/notification-settings', {
          telegramChatId: '1000' + member.membershipId.slice(-4).replace(/\D/g, '1'),
        })
        .expect(200);
    }

    const leadId = await escalatedLead(owner);
    // The alert is owed in the escalation transaction.
    expect(await NotificationModel.countDocuments()).toBe(1);

    await runDueJobs({ integrations: config.integrations, types: ['notification.send'] });
    expect(fakes.alerts).toHaveLength(1);
    const text = fakes.alerts[0]?.text ?? '';
    expect(text).toContain('Lead escalated to you: Esc');
    expect(text).toContain('Source: Website form');
    expect(text).toContain('not acknowledged within the window');
    expect(text).toContain(`http://localhost:5173/leads?lead=${leadId}`);
    expect((await NotificationModel.findOne({}).lean())?.status).toBe('sent');
  });

  it('retries a failed alert a limited number of times, then shows it failed to Admins (I4.4)', async () => {
    const { owner, rep } = await team();
    await owner.put('/api/integrations/telegram', TELEGRAM_CREDENTIALS).expect(200);
    await owner.put('/api/me/notification-settings', { telegramChatId: '111' }).expect(200);
    await rep.put('/api/me/notification-settings', { telegramChatId: '222' }).expect(200);
    await escalatedLead(owner);

    fakes.failAlert = new ProviderError('Forbidden: bot was blocked by the user', {
      transient: false,
      status: 403,
    });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await runDueJobs({
        integrations: config.integrations,
        types: ['notification.send'],
        now: new Date(Date.now() + (attempt + 1) * 60_000),
      });
    }

    const notification = await NotificationModel.findOne({}).lean();
    expect(notification).toMatchObject({ status: 'failed', attempts: 3 });
    expect(notification?.lastError).toContain('blocked');
    expect((await ScheduledJobModel.findOne({ type: 'notification.send' }).lean())?.status).toBe(
      'failed',
    );

    const listed = await owner.get('/api/notifications?status=failed').expect(200);
    expect(listed.body.items).toHaveLength(1);
    await rep.get('/api/notifications').expect(403);
  });

  it('skips, with the reason, an employee who set no chat id', async () => {
    const { owner } = await team();
    await owner.put('/api/integrations/telegram', TELEGRAM_CREDENTIALS).expect(200);
    await escalatedLead(owner);
    await runDueJobs({ integrations: config.integrations, types: ['notification.send'] });
    const notification = await NotificationModel.findOne({}).lean();
    expect(notification).toMatchObject({ status: 'skipped' });
    expect(fakes.alerts).toHaveLength(0);
  });

  it('lets each employee set and test their own destination (I4.3)', async () => {
    const { owner } = await team();
    await owner.put('/api/integrations/telegram', TELEGRAM_CREDENTIALS).expect(200);
    const saved = await owner
      .put('/api/me/notification-settings', { telegramChatId: '424242' })
      .expect(200);
    expect(saved.body).toEqual({
      telegramChatId: '424242',
      telegramConnected: true,
      botUsername: 'ubmp_test_bot',
    });
    await owner
      .put('/api/me/notification-settings', { telegramChatId: 'not-a-number' })
      .expect(422);
    await owner.post('/api/me/notification-settings/test').expect(200);
    expect(fakes.alerts[0]?.chatId).toBe('424242');
  });
});

describe('dashboard (F5.1 - F5.5)', () => {
  it('shows every required figure, and new leads match the drill-down list (F5.2, F5.3)', async () => {
    const { owner } = await team();
    for (const name of ['A', 'B', 'C']) {
      await owner.post('/api/leads', { firstName: name }).expect(201);
    }

    const dashboard = await owner.get('/api/dashboard?range=today&tz=UTC').expect(200);
    expect(dashboard.body.scope).toBe('company');
    expect(dashboard.body.tiles.map((tile: { id: string }) => tile.id)).toEqual([
      'new_leads',
      'open_pipeline_value',
      'avg_first_response',
      'recovery_queue',
      'escalations_24h',
      'availability',
      'upcoming_appointments',
      'payments_this_month',
    ]);

    const newLeads = dashboard.body.tiles[0];
    expect(newLeads.value).toBe(3);
    const query = new URLSearchParams(newLeads.drillDown.query).toString();
    const list = await owner.get(`/api/leads?${query}`).expect(200);
    expect(list.body.pageInfo.total).toBe(newLeads.value);

    const availability = dashboard.body.tiles.find(
      (tile: { id: string }) => tile.id === 'availability',
    );
    expect(availability.detail).toMatchObject({ available: 2 });
  });

  it('gives a User personal figures and an Owner company-wide ones (F5.4)', async () => {
    const { owner, rep } = await team();
    for (let index = 0; index < 4; index += 1) {
      await owner.post('/api/leads', { firstName: `L${String(index)}` }).expect(201);
    }
    const mine = await LeadModel.countDocuments({ assigneeMembershipId: rep.membershipId });

    const personal = await rep.get('/api/dashboard?range=today').expect(200);
    expect(personal.body.scope).toBe('personal');
    expect(personal.body.tiles[0].value).toBe(mine);
    expect(personal.body.tiles[0].drillDown.query.mine).toBe('true');

    const company = await owner.get('/api/dashboard?range=today').expect(200);
    expect(company.body.tiles[0].value).toBe(4);
  });

  it('counts automatic escalations separately from manual reassignments', async () => {
    const { owner, rep } = await team();
    await escalatedLead(owner);
    const another = await owner.post('/api/leads', { firstName: 'Manual' }).expect(201);
    await owner
      .post(`/api/leads/${another.body.leadId}/reassign`, { toMembershipId: rep.membershipId })
      .expect(200);

    const dashboard = await owner.get('/api/dashboard').expect(200);
    const tile = dashboard.body.tiles.find(
      (entry: { id: string }) => entry.id === 'escalations_24h',
    );
    expect(tile.value).toBe(1);
    expect(tile.detail.manualReassignments).toBe(1);
  });

  it('measures time to first response from first assignment to first acknowledgement', async () => {
    const { owner, rep } = await team();
    const created = await owner.post('/api/leads', { firstName: 'Fast' }).expect(201);
    const lead = await LeadModel.findById(created.body.leadId).lean();
    if (lead === null) throw new Error('lead missing');
    await LeadModel.updateOne(
      { _id: lead._id },
      { $set: { firstAssignedAt: new Date(Date.now() - 90_000) } },
    );
    const client = lead.assigneeMembershipId?.toString() === owner.membershipId ? owner : rep;
    await client.post(`/api/leads/${created.body.leadId}/acknowledge`).expect(200);

    const dashboard = await owner.get('/api/dashboard').expect(200);
    const tile = dashboard.body.tiles.find(
      (entry: { id: string }) => entry.id === 'avg_first_response',
    );
    expect(tile.value).toBeGreaterThanOrEqual(90_000);
    expect(tile.display).toMatch(/^1m 3\ds$/);
  });

  it('remembers hidden tiles on the server (F5.5)', async () => {
    const owner = await signUpOwner(app);
    await owner
      .put('/api/dashboard/preferences', {
        hiddenTiles: ['new_leads', 'new_leads', 'availability'],
      })
      .expect(200);
    const dashboard = await owner.get('/api/dashboard').expect(200);
    expect(dashboard.body.hiddenTiles).toEqual(['new_leads', 'availability']);
    await owner.put('/api/dashboard/preferences', { hiddenTiles: ['not_a_tile'] }).expect(422);
  });

  it('rejects an unknown time zone', async () => {
    const owner = await signUpOwner(app);
    await owner.get('/api/dashboard?tz=Nowhere/City').expect(422);
  });
});
