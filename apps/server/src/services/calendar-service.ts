import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { AUDIT_EVENT_TYPES } from '@ubmp/domain';
import { AppError, ERROR_CODES, notFound, versionConflict } from '@ubmp/shared';
import { Types } from 'mongoose';

import type { IntegrationsConfig } from '../config.js';
import { AppointmentModel, type AppointmentDoc } from '../db/models/appointment.js';
import {
  CalendarConnectionModel,
  type CalendarConnectionDoc,
} from '../db/models/calendar-connection.js';
import { ContactModel, contactDisplayName } from '../db/models/contact.js';
import { MembershipModel } from '../db/models/membership.js';
import { OpportunityModel } from '../db/models/opportunity.js';
import type { BusyInterval, GoogleOAuthClient } from '../integrations/google/google.js';
import { ProviderError, withRetry } from '../integrations/http.js';
import { providers } from '../integrations/registry.js';
import { recordActivity } from '../repositories/activity-repository.js';
import { appendAuditEvent } from '../repositories/audit-repository.js';
import { recordIntegrationEvent } from '../repositories/integration-events.js';
import { appendOutbox } from '../repositories/outbox.js';
import type { Actor } from './crm-service.js';
import { providerFailure } from './integration-service.js';
import { acknowledgeOnRecordedAction, membershipLabels } from './lead-service.js';
import { decryptSecret, encryptSecret, requireKey } from './secret-box.js';
import type { AuthContext } from './session-service.js';

/**
 * Google Calendar per employee (I3.1 - I3.7).
 */

