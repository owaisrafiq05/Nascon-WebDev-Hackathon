import type { Express } from 'express';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ActivityModel } from '../../db/models/activity.js';
import { CalendarConnectionModel } from '../../db/models/calendar-connection.js';
import { ProviderError } from '../../integrations/http.js';
import { resetProviders } from '../../integrations/registry.js';
import { signState, verifyState } from '../../services/calendar-service.js';
import { addMember, installFakes, type FakeState } from '../../test/fakes.js';
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

async function connectCalendar(client: TestClient): Promise<void> {
  const start = await client.post('/api/calendar/connect').expect(200);
  const state = new URL(start.body.authorizationUrl as string).searchParams.get('state') ?? '';
  const callback = await client
    .get(`/api/integrations/google/callback?code=abc&state=${encodeURIComponent(state)}`)
    .expect(302);
  expect(callback.headers['location']).toBe('http://localhost:5173/settings?calendar=connected');
}

async function contact(owner: TestClient): Promise<string> {
  const created = await owner
    .post('/api/contacts', { firstName: 'Cal', phone: '+15551112222' })
    .expect(201);
  return created.body.id as string;
}

const at = (iso: string) => new Date(iso).toISOString();

describe('OAuth state (I3.1)', () => {
  it('binds the state to the member and expires it', () => {
    const state = signState(config.integrations, 'member-a', 0);
    expect(verifyState(config.integrations, state, 'member-a', 1_000)).toBe(true);
    expect(verifyState(config.integrations, state, 'member-b', 1_000)).toBe(false);
    expect(verifyState(config.integrations, state, 'member-a', 11 * 60 * 1_000)).toBe(false);
    expect(verifyState(config.integrations, `${state}x`, 'member-a', 1_000)).toBe(false);
  });
});

describe('connecting a calendar (I3.1, I3.2, I3.7)', () => {
  it('connects through consent, stores tokens encrypted, and shows the status', async () => {
    const owner = await signUpOwner(app);
    await connectCalendar(owner);

    const status = await owner.get('/api/calendar/connection').expect(200);
    expect(status.body).toMatchObject({
      configured: true,
      status: 'connected',
      googleEmail: 'employee@gmail.test',
      timeZone: 'Asia/Karachi',
    });
    const row = await CalendarConnectionModel.findOne({}).lean();
    expect(row?.refreshToken).not.toContain('refresh-token');
    expect(JSON.stringify(status.body)).not.toContain('refresh');
  });

  it('refuses a callback whose state belongs to someone else', async () => {
    const owner = await signUpOwner(app);
    const other = await addMember(app, owner, 'other@example.com');
    const start = await owner.post('/api/calendar/connect').expect(200);
    const state = new URL(start.body.authorizationUrl as string).searchParams.get('state') ?? '';
    const callback = await other
      .get(`/api/integrations/google/callback?code=abc&state=${encodeURIComponent(state)}`)
      .expect(302);
    expect(callback.headers['location']).toContain('calendar=error');
    expect(await CalendarConnectionModel.countDocuments()).toBe(0);
  });

  it('marks a revoked connection as needing reconnection (I3.2)', async () => {
    const owner = await signUpOwner(app);
    await connectCalendar(owner);
    await CalendarConnectionModel.updateOne({}, { $set: { accessTokenExpiresAt: new Date(0) } });
    fakes.failRefresh = new ProviderError('Token has been expired or revoked.', {
      transient: false,
      status: 400,
      providerCode: 'invalid_grant',
    });

    const busy = await owner
      .get(
        `/api/calendar/busy?membershipId=${owner.membershipId}&from=${at('2030-01-01T09:00:00Z')}&to=${at('2030-01-01T17:00:00Z')}`,
      )
      .expect(409);
    expect(busy.body.error.details.reason).toBe('needs_reconnect');
    expect((await owner.get('/api/calendar/connection').expect(200)).body.status).toBe(
      'needs_reconnect',
    );
  });

  it('refreshes an expired access token automatically (I3.2)', async () => {
    const owner = await signUpOwner(app);
    await connectCalendar(owner);
    await CalendarConnectionModel.updateOne({}, { $set: { accessTokenExpiresAt: new Date(0) } });
    await owner
      .get(
        `/api/calendar/busy?membershipId=${owner.membershipId}&from=${at('2030-01-01T09:00:00Z')}&to=${at('2030-01-01T17:00:00Z')}`,
      )
      .expect(200);
    expect(fakes.refreshCount).toBe(1);
  });

  it('lists employees without a calendar as not bookable, with the reason (I3.7)', async () => {
    const owner = await signUpOwner(app);
    await addMember(app, owner, 'nocal@example.com');
    await connectCalendar(owner);
    const employees = await owner.get('/api/calendar/employees').expect(200);
    const other = employees.body.items.find(
      (item: { email: string }) => item.email === 'nocal@example.com',
    );
    expect(other).toMatchObject({ bookable: false, calendarStatus: 'not_connected' });
    expect(other.reason).toContain('not connected');
  });

  it('disconnects, and the Admin page reflects it', async () => {
    const owner = await signUpOwner(app);
    await connectCalendar(owner);
    await owner.delete('/api/calendar/connection').expect(204);
    expect(await CalendarConnectionModel.countDocuments()).toBe(0);
  });
});

