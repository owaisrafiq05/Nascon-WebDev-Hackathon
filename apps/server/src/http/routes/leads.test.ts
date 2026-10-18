import type { Express } from 'express';
import { Types } from 'mongoose';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { LeadModel } from '../../db/models/lead.js';
import { MembershipModel } from '../../db/models/membership.js';
import { OutboxEventModel } from '../../db/models/outbox-event.js';
import { ScheduledJobModel } from '../../db/models/scheduled-job.js';
import { claimDueJob, escalationKey, scheduleJob } from '../../repositories/job-queue.js';
import { claimAndRunOne, runJob } from '../../services/job-runner.js';
import { escalateLead } from '../../services/lead-service.js';
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
  baseLevel: 'admin' | 'user' = 'user',
): Promise<TestClient> {
  const invite = await owner.post('/api/members/invites', { email, baseLevel }).expect(201);
  await request(app)
    .post('/api/members/invites/accept')
    .send({ token: invite.body.token, name: email, password: TEST_PASSWORD })
    .expect(204);
  return signIn(app, email);
}

/** Everyone must be Available for the engine to consider them (F3.3). */
async function makeAvailable(client: TestClient, ...members: TestClient[]): Promise<void> {
  for (const member of [client, ...members]) {
    await client
      .patch(`/api/availability/${member.membershipId}`, { status: 'available' })
      .expect(200);
  }
}

async function createForm(owner: TestClient, name = 'Website enquiry'): Promise<string> {
  const response = await owner.post('/api/lead-forms', { name }).expect(201);
  return response.body.id as string;
}

// ---------------------------------------------------------------------------
// The public form (F3.1)
// ---------------------------------------------------------------------------