function googleClient(config: IntegrationsConfig): GoogleOAuthClient {
  if (config.google === null) {
    throw new AppError(
      ERROR_CODES.SERVICE_UNAVAILABLE,
      'Google Calendar is not configured on this server.',
      {
        hint: 'Set GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET and GOOGLE_OAUTH_REDIRECT_URI.',
      },
    );
  }
  return config.google;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// OAuth consent (I3.1)
// ---------------------------------------------------------------------------

const STATE_TTL_MS = 10 * 60 * 1_000;

/**
 * The OAuth `state`: membership, expiry and a nonce, signed with a key derived
 * from ENCRYPTION_KEY. The callback also requires the same signed-in member,
 * so a state cannot be replayed into someone else's session (CSRF on OAuth).
 */
function stateKey(config: IntegrationsConfig): Buffer {
  return createHmac('sha256', requireKey(config.encryptionKey)).update('oauth-state').digest();
}

export function signState(
  config: IntegrationsConfig,
  membershipId: string,
  now = Date.now(),
): string {
  const payload = `${membershipId}.${String(now + STATE_TTL_MS)}.${randomBytes(8).toString('hex')}`;
  const signature = createHmac('sha256', stateKey(config)).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

export function verifyState(
  config: IntegrationsConfig,
  state: string,
  membershipId: string,
  now = Date.now(),
): boolean {
  const parts = state.split('.');
  if (parts.length !== 4) return false;
  const [member, expiry, nonce, signature] = parts as [string, string, string, string];
  const expected = createHmac('sha256', stateKey(config))
    .update(`${member}.${expiry}.${nonce}`)
    .digest('base64url');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  return member === membershipId && Number(expiry) > now;
}

export function authorizationUrl(auth: AuthContext, config: IntegrationsConfig): string {
  return providers().calendar.authorizationUrl(
    googleClient(config),
    signState(config, auth.membershipId.toString()),
  );
}

export async function completeConnection(input: {
  readonly auth: AuthContext;
  readonly code: string;
  readonly state: string;
  readonly actor: Actor;
  readonly config: IntegrationsConfig;
}): Promise<void> {
  const { auth, config } = input;
  if (!verifyState(config, input.state, auth.membershipId.toString())) {
    throw new AppError(
      ERROR_CODES.FORBIDDEN,
      'That calendar connection link is invalid or expired.',
      {
        hint: 'Start the connection again from Settings.',
      },
    );
  }
  const key = requireKey(config.encryptionKey);

  let tokens;
  let profile;
  try {
    tokens = await providers().calendar.exchangeCode(googleClient(config), input.code);
    profile = await providers().calendar.profile(tokens.accessToken);
  } catch (error) {
    await recordIntegrationEvent({
      workspaceId: auth.workspaceId,
      provider: 'google',
      direction: 'outbound',
      kind: 'oauth.exchange_code',
      result: 'error',
      error,
    });
    throw providerFailure(error, 'Google refused the connection');
  }

  const existing = await CalendarConnectionModel.findOne({
    workspaceId: auth.workspaceId,
    membershipId: auth.membershipId,
  }).lean();
  const refreshToken =
    tokens.refreshToken ?? (existing === null ? null : decryptSecret(existing.refreshToken, key));
  if (refreshToken === null) {
    throw new AppError(ERROR_CODES.UPSTREAM_FAILED, 'Google did not return a refresh token.', {
      hint: 'Remove the app’s access in your Google account settings, then connect again.',
    });
  }

  await CalendarConnectionModel.updateOne(
    { workspaceId: auth.workspaceId, membershipId: auth.membershipId },
    {
      $set: {
        googleEmail: profile.email,
        timeZone: isValidTimeZone(profile.timeZone) ? profile.timeZone : 'UTC',
        calendarId: 'primary',
        refreshToken: encryptSecret(refreshToken, key),
        accessToken: encryptSecret(tokens.accessToken, key),
        accessTokenExpiresAt: tokens.expiresAt,
        status: 'connected',
        lastError: null,
        lastSuccessAt: new Date(),
      },
    },
    { upsert: true },
  );

  await recordIntegrationEvent({
    workspaceId: auth.workspaceId,
    provider: 'google',
    direction: 'outbound',
    kind: 'oauth.exchange_code',
    result: 'ok',
    reference: profile.email,
  });
  await appendAuditEvent({
    workspaceId: auth.workspaceId,
    type:
      existing === null
        ? AUDIT_EVENT_TYPES.INTEGRATION_CONNECTED
        : AUDIT_EVENT_TYPES.INTEGRATION_UPDATED,
    actor: {
      kind: 'user',
      userId: input.actor.userId,
      membershipId: input.actor.membershipId,
      label: input.actor.label,
    },
    target: { kind: 'integration', id: 'google', label: `Google Calendar (${profile.email})` },
    after: { googleEmail: profile.email, membershipId: auth.membershipId.toString() },
  });
  await appendOutbox(auth.workspaceId, 'integration.updated', { provider: 'google' });
}

export async function disconnectCalendar(
  auth: AuthContext,
  actor: Actor,
  config: IntegrationsConfig,
): Promise<boolean> {
  const connection = await CalendarConnectionModel.findOne({
    workspaceId: auth.workspaceId,
    membershipId: auth.membershipId,
  }).lean();
  if (connection === null) return false;

  // Best effort: revoking at Google is courteous, but the local delete is what
  // guarantees the platform can no longer act on the calendar.
  if (config.encryptionKey !== null) {
    try {
      await providers().calendar.revoke(
        decryptSecret(connection.refreshToken, config.encryptionKey),
      );
    } catch {
      // already revoked or unreachable
    }
  }

  await CalendarConnectionModel.deleteOne({ _id: connection._id });
  await appendAuditEvent({
    workspaceId: auth.workspaceId,
    type: AUDIT_EVENT_TYPES.INTEGRATION_DISCONNECTED,
    actor: {
      kind: 'user',
      userId: actor.userId,
      membershipId: actor.membershipId,
      label: actor.label,
    },
    target: {
      kind: 'integration',
      id: 'google',
      label: `Google Calendar (${connection.googleEmail})`,
    },
  });
  await appendOutbox(auth.workspaceId, 'integration.updated', { provider: 'google' });
  return true;
}

export async function connectionStatus(auth: AuthContext, config: IntegrationsConfig) {
  const connection = await CalendarConnectionModel.findOne({
    workspaceId: auth.workspaceId,
    membershipId: auth.membershipId,
  }).lean();
  return {
    configured: config.google !== null,
    status: connection?.status ?? 'not_connected',
    googleEmail: connection?.googleEmail ?? null,
    timeZone: connection?.timeZone ?? null,
    lastError: connection?.lastError ?? null,
  };
}

// ---------------------------------------------------------------------------
// Tokens (I3.2)
// ---------------------------------------------------------------------------

function needsReconnect(email: string): AppError {
  return new AppError(
    ERROR_CODES.CONFLICT,
    `The Google Calendar connection for ${email} needs to be reconnected.`,
    {
      hint: 'The employee must open Settings and connect their calendar again.',
      details: { reason: 'needs_reconnect' },
    },
  );
}

/**
 * A valid access token, refreshed automatically when it is about to expire.
 * A refusal to refresh (revoked consent, expired testing token) marks the
 * connection `needs_reconnect`, which the interface shows.
 */
export async function accessTokenFor(
  connection: CalendarConnectionDoc,
  config: IntegrationsConfig,
): Promise<string> {
  const key = requireKey(config.encryptionKey);
  if (connection.status === 'needs_reconnect') throw needsReconnect(connection.googleEmail);

  const fresh =
    connection.accessToken !== null &&
    connection.accessTokenExpiresAt !== null &&
    connection.accessTokenExpiresAt.getTime() - Date.now() > 60_000;
  if (fresh && connection.accessToken !== null) return decryptSecret(connection.accessToken, key);

  try {
    const tokens = await withRetry(() =>
      providers().calendar.refresh(
        googleClient(config),
        decryptSecret(connection.refreshToken, key),
      ),
    );
    await CalendarConnectionModel.updateOne(
      { _id: connection._id },
      {
        $set: {
          accessToken: encryptSecret(tokens.accessToken, key),
          accessTokenExpiresAt: tokens.expiresAt,
          ...(tokens.refreshToken === null
            ? {}
            : { refreshToken: encryptSecret(tokens.refreshToken, key) }),
          lastError: null,
        },
      },
    );
    await recordIntegrationEvent({
      workspaceId: connection.workspaceId,
      provider: 'google',
      direction: 'outbound',
      kind: 'oauth.refresh',
      result: 'ok',
      reference: connection.googleEmail,
    });
    return tokens.accessToken;
  } catch (error) {
    await recordIntegrationEvent({
      workspaceId: connection.workspaceId,
      provider: 'google',
      direction: 'outbound',
      kind: 'oauth.refresh',
      result: 'error',
      reference: connection.googleEmail,
      error,
    });
    if (error instanceof ProviderError && !error.transient) {
      await CalendarConnectionModel.updateOne(
        { _id: connection._id },
        { $set: { status: 'needs_reconnect', lastError: error.message, accessToken: null } },
      );
      await appendOutbox(connection.workspaceId, 'integration.updated', { provider: 'google' });
      throw needsReconnect(connection.googleEmail);
    }
    throw providerFailure(error, 'Google Calendar is unavailable');
  }
}

/** Runs a Google call, marking the connection healthy or recording the error. */
async function withCalendar<T>(
  connection: CalendarConnectionDoc,
  config: IntegrationsConfig,
  kind: string,
  call: (token: string) => Promise<T>,
): Promise<T> {
  const token = await accessTokenFor(connection, config);
  try {
    const result = await withRetry(() => call(token));
    await CalendarConnectionModel.updateOne(
      { _id: connection._id },
      { $set: { lastSuccessAt: new Date() } },
    );
    await recordIntegrationEvent({
      workspaceId: connection.workspaceId,
      provider: 'google',
      direction: 'outbound',
      kind,
      result: 'ok',
      reference: connection.googleEmail,
    });
    return result;
  } catch (error) {
    await recordIntegrationEvent({
      workspaceId: connection.workspaceId,
      provider: 'google',
      direction: 'outbound',
      kind,
      result: 'error',
      reference: connection.googleEmail,
      error,
    });
    if (error instanceof ProviderError && error.status === 401) {
      await CalendarConnectionModel.updateOne(
        { _id: connection._id },
        { $set: { status: 'needs_reconnect', lastError: error.message } },
      );
      throw needsReconnect(connection.googleEmail);
    }
    throw providerFailure(error, 'Google Calendar refused the request');
  }
}

// ---------------------------------------------------------------------------
// Bookable employees and busy times (I3.4, I3.7)
// ---------------------------------------------------------------------------

export async function bookableEmployees(auth: AuthContext) {
  const [memberships, connections, labels] = await Promise.all([
    MembershipModel.find({ workspaceId: auth.workspaceId }).sort({ _id: 1 }).lean(),
    CalendarConnectionModel.find({ workspaceId: auth.workspaceId }).lean(),
    membershipLabels(auth.workspaceId),
  ]);
  const byMember = new Map(connections.map((entry) => [entry.membershipId.toString(), entry]));

  return memberships.map((membership) => {
    const connection = byMember.get(membership._id.toString());
    const calendarStatus = connection?.status ?? 'not_connected';
    const label = labels.get(membership._id.toString());
    return {
      membershipId: membership._id.toString(),
      email: label?.email ?? '',
      name: label?.name ?? '',
      calendarStatus,
      timeZone: connection?.timeZone ?? null,
      bookable: calendarStatus === 'connected',
      reason:
        calendarStatus === 'connected'
          ? null
          : calendarStatus === 'needs_reconnect'
            ? 'Their Google Calendar connection has expired and must be reconnected.'
            : 'They have not connected a Google Calendar yet.',
    };
  });
}

async function bookableConnection(
  auth: AuthContext,
  membershipId: string,
): Promise<CalendarConnectionDoc> {
  if (!Types.ObjectId.isValid(membershipId)) throw notFound('That member does not exist.');
  const member = await MembershipModel.findOne({
    _id: new Types.ObjectId(membershipId),
    workspaceId: auth.workspaceId,
  }).lean();
  if (member === null) throw notFound('That member does not exist.');

  const connection = await CalendarConnectionModel.findOne({
    workspaceId: auth.workspaceId,
    membershipId: member._id,
  }).lean();
  if (connection === null) {
    throw new AppError(ERROR_CODES.CONFLICT, 'This employee cannot be booked.', {
      hint: 'They have not connected a Google Calendar yet. Ask them to connect it in Settings.',
      details: { reason: 'not_connected' },
    });
  }
  if (connection.status === 'needs_reconnect') throw needsReconnect(connection.googleEmail);
  return connection;
}

export async function busyTimes(
  auth: AuthContext,
  membershipId: string,
  from: Date,
  to: Date,
  config: IntegrationsConfig,
): Promise<{ busy: BusyInterval[]; timeZone: string }> {
  const connection = await bookableConnection(auth, membershipId);
  const busy = await withCalendar(connection, config, 'api.freebusy', (token) =>
    providers().calendar.busy(token, connection.calendarId, from, to),
  );
  return { busy, timeZone: connection.timeZone };
}

export function overlaps(a: BusyInterval, start: Date, end: Date): boolean {
  return a.start.getTime() < end.getTime() && start.getTime() < a.end.getTime();
}

async function conflictsFor(
  auth: AuthContext,
  connection: CalendarConnectionDoc,
  start: Date,
  end: Date,
  config: IntegrationsConfig,
  ignoreAppointment: AppointmentDoc | null,
): Promise<BusyInterval[]> {
  const busy = await withCalendar(connection, config, 'api.freebusy', (token) =>
    providers().calendar.busy(token, connection.calendarId, start, end),
  );
  const own = await AppointmentModel.find({
    workspaceId: auth.workspaceId,
    employeeMembershipId: connection.membershipId,
    status: 'scheduled',
    startsAt: { $lt: end },
    endsAt: { $gt: start },
    ...(ignoreAppointment === null ? {} : { _id: { $ne: ignoreAppointment._id } }),
  }).lean();

  const intervals = [
    ...busy,
    ...own.map((appointment) => ({ start: appointment.startsAt, end: appointment.endsAt })),
  ].filter((interval) => {
    // The appointment being rescheduled shows up in Google's busy list too.
    if (
      ignoreAppointment !== null &&
      interval.start.getTime() === ignoreAppointment.startsAt.getTime() &&
      interval.end.getTime() === ignoreAppointment.endsAt.getTime()
    ) {
      return false;
    }
    return overlaps(interval, start, end);
  });
  return intervals;
}

function overlapError(conflicts: BusyInterval[]): AppError {
  return new AppError(
    ERROR_CODES.CONFLICT,
    'That time overlaps something already in the calendar.',
    {
      hint: 'Pick another time, or book anyway if the overlap is intended.',
      details: {
        reason: 'overlap',
        conflicts: conflicts.map((entry) => ({
          start: entry.start.toISOString(),
          end: entry.end.toISOString(),
        })),
      },
    },
  );
}

function validateTimes(startsAt: Date, endsAt: Date, timeZone: string): void {
  const fields: Record<string, string> = {};
  if (Number.isNaN(startsAt.getTime())) fields['startsAt'] = 'is not a valid time';
  if (Number.isNaN(endsAt.getTime())) fields['endsAt'] = 'is not a valid time';
  if (fields['startsAt'] === undefined && fields['endsAt'] === undefined && endsAt <= startsAt) {
    fields['endsAt'] = 'must be after the start';
  }
  if (!isValidTimeZone(timeZone)) fields['timeZone'] = 'is not a recognised time zone';
  if (Object.keys(fields).length > 0) {
    throw new AppError(
      ERROR_CODES.VALIDATION_FAILED,
      'Some of the appointment details are not valid.',
      {
        details: { fields },
      },
    );
  }
}

// ---------------------------------------------------------------------------
// Appointments (I3.3, I3.5, I3.6)
// ---------------------------------------------------------------------------

export async function appointmentViews(
  workspaceId: Types.ObjectId,
  appointments: readonly AppointmentDoc[],
) {
  const contactIds = [...new Set(appointments.map((entry) => entry.contactId.toString()))];
  const [contacts, labels] = await Promise.all([
    ContactModel.find({ workspaceId, _id: { $in: contactIds } })
      .select('firstName lastName')
      .lean(),
    membershipLabels(workspaceId),
  ]);
  const names = new Map(contacts.map((entry) => [entry._id.toString(), contactDisplayName(entry)]));
  return appointments.map((appointment) => ({
    id: appointment._id.toString(),
    contactId: appointment.contactId.toString(),
    contactName: names.get(appointment.contactId.toString()) ?? '(deleted contact)',
    opportunityId: appointment.opportunityId?.toString() ?? null,
    employeeMembershipId: appointment.employeeMembershipId.toString(),
    employeeEmail: labels.get(appointment.employeeMembershipId.toString())?.email ?? null,
    title: appointment.title,
    notes: appointment.notes,
    startsAt: appointment.startsAt.toISOString(),
    endsAt: appointment.endsAt.toISOString(),
    timeZone: appointment.timeZone,
    status: appointment.status,
    googleEventLink: appointment.googleEventLink,
    version: appointment.version,
    createdAt: appointment.createdAt.toISOString(),
  }));
}

function describe(appointment: { title: string; startsAt: Date; timeZone: string }): string {
  const when = appointment.startsAt.toLocaleString('en-GB', {
    timeZone: appointment.timeZone,
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  return `${appointment.title} on ${when} (${appointment.timeZone})`;
}

export async function bookAppointment(input: {
  readonly auth: AuthContext;
  readonly contactId: string;
  readonly opportunityId?: string | undefined;
  readonly employeeMembershipId: string;
  readonly title: string;
  readonly notes?: string | undefined;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly timeZone: string;
  readonly allowOverlap: boolean;
  readonly actor: Actor;
  readonly config: IntegrationsConfig;
}): Promise<AppointmentDoc> {
  const { auth, config } = input;
  validateTimes(input.startsAt, input.endsAt, input.timeZone);

  if (!Types.ObjectId.isValid(input.contactId)) throw notFound('That contact does not exist.');
  const contact = await ContactModel.findOne({
    _id: new Types.ObjectId(input.contactId),
    workspaceId: auth.workspaceId,
  }).lean();
  if (contact === null) throw notFound('That contact does not exist.');

  let opportunityId: Types.ObjectId | null = null;
  if (input.opportunityId !== undefined) {
    if (!Types.ObjectId.isValid(input.opportunityId))
      throw notFound('That opportunity does not exist.');
    const opportunity = await OpportunityModel.findOne({
      _id: new Types.ObjectId(input.opportunityId),
      workspaceId: auth.workspaceId,
    }).lean();
    if (opportunity === null) throw notFound('That opportunity does not exist.');
    opportunityId = opportunity._id;
  }

  const connection = await bookableConnection(auth, input.employeeMembershipId);
  const conflicts = await conflictsFor(
    auth,
    connection,
    input.startsAt,
    input.endsAt,
    config,
    null,
  );
  if (conflicts.length > 0 && !input.allowOverlap) throw overlapError(conflicts);

  const event = await withCalendar(connection, config, 'api.create_event', (token) =>
    providers().calendar.createEvent(token, connection.calendarId, {
      summary: input.title,
      description:
        `${input.notes ?? ''}\n\nWith ${contactDisplayName(contact)}${contact.phone === null ? '' : ` (${contact.phone})`}`.trim(),
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      timeZone: input.timeZone,
    }),
  );

  let appointment: AppointmentDoc;
  try {
    const created = await AppointmentModel.create({
      workspaceId: auth.workspaceId,
      contactId: contact._id,
      opportunityId,
      employeeMembershipId: connection.membershipId,
      bookedByMembershipId: input.actor.membershipId,
      title: input.title,
      notes: input.notes ?? '',
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      timeZone: input.timeZone,
      status: 'scheduled',
      googleEventId: event.id,
      googleEventLink: event.htmlLink,
    });
    appointment = created.toObject();
  } catch (error) {
    // Undo the Google side so the two never disagree.
    try {
      const token = await accessTokenFor(connection, config);
      await providers().calendar.deleteEvent(token, connection.calendarId, event.id);
    } catch {
      // best effort
    }
    throw error;
  }

  await recordActivity({
    workspaceId: auth.workspaceId,
    type: 'appointment.booked',
    targetKind: opportunityId === null ? 'contact' : 'opportunity',
    targetId: opportunityId ?? contact._id,
    contactId: contact._id,
    actor: input.actor,
    summary: `Appointment booked: ${describe(appointment)}`,
    payload: { appointmentId: appointment._id.toString(), overlapAccepted: conflicts.length > 0 },
  });
  await appendOutbox(
    auth.workspaceId,
    'appointment.updated',
    { appointmentId: appointment._id.toString(), contactId: contact._id.toString() },
    connection.membershipId,
  );
  await acknowledgeOnRecordedAction(auth, contact._id, input.actor, 'an appointment');
  return appointment;
}

async function findAppointment(auth: AuthContext, appointmentId: string): Promise<AppointmentDoc> {
  if (!Types.ObjectId.isValid(appointmentId)) throw notFound('That appointment does not exist.');
  const appointment = await AppointmentModel.findOne({
    _id: new Types.ObjectId(appointmentId),
    workspaceId: auth.workspaceId,
  }).lean();
  if (appointment === null) throw notFound('That appointment does not exist.');
  return appointment;
}

async function connectionOf(appointment: AppointmentDoc): Promise<CalendarConnectionDoc> {
  const connection = await CalendarConnectionModel.findOne({
    workspaceId: appointment.workspaceId,
    membershipId: appointment.employeeMembershipId,
  }).lean();
  if (connection === null) {
    throw new AppError(ERROR_CODES.CONFLICT, 'The employee’s calendar is no longer connected.', {
      hint: 'They must reconnect their Google Calendar before this appointment can change.',
    });
  }
  return connection;
}

export async function rescheduleAppointment(input: {
  readonly auth: AuthContext;
  readonly appointmentId: string;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly timeZone: string;
  readonly title?: string | undefined;
  readonly notes?: string | undefined;
  readonly version: number;
  readonly allowOverlap: boolean;
  readonly actor: Actor;
  readonly config: IntegrationsConfig;
}): Promise<AppointmentDoc> {
  const { auth, config } = input;
  validateTimes(input.startsAt, input.endsAt, input.timeZone);
  const appointment = await findAppointment(auth, input.appointmentId);
  if (appointment.status === 'cancelled') {
    throw new AppError(ERROR_CODES.CONFLICT, 'A cancelled appointment cannot be rescheduled.');
  }
  if (appointment.version !== input.version) throw versionConflict();

  const connection = await connectionOf(appointment);
  const conflicts = await conflictsFor(
    auth,
    connection,
    input.startsAt,
    input.endsAt,
    config,
    appointment,
  );
  if (conflicts.length > 0 && !input.allowOverlap) throw overlapError(conflicts);

  const title = input.title ?? appointment.title;
  const notes = input.notes ?? appointment.notes;
  if (appointment.googleEventId !== null) {
    const eventId = appointment.googleEventId;
    await withCalendar(connection, config, 'api.update_event', (token) =>
      providers().calendar.updateEvent(token, connection.calendarId, eventId, {
        summary: title,
        description: notes,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        timeZone: input.timeZone,
      }),
    );
  }

  const updated = await AppointmentModel.findOneAndUpdate(
    { _id: appointment._id, workspaceId: auth.workspaceId, version: input.version },
    {
      $set: {
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        timeZone: input.timeZone,
        title,
        notes,
      },
      $inc: { version: 1 },
    },
    { returnDocument: 'after' },
  ).lean();
  if (updated === null) throw versionConflict();

  await recordActivity({
    workspaceId: auth.workspaceId,
    type: 'appointment.rescheduled',
    targetKind: appointment.opportunityId === null ? 'contact' : 'opportunity',
    targetId: appointment.opportunityId ?? appointment.contactId,
    contactId: appointment.contactId,
    actor: input.actor,
    summary: `Appointment moved from ${describe(appointment)} to ${describe(updated)}`,
    payload: {
      appointmentId: appointment._id.toString(),
      before: {
        startsAt: appointment.startsAt.toISOString(),
        endsAt: appointment.endsAt.toISOString(),
      },
      after: { startsAt: updated.startsAt.toISOString(), endsAt: updated.endsAt.toISOString() },
    },
  });
  await appendOutbox(
    auth.workspaceId,
    'appointment.updated',
    { appointmentId: appointment._id.toString(), contactId: appointment.contactId.toString() },
    appointment.employeeMembershipId,
  );
  return updated;
}

export async function cancelAppointment(input: {
  readonly auth: AuthContext;
  readonly appointmentId: string;
  readonly actor: Actor;
  readonly config: IntegrationsConfig;
}): Promise<AppointmentDoc> {
  const { auth, config } = input;
  const appointment = await findAppointment(auth, input.appointmentId);
  if (appointment.status === 'cancelled') return appointment;

  if (appointment.googleEventId !== null) {
    const connection = await connectionOf(appointment);
    const eventId = appointment.googleEventId;
    try {
      await withCalendar(connection, config, 'api.delete_event', (token) =>
        providers().calendar.deleteEvent(token, connection.calendarId, eventId),
      );
    } catch (error) {
      // Already deleted in Google: the platform record still has to follow.
      const status = error instanceof AppError ? error.details?.['providerStatus'] : undefined;
      if (status !== 404 && status !== 410) throw error;
    }
  }

  const updated = await AppointmentModel.findOneAndUpdate(
    { _id: appointment._id, workspaceId: auth.workspaceId, status: 'scheduled' },
    { $set: { status: 'cancelled' }, $inc: { version: 1 } },
    { returnDocument: 'after' },
  ).lean();
  if (updated === null) return { ...appointment, status: 'cancelled' };

  await recordActivity({
    workspaceId: auth.workspaceId,
    type: 'appointment.cancelled',
    targetKind: appointment.opportunityId === null ? 'contact' : 'opportunity',
    targetId: appointment.opportunityId ?? appointment.contactId,
    contactId: appointment.contactId,
    actor: input.actor,
    summary: `Appointment cancelled: ${describe(appointment)}`,
    payload: { appointmentId: appointment._id.toString() },
  });
  await appendOutbox(
    auth.workspaceId,
    'appointment.updated',
    { appointmentId: appointment._id.toString(), contactId: appointment.contactId.toString() },
    appointment.employeeMembershipId,
  );
  return updated;
}