describe('appointments (I3.3 - I3.6)', () => {
  it('books into the employee calendar and onto the customer record', async () => {
    const owner = await signUpOwner(app);
    await connectCalendar(owner);
    const contactId = await contact(owner);

    const booked = await owner
      .post('/api/appointments', {
        contactId,
        employeeMembershipId: owner.membershipId,
        title: 'Site survey',
        startsAt: '2030-03-10T10:00:00+05:00',
        endsAt: '2030-03-10T11:00:00+05:00',
        timeZone: 'Asia/Karachi',
      })
      .expect(201);
    // Stored as an unambiguous instant plus its zone (I3.5).
    expect(booked.body).toMatchObject({
      startsAt: '2030-03-10T05:00:00.000Z',
      timeZone: 'Asia/Karachi',
      status: 'scheduled',
    });
    expect(fakes.events[0]).toMatchObject({ summary: 'Site survey', timeZone: 'Asia/Karachi' });

    const view = await owner.get(`/api/contacts/${contactId}/view`).expect(200);
    expect(view.body.appointments.items).toHaveLength(1);
  });

  it('refuses an employee without a connected calendar and says why (I3.7)', async () => {
    const owner = await signUpOwner(app);
    const contactId = await contact(owner);
    const response = await owner
      .post('/api/appointments', {
        contactId,
        employeeMembershipId: owner.membershipId,
        title: 'Call',
        startsAt: '2030-03-10T10:00:00Z',
        endsAt: '2030-03-10T11:00:00Z',
        timeZone: 'UTC',
      })
      .expect(409);
    expect(response.body.error.hint).toContain('not connected');
  });

  it('warns about an overlap and books only when told to (I3.4)', async () => {
    const owner = await signUpOwner(app);
    await connectCalendar(owner);
    const contactId = await contact(owner);
    fakes.busy = [
      { start: new Date('2030-03-10T10:30:00Z'), end: new Date('2030-03-10T11:30:00Z') },
    ];
    const body = {
      contactId,
      employeeMembershipId: owner.membershipId,
      title: 'Overlap',
      startsAt: '2030-03-10T10:00:00Z',
      endsAt: '2030-03-10T11:00:00Z',
      timeZone: 'UTC',
    };
    const refused = await owner.post('/api/appointments', body).expect(409);
    expect(refused.body.error.details.conflicts).toHaveLength(1);
    expect(fakes.events).toHaveLength(0);

    await owner.post('/api/appointments', { ...body, allowOverlap: true }).expect(201);
  });

  it('rejects an end before the start and an unknown time zone', async () => {
    const owner = await signUpOwner(app);
    await connectCalendar(owner);
    const contactId = await contact(owner);
    const response = await owner
      .post('/api/appointments', {
        contactId,
        employeeMembershipId: owner.membershipId,
        title: 'Bad',
        startsAt: '2030-03-10T11:00:00Z',
        endsAt: '2030-03-10T10:00:00Z',
        timeZone: 'Mars/Olympus',
      })
      .expect(422);
    expect(Object.keys(response.body.error.details.fields)).toEqual(['endsAt', 'timeZone']);
  });

  it('reschedules and cancels through Google and records both (I3.6)', async () => {
    const owner = await signUpOwner(app);
    await connectCalendar(owner);
    const contactId = await contact(owner);
    const booked = await owner
      .post('/api/appointments', {
        contactId,
        employeeMembershipId: owner.membershipId,
        title: 'Visit',
        startsAt: '2030-03-10T10:00:00Z',
        endsAt: '2030-03-10T11:00:00Z',
        timeZone: 'UTC',
      })
      .expect(201);

    const moved = await owner
      .patch(`/api/appointments/${booked.body.id}`, {
        startsAt: '2030-03-11T10:00:00Z',
        endsAt: '2030-03-11T11:00:00Z',
        timeZone: 'Europe/London',
        version: booked.body.version,
      })
      .expect(200);
    expect(moved.body.version).toBe(1);
    expect(fakes.events[0]?.startsAt.toISOString()).toBe('2030-03-11T10:00:00.000Z');

    // A stale version is refused (Q4).
    await owner
      .patch(`/api/appointments/${booked.body.id}`, {
        startsAt: '2030-03-12T10:00:00Z',
        endsAt: '2030-03-12T11:00:00Z',
        timeZone: 'UTC',
        version: 0,
      })
      .expect(409);

    const cancelled = await owner.post(`/api/appointments/${booked.body.id}/cancel`).expect(200);
    expect(cancelled.body.status).toBe('cancelled');
    expect(fakes.deletedEvents).toHaveLength(1);

    const types = (
      await ActivityModel.find({ type: /^appointment\./ })
        .sort({ createdAt: 1 })
        .lean()
    ).map((entry) => entry.type);
    expect(types).toEqual([
      'appointment.booked',
      'appointment.rescheduled',
      'appointment.cancelled',
    ]);

    const upcoming = await owner.get('/api/appointments?upcoming=true').expect(200);
    expect(upcoming.body.items).toHaveLength(0);
  });

  it('keeps appointments inside their workspace (F1.6)', async () => {
    const ownerA = await signUpOwner(app);
    const ownerB = await signUpOwner(app);
    await connectCalendar(ownerA);
    const contactId = await contact(ownerA);
    const booked = await ownerA
      .post('/api/appointments', {
        contactId,
        employeeMembershipId: ownerA.membershipId,
        title: 'Private',
        startsAt: '2030-03-10T10:00:00Z',
        endsAt: '2030-03-10T11:00:00Z',
        timeZone: 'UTC',
      })
      .expect(201);
    await ownerB.post(`/api/appointments/${booked.body.id}/cancel`).expect(404);
    expect((await ownerB.get('/api/appointments').expect(200)).body.items).toHaveLength(0);
  });
});