describe('POST /api/public/forms/:formId/leads (F3.1)', () => {
  it('captures a lead, creates the contact and labels the source', async () => {
    const owner = await signUpOwner(app);
    const formId = await createForm(owner, 'Website enquiry');

    await request(app)
      .post(`/api/public/forms/${formId}/leads`)
      .send({ firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.com' })
      .expect(202);

    const leads = await owner.get('/api/leads').expect(200);
    expect(leads.body.items).toHaveLength(1);
    expect(leads.body.items[0].source).toBe('web_form');
    expect(leads.body.items[0].sourceLabel).toBe('Website enquiry');

    // The person became a contact (I1.5).
    const contacts = await owner.get('/api/contacts').expect(200);
    expect(contacts.body.items[0].firstName).toBe('Ada');
  });

  it('needs no session or CSRF token, being a form on a public website', async () => {
    const owner = await signUpOwner(app);
    const formId = await createForm(owner);

    await request(app)
      .post(`/api/public/forms/${formId}/leads`)
      .send({ firstName: 'Anonymous' })
      .expect(202);
  });

  it('rejects invalid input (Q3)', async () => {
    const owner = await signUpOwner(app);
    const formId = await createForm(owner);

    await request(app).post(`/api/public/forms/${formId}/leads`).send({}).expect(422);
    await request(app)
      .post(`/api/public/forms/${formId}/leads`)
      .send({ firstName: 'Ada', email: 'not-an-email' })
      .expect(422);
  });

  it('answers 404 the same way for an unknown and a malformed form id', async () => {
    await request(app)
      .post('/api/public/forms/0123456789abcdef01234567/leads')
      .send({ firstName: 'Ada' })
      .expect(404);

    await request(app)
      .post('/api/public/forms/not-an-id/leads')
      .send({ firstName: 'Ada' })
      .expect(404);
  });

  it('swallows a honeypot submission without telling the bot', async () => {
    const owner = await signUpOwner(app);
    const formId = await createForm(owner);

    // Accepted, so a scraper cannot tell the field is a trap.
    await request(app)
      .post(`/api/public/forms/${formId}/leads`)
      .send({ firstName: 'Bot', _honey: 'filled in' })
      .expect(202);

    expect(await LeadModel.countDocuments()).toBe(0);
  });

  it('rate-limits spam from one address', async () => {
    const limited = createTestApp(
      (await import('../../test/harness.js')).testConfig({
        publicFormRateLimit: { max: 3, windowMs: 10 * 60 * 1_000 },
      }),
    );
    const owner = await signUpOwner(limited);
    const formId = await createForm(owner);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await request(limited)
        .post(`/api/public/forms/${formId}/leads`)
        .send({ firstName: `Spam${String(attempt)}` })
        .expect(202);
    }

    const blocked = await request(limited)
      .post(`/api/public/forms/${formId}/leads`)
      .send({ firstName: 'Spam4' })
      .expect(429);

    expect(blocked.body.error.code).toBe('RATE_LIMITED');
    expect(await LeadModel.countDocuments()).toBe(3);
  });

  it('creating a form needs the configuration permission', async () => {
    const owner = await signUpOwner(app, { email: 'owner@example.com' });
    const member = await addMember(owner, 'member@example.com');

    await member.post('/api/lead-forms', { name: 'Sneaky' }).expect(403);
  });
});

// ---------------------------------------------------------------------------
// Round-robin fairness (F3.3)
// ---------------------------------------------------------------------------

describe('round-robin assignment (F3.3)', () => {
  it('distributes fairly across three available employees', async () => {
    const owner = await signUpOwner(app, { email: 'owner@example.com' });
    const first = await addMember(owner, 'one@example.com');
    const second = await addMember(owner, 'two@example.com');

    // A high limit, so capacity is not what spreads them.
    await owner.patch('/api/assignment-rules', { maxOpenLeadsPerEmployee: 50 }).expect(200);
    await makeAvailable(owner, first, second);

    const formId = await createForm(owner);
    for (let index = 0; index < 9; index += 1) {
      await request(app)
        .post(`/api/public/forms/${formId}/leads`)
        .send({ firstName: `Lead${String(index)}` })
        .expect(202);
    }

    const leads = await LeadModel.find({}).lean();
    const counts = new Map<string, number>();
    for (const lead of leads) {
      const id = lead.assigneeMembershipId?.toString() ?? 'unassigned';
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }

    // Three employees, nine leads: three each.
    expect(leads).toHaveLength(9);
    expect([...counts.values()].sort()).toEqual([3, 3, 3]);
    expect(counts.has('unassigned')).toBe(false);
  });

  it('never assigns to an employee who is not Available (F3.3)', async () => {
    const owner = await signUpOwner(app, { email: 'owner@example.com' });
    const busy = await addMember(owner, 'busy@example.com');

    await makeAvailable(owner);
    await owner.patch(`/api/availability/${busy.membershipId}`, { status: 'busy' }).expect(200);

    const formId = await createForm(owner);
    for (let index = 0; index < 4; index += 1) {
      await request(app)
        .post(`/api/public/forms/${formId}/leads`)
        .send({ firstName: `L${String(index)}` })
        .expect(202);
    }

    const toBusy = await LeadModel.countDocuments({
      assigneeMembershipId: new Types.ObjectId(busy.membershipId),
    });
    expect(toBusy).toBe(0);
  });

  it('respects the max open leads limit', async () => {
    const owner = await signUpOwner(app, { email: 'owner@example.com' });
    await makeAvailable(owner);
    await owner.patch('/api/assignment-rules', { maxOpenLeadsPerEmployee: 2 }).expect(200);

    const formId = await createForm(owner);
    for (let index = 0; index < 4; index += 1) {
      await request(app)
        .post(`/api/public/forms/${formId}/leads`)
        .send({ firstName: `L${String(index)}` })
        .expect(202);
    }

    // Two assigned, two left unassigned rather than piled on one person.
    expect(await LeadModel.countDocuments({ assigneeMembershipId: { $ne: null } })).toBe(2);
    expect(await LeadModel.countDocuments({ assigneeMembershipId: null })).toBe(2);
  });

  it('still captures a lead nobody can take, with the reason (F3.1)', async () => {
    const owner = await signUpOwner(app);
    await owner.patch(`/api/availability/${owner.membershipId}`, { status: 'offline' }).expect(200);

    const response = await owner
      .post('/api/leads', { firstName: 'Nobody', sourceLabel: 'Phone' })
      .expect(201);

    // Losing the enquiry is the failure the platform exists to prevent.
    expect(response.body.assigneeMembershipId).toBeNull();
    expect(response.body.unassignedReason.code).toBe('none_available');
    expect(response.body.unassignedReason.message).toBe('Nobody is Available right now.');
  });
});

// ---------------------------------------------------------------------------
// Absence (F3.6)
// ---------------------------------------------------------------------------

describe('absence reassigns unacknowledged leads immediately (F3.6)', () => {
  it('moves an unacknowledged lead off an employee going Offline', async () => {
    const owner = await signUpOwner(app, { email: 'owner@example.com' });
    const other = await addMember(owner, 'other@example.com');
    await makeAvailable(owner, other);

    // Only the owner is available, so the lead lands on them.
    await owner.patch(`/api/availability/${other.membershipId}`, { status: 'busy' }).expect(200);
    const created = await owner.post('/api/leads', { firstName: 'Ada' }).expect(201);
    expect(created.body.assigneeMembershipId).toBe(owner.membershipId);

    // The other becomes available, then the owner goes offline.
    await owner
      .patch(`/api/availability/${other.membershipId}`, { status: 'available' })
      .expect(200);
    const result = await owner
      .patch(`/api/availability/${owner.membershipId}`, { status: 'offline' })
      .expect(200);

    expect(result.body.reassignedLeadIds).toHaveLength(1);

    const lead = await LeadModel.findById(created.body.leadId).lean();
    expect(lead?.assigneeMembershipId?.toString()).toBe(other.membershipId);
  });

  it('leaves an acknowledged lead with its owner and flags it instead (F3.6)', async () => {
    const owner = await signUpOwner(app, { email: 'owner@example.com' });
    const other = await addMember(owner, 'other@example.com');
    await makeAvailable(owner, other);
    await owner.patch(`/api/availability/${other.membershipId}`, { status: 'busy' }).expect(200);

    const created = await owner.post('/api/leads', { firstName: 'Ada' }).expect(201);
    await owner.post(`/api/leads/${created.body.leadId}/acknowledge`).expect(200);

    await owner
      .patch(`/api/availability/${other.membershipId}`, { status: 'available' })
      .expect(200);
    const result = await owner
      .patch(`/api/availability/${owner.membershipId}`, { status: 'on_leave' })
      .expect(200);

    // The defined treatment: kept with its accountable owner, flagged visibly.
    expect(result.body.reassignedLeadIds).toHaveLength(0);
    expect(result.body.flaggedLeadIds).toHaveLength(1);

    const lead = await LeadModel.findById(created.body.leadId).lean();
    expect(lead?.assigneeMembershipId?.toString()).toBe(owner.membershipId);
    expect(lead?.ownerUnavailable).toBe(true);
  });

  it('does nothing to leads when going Busy, which is not absence', async () => {
    const owner = await signUpOwner(app);
    await makeAvailable(owner);
    await owner.post('/api/leads', { firstName: 'Ada' }).expect(201);

    const result = await owner
      .patch(`/api/availability/${owner.membershipId}`, { status: 'busy' })
      .expect(200);

    expect(result.body.reassignedLeadIds).toHaveLength(0);
    expect(result.body.flaggedLeadIds).toHaveLength(0);
  });

  it('lets an employee set their own status but not a colleague (F3.2)', async () => {
    const owner = await signUpOwner(app, { email: 'owner@example.com' });
    const member = await addMember(owner, 'member@example.com');

    await member.patch(`/api/availability/${member.membershipId}`, { status: 'busy' }).expect(200);

    const refused = await member
      .patch(`/api/availability/${owner.membershipId}`, { status: 'offline' })
      .expect(403);
    expect(refused.body.error.message).toContain('only change your own');
  });

  it('lets an Admin set someone else availability', async () => {
    const owner = await signUpOwner(app, { email: 'owner@example.com' });
    const member = await addMember(owner, 'member@example.com');

    await owner
      .patch(`/api/availability/${member.membershipId}`, { status: 'on_leave' })
      .expect(200);

    const membership = await MembershipModel.findById(member.membershipId).lean();
    expect(membership?.availabilityStatus).toBe('on_leave');
  });
});

// ---------------------------------------------------------------------------
// Acknowledgement and escalation (F3.4, F3.5, F3.8)
// ---------------------------------------------------------------------------

describe('escalation (F3.5, F3.8)', () => {
  /** A workspace with a short window, as a demo uses. */
  async function setUp(): Promise<{
    owner: TestClient;
    next: TestClient;
    leadId: string;
  }> {
    const owner = await signUpOwner(app, { email: 'owner@example.com' });
    const next = await addMember(owner, 'next@example.com');
    await makeAvailable(owner, next);

    await owner
      .patch('/api/assignment-rules', {
        acknowledgementWindowSeconds: 15,
        maxOpenLeadsPerEmployee: 50,
        escalationLevels: [
          { target: 'next_eligible', windowSeconds: 15 },
          { target: 'manager', windowSeconds: 15 },
        ],
      })
      .expect(200);

    // Only the owner is eligible at capture time.
    await owner.patch(`/api/availability/${next.membershipId}`, { status: 'busy' }).expect(200);
    const created = await owner.post('/api/leads', { firstName: 'Ada' }).expect(201);
    expect(created.body.assigneeMembershipId).toBe(owner.membershipId);
    await owner
      .patch(`/api/availability/${next.membershipId}`, { status: 'available' })
      .expect(200);

    return { owner, next, leadId: created.body.leadId as string };
  }

  it('schedules the acknowledgement window when a lead is assigned (F3.4)', async () => {
    const { leadId } = await setUp();

    const job = await ScheduledJobModel.findOne({ targetId: new Types.ObjectId(leadId) }).lean();
    expect(job?.type).toBe('lead.escalate');
    expect(job?.idempotencyKey).toBe(escalationKey(leadId, 0, 0));
  });

  it('does not escalate before the window expires', async () => {
    const { leadId } = await setUp();

    const outcome = await escalateLead(new Types.ObjectId(leadId), 0, new Date());

    expect(outcome).toEqual({ escalated: false, reason: 'window_not_expired' });
  });

  it('escalates to the next eligible employee once the window expires', async () => {
    const { owner, next, leadId } = await setUp();

    // 16s later: the 15s window has passed.
    const later = new Date(Date.now() + 16_000);
    const outcome = await escalateLead(new Types.ObjectId(leadId), 0, later);

    expect(outcome.escalated).toBe(true);

    const lead = await LeadModel.findById(leadId).lean();
    expect(lead?.assignmentStatus).toBe('escalated');
    expect(lead?.escalationLevel).toBe(1);
    expect(lead?.escalationCount).toBe(1);
    // Moved off the person who let it expire (F3.5).
    expect(lead?.assigneeMembershipId?.toString()).toBe(next.membershipId);
    expect(lead?.assigneeMembershipId?.toString()).not.toBe(owner.membershipId);
  });

  it('escalates exactly once when the same job runs twice (F3.8)', async () => {
    const { leadId } = await setUp();
    const later = new Date(Date.now() + 16_000);

    const first = await escalateLead(new Types.ObjectId(leadId), 0, later);
    const second = await escalateLead(new Types.ObjectId(leadId), 0, later);

    expect(first.escalated).toBe(true);
    // The version moved, so the second call describes a state that is gone.
    expect(second).toEqual({ escalated: false, reason: 'version_changed' });

    const lead = await LeadModel.findById(leadId).lean();
    expect(lead?.escalationCount).toBe(1);
  });

  it('runs the same scheduled job twice with the second a no-op', async () => {
    const { leadId } = await setUp();
    const later = new Date(Date.now() + 16_000);

    const job = await ScheduledJobModel.findOne({ targetId: new Types.ObjectId(leadId) }).lean();
    expect(job).not.toBeNull();

    const first = await runJob(job!, later);
    const second = await runJob(job!, later);

    expect((first.outcome as { escalated: boolean }).escalated).toBe(true);
    expect((second.outcome as { escalated: boolean }).escalated).toBe(false);

    const lead = await LeadModel.findById(leadId).lean();
    expect(lead?.escalationCount).toBe(1);
  });

  it('refuses a duplicate schedule for the same state, so it cannot double-escalate', async () => {
    const { leadId } = await setUp();
    const lead = await LeadModel.findById(leadId).lean();

    const duplicate = await scheduleJob({
      workspaceId: lead!.workspaceId,
      type: 'lead.escalate',
      targetId: new Types.ObjectId(leadId),
      runAt: new Date(),
      idempotencyKey: escalationKey(leadId, 0, 0),
    });

    expect(duplicate.scheduled).toBe(false);
    expect(await ScheduledJobModel.countDocuments({ targetId: new Types.ObjectId(leadId) })).toBe(
      1,
    );
  });

  it('acknowledging before expiry stops escalation (F3.4)', async () => {
    const { owner, leadId } = await setUp();

    await owner.post(`/api/leads/${leadId}/acknowledge`).expect(200);

    const later = new Date(Date.now() + 60_000);
    const outcome = await escalateLead(new Types.ObjectId(leadId), 1, later);

    expect(outcome).toEqual({ escalated: false, reason: 'already_settled' });

    const lead = await LeadModel.findById(leadId).lean();
    expect(lead?.escalationCount).toBe(0);
    expect(lead?.acknowledgedAt).not.toBeNull();
  });

  it('cancels the outstanding timer when acknowledged', async () => {
    const { owner, leadId } = await setUp();

    await owner.post(`/api/leads/${leadId}/acknowledge`).expect(200);

    const pending = await ScheduledJobModel.countDocuments({
      targetId: new Types.ObjectId(leadId),
      status: { $in: ['pending', 'running'] },
    });
    expect(pending).toBe(0);
  });

  it('walks the whole chain, one level per expiry, never skipping', async () => {
    const { leadId } = await setUp();

    // Far in the future: it must still advance one level per call.
    const far = new Date(Date.now() + 600_000);

    const first = await escalateLead(new Types.ObjectId(leadId), 0, far);
    expect(first.escalated).toBe(true);
    expect((await LeadModel.findById(leadId).lean())?.escalationLevel).toBe(1);

    const second = await escalateLead(new Types.ObjectId(leadId), 1, far);
    expect(second.escalated).toBe(true);
    expect((await LeadModel.findById(leadId).lean())?.escalationLevel).toBe(2);

    // Last level: nowhere further to go, so it stays and the recovery queue
    // surfaces it (F3.7).
    const third = await escalateLead(new Types.ObjectId(leadId), 2, far);
    expect(third).toEqual({ escalated: false, reason: 'no_further_level' });
  });

  it('writes an outbox event for P5 to relay', async () => {
    const { leadId } = await setUp();
    await escalateLead(new Types.ObjectId(leadId), 0, new Date(Date.now() + 16_000));

    const event = await OutboxEventModel.findOne({ type: 'lead.escalated' }).lean();

    expect(event).not.toBeNull();
    expect(event?.payload['leadId']).toBe(leadId);
    // Minimal payload: ids and a reason, nothing a reader might not see.
    expect(event?.payload['reason']).toBe('acknowledgement window expired');
  });
});

// ---------------------------------------------------------------------------
// Job claiming: two workers, and crash recovery (Q5)
// ---------------------------------------------------------------------------

describe('scheduled job claiming (Q5, F3.8)', () => {
  async function dueJob(): Promise<{ leadId: string; jobId: Types.ObjectId }> {
    const owner = await signUpOwner(app, { email: 'owner@example.com' });
    await addMember(owner, 'next@example.com');
    await makeAvailable(owner);

    await owner.patch('/api/assignment-rules', { acknowledgementWindowSeconds: 5 }).expect(200);
    const created = await owner.post('/api/leads', { firstName: 'Ada' }).expect(201);

    // Make it due now.
    const job = await ScheduledJobModel.findOneAndUpdate(
      { targetId: new Types.ObjectId(created.body.leadId) },
      { $set: { runAt: new Date(Date.now() - 1_000) } },
      { new: true },
    ).lean();

    return { leadId: created.body.leadId as string, jobId: job!._id };
  }

  it('lets only one of two concurrent claimers take a job', async () => {
    const { jobId } = await dueJob();

    // Both race for the same job.
    const [first, second] = await Promise.all([
      claimDueJob({ claimerId: 'worker-a' }),
      claimDueJob({ claimerId: 'worker-b' }),
    ]);

    const claimed = [first, second].filter((job) => job !== null);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?._id.toString()).toBe(jobId.toString());
  });

  it('lets only one of two concurrent runners escalate', async () => {
    const { leadId } = await dueJob();

    const [first, second] = await Promise.all([
      claimAndRunOne({ claimerId: 'worker-a' }),
      claimAndRunOne({ claimerId: 'worker-b' }),
    ]);

    const ran = [first, second].filter((result) => result !== null);
    expect(ran).toHaveLength(1);

    const lead = await LeadModel.findById(leadId).lean();
    // One escalation at most, never two.
    expect(lead?.escalationCount).toBeLessThanOrEqual(1);
  });

  it('does not hand a locked job to a second claimer', async () => {
    await dueJob();

    const first = await claimDueJob({ claimerId: 'worker-a', leaseMs: 60_000 });
    expect(first).not.toBeNull();

    const second = await claimDueJob({ claimerId: 'worker-b' });
    expect(second).toBeNull();
  });

  it('re-claims a job whose claimer died, and finishes it exactly once (Q5)', async () => {
    const { leadId, jobId } = await dueJob();

    // Claimer A takes it and never finishes: a crash.
    const claimed = await claimDueJob({ claimerId: 'worker-a', leaseMs: 1_000 });
    expect(claimed?._id.toString()).toBe(jobId.toString());

    // While the lease holds, nobody else can take it.
    expect(await claimDueJob({ claimerId: 'worker-b' })).toBeNull();

    // The lease expires.
    const afterLease = new Date(Date.now() + 5_000);
    const reclaimed = await claimDueJob({ claimerId: 'worker-b', now: afterLease });
    expect(reclaimed?._id.toString()).toBe(jobId.toString());
    expect(reclaimed?.lockedBy).toBe('worker-b');

    // Worker B finishes it.
    await runJob(reclaimed!, new Date(Date.now() + 20_000));

    const lead = await LeadModel.findById(leadId).lean();
    expect(lead?.escalationCount).toBe(1);

    // And it is not runnable again.
    expect(await claimDueJob({ claimerId: 'worker-c', now: afterLease })).toBeNull();
  });

  it('claims the oldest due job first, so none is starved', async () => {
    const owner = await signUpOwner(app);
    await makeAvailable(owner);
    const lead = await owner.post('/api/leads', { firstName: 'Ada' }).expect(201);
    const doc = await LeadModel.findById(lead.body.leadId).lean();

    await scheduleJob({
      workspaceId: doc!.workspaceId,
      type: 'lead.escalate',
      targetId: doc!._id,
      runAt: new Date(Date.now() - 60_000),
      idempotencyKey: 'old-job',
    });
    await scheduleJob({
      workspaceId: doc!.workspaceId,
      type: 'lead.escalate',
      targetId: doc!._id,
      runAt: new Date(Date.now() - 1_000),
      idempotencyKey: 'new-job',
    });

    const claimed = await claimDueJob({});
    expect(claimed?.idempotencyKey).toBe('old-job');
  });

  it('does not claim a job that is not due yet', async () => {
    const owner = await signUpOwner(app);
    await makeAvailable(owner);
    await owner.post('/api/leads', { firstName: 'Ada' }).expect(201);

    // The window has not passed.
    expect(await claimDueJob({})).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Recovery queue (F3.7)
// ---------------------------------------------------------------------------

describe('the recovery queue (F3.7)', () => {
  it('lists a lead unacknowledged beyond its window, with the reason', async () => {
    const owner = await signUpOwner(app);
    await makeAvailable(owner);
    await owner.patch('/api/assignment-rules', { acknowledgementWindowSeconds: 5 }).expect(200);

    const created = await owner.post('/api/leads', { firstName: 'Ada' }).expect(201);

    // Backdate the window so it has expired.
    await LeadModel.updateOne(
      { _id: new Types.ObjectId(created.body.leadId) },
      { $set: { windowStartedAt: new Date(Date.now() - 60_000) } },
    );

    const queue = await owner.get('/api/recovery-queue').expect(200);

    expect(queue.body.total).toBe(1);
    expect(queue.body.items[0].reasons).toContain('unacknowledged_beyond_window');
    // In words, never a bare code.
    expect(queue.body.items[0].reasonLabels).toContain('Not acknowledged within its window');
  });

  it('lists a lead escalated twice or more', async () => {
    const owner = await signUpOwner(app);
    await makeAvailable(owner);
    const created = await owner.post('/api/leads', { firstName: 'Ada' }).expect(201);

    await LeadModel.updateOne(
      { _id: new Types.ObjectId(created.body.leadId) },
      { $set: { escalationCount: 2, windowStartedAt: new Date() } },
    );

    const queue = await owner.get('/api/recovery-queue').expect(200);
    expect(queue.body.items[0].reasons).toContain('escalated_repeatedly');
  });

  it('lists a lead with no recorded action for the idle period', async () => {
    const owner = await signUpOwner(app);
    await makeAvailable(owner);
    await owner.patch('/api/assignment-rules', { idleRecoveryMinutes: 1 }).expect(200);

    const created = await owner.post('/api/leads', { firstName: 'Ada' }).expect(201);

    // Last recorded action ten minutes ago, against a one-minute idle period.
    // `lastActivityAt` rather than `createdAt`, because Mongoose's timestamps
    // option owns `createdAt` and ignores an attempt to set it on update.
    await LeadModel.updateOne(
      { _id: new Types.ObjectId(created.body.leadId) },
      { $set: { lastActivityAt: new Date(Date.now() - 600_000), windowStartedAt: new Date() } },
    );

    const queue = await owner.get('/api/recovery-queue').expect(200);
    expect(queue.body.items[0].reasons).toContain('idle_too_long');
    expect(queue.body.items[0].reasonLabels).toContain('No recorded action for too long');
  });

  it('excludes an acknowledged lead, which has an accountable owner', async () => {
    const owner = await signUpOwner(app);
    await makeAvailable(owner);
    const created = await owner.post('/api/leads', { firstName: 'Ada' }).expect(201);

    await owner.post(`/api/leads/${created.body.leadId}/acknowledge`).expect(200);
    await LeadModel.updateOne(
      { _id: new Types.ObjectId(created.body.leadId) },
      { $set: { escalationCount: 5 } },
    );

    const queue = await owner.get('/api/recovery-queue').expect(200);
    expect(queue.body.total).toBe(0);
  });

  it('is empty when every lead is healthy', async () => {
    const owner = await signUpOwner(app);
    await makeAvailable(owner);
    await owner.post('/api/leads', { firstName: 'Ada' }).expect(201);

    expect((await owner.get('/api/recovery-queue').expect(200)).body.total).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Permissions and isolation
// ---------------------------------------------------------------------------

describe('lead permissions and isolation', () => {
  it('shows a plain member only their own leads', async () => {
    const owner = await signUpOwner(app, { email: 'owner@example.com' });
    const member = await addMember(owner, 'member@example.com');
    await makeAvailable(owner);

    // Assigned to the owner, because only they are available.
    await owner.post('/api/leads', { firstName: 'OwnersLead' }).expect(201);

    // The member has no member management, so the inbox is scoped to them.
    const leads = await member.get('/api/leads').expect(200);
    expect(leads.body.items).toHaveLength(0);
  });

  it('refuses editing assignment rules without the configuration permission', async () => {
    const owner = await signUpOwner(app, { email: 'owner@example.com' });
    const member = await addMember(owner, 'member@example.com');

    await member.patch('/api/assignment-rules', { maxOpenLeadsPerEmployee: 99 }).expect(403);
  });

  it('refuses manual reassignment without member management', async () => {
    const owner = await signUpOwner(app, { email: 'owner@example.com' });
    const member = await addMember(owner, 'member@example.com');
    await makeAvailable(owner);
    const created = await owner.post('/api/leads', { firstName: 'Ada' }).expect(201);

    await member.post(`/api/leads/${created.body.leadId}/reassign`).expect(403);
  });

  it('never shows another workspace leads or recovery queue (F1.6)', async () => {
    const first = await signUpOwner(app, { email: 'a@example.com' });
    const second = await signUpOwner(app, { email: 'b@example.com' });
    await makeAvailable(second);

    await second.post('/api/leads', { firstName: 'Secret' }).expect(201);

    const leads = await first.get('/api/leads').expect(200);
    expect(leads.body.items).toHaveLength(0);

    const queue = await first.get('/api/recovery-queue').expect(200);
    expect(queue.body.total).toBe(0);
  });

  it('refuses acknowledging another workspace lead', async () => {
    const first = await signUpOwner(app, { email: 'a@example.com' });
    const second = await signUpOwner(app, { email: 'b@example.com' });
    await makeAvailable(second);

    const theirs = await second.post('/api/leads', { firstName: 'Secret' }).expect(201);

    await first.post(`/api/leads/${theirs.body.leadId}/acknowledge`).expect(404);
  });

  it('refuses an anonymous caller on every authenticated endpoint', async () => {
    await request(app).get('/api/leads').expect(401);
    await request(app).get('/api/recovery-queue').expect(401);
    await request(app).get('/api/availability').expect(401);
    await request(app).patch('/api/assignment-rules').send({}).expect(401);
  });
});
