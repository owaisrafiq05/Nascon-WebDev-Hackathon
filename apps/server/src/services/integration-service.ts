import { randomBytes } from 'node:crypto';

import { AUDIT_EVENT_TYPES } from '@ubmp/domain';
import { AppError, ERROR_CODES } from '@ubmp/shared';
import mongoose, { type Types } from 'mongoose';

import type { IntegrationsConfig } from '../config.js';
import { CalendarConnectionModel } from '../db/models/calendar-connection.js';
import { IntegrationEventModel } from '../db/models/integration-event.js';
import {
  IntegrationModel,
  type IntegrationDoc,
  type WorkspaceProvider,
} from '../db/models/integration.js';
import { ProviderError } from '../integrations/http.js';
import { providers } from '../integrations/registry.js';
import { appendAuditEvent } from '../repositories/audit-repository.js';
import { recordIntegrationEvent } from '../repositories/integration-events.js';
import { appendOutbox } from '../repositories/outbox.js';
import type { Actor } from './crm-service.js';
import { decryptSecret, encryptSecret, lastFour, requireKey } from './secret-box.js';

/**
 * The central integrations page and per-workspace connections (I5.1 - I5.7).
 */

/** What each integration can and cannot do, in words (I5.6). */
export const INTEGRATION_CATALOG = {
  twilio: {
    name: 'Messaging (Twilio WhatsApp sandbox or SMS)',
    can: [
      'Receives WhatsApp or SMS messages and files them on the matching contact',
      'Creates a contact and a lead for a number it has not seen before',
      'Sends replies from the conversation view and tracks sent, delivered and failed',
    ],
    cannot: [
      'The WhatsApp sandbox only reaches phones that have sent the sandbox join phrase',
      'Outside the 24-hour WhatsApp session window, free-form replies are refused by Twilio',
      'Media attachments are not shown; only text is stored',
    ],
  },
  stripe: {
    name: 'Payments (Stripe test mode)',
    can: [
      'Creates a hosted Checkout payment link for an opportunity',
      'Marks payments paid, expired, failed or refunded from verified Stripe webhooks',
    ],
    cannot: [
      'Card details are never entered or stored here; only on Stripe’s hosted page',
      'Test mode accepts only Stripe’s published test cards',
      'Partial captures and subscriptions are not supported',
    ],
  },
  google: {
    name: 'Calendar (Google Calendar, per employee)',
    can: [
      'Each employee connects their own Google account with consent',
      'Books, reschedules and cancels appointments on the employee’s real calendar',
      'Reads busy times to warn about overlaps',
    ],
    cannot: [
      'While the Google app is in testing, only listed test users can connect',
      'Testing-mode refresh tokens can expire after 7 days and need a reconnect',
      'Events created directly in Google are not imported',
    ],
  },
  telegram: {
    name: 'Notifications (Telegram bot)',
    can: [
      'Alerts the new owner on Telegram when a lead escalates',
      'Each employee sets their own Telegram chat id',
    ],
    cannot: [
      'A bot can only message someone who has pressed Start in a chat with it first',
      'Alerts are retried three times, then shown here as failed',
    ],
  },
} as const;

export type CatalogProvider = keyof typeof INTEGRATION_CATALOG;

export const CREDENTIAL_FIELDS: Record<
  WorkspaceProvider,
  { secrets: readonly string[]; public: readonly string[] }
> = {
  twilio: { secrets: ['authToken'], public: ['accountSid', 'from'] },
  stripe: { secrets: ['secretKey', 'webhookSecret'], public: [] },
  telegram: { secrets: ['botToken'], public: [] },
};

export interface WebhookUrls {
  readonly [name: string]: string | null;
}

export function webhookUrls(
  config: IntegrationsConfig,
  provider: WorkspaceProvider,
  webhookKey: string,
): WebhookUrls {
  const base = config.publicBaseUrl;
  const url = (path: string): string | null => (base === null ? null : `${base}/api${path}`);
  if (provider === 'twilio') {
    return {
      inbound: url(`/webhooks/twilio/${webhookKey}/inbound`),
      status: url(`/webhooks/twilio/${webhookKey}/status`),
    };
  }
  if (provider === 'stripe') return { events: url(`/webhooks/stripe/${webhookKey}`) };
  return {};
}

/** Decrypted credentials for a connected integration, or null when not connected. */
export async function workspaceSecrets(
  workspaceId: Types.ObjectId,
  provider: WorkspaceProvider,
  key: Buffer | null,
): Promise<{ integration: IntegrationDoc; values: Record<string, string> } | null> {
  const integration = await IntegrationModel.findOne({
    workspaceId,
    provider,
    status: { $ne: 'disconnected' },
  }).lean();
  if (integration === null || key === null) return null;

  const values: Record<string, string> = { ...integration.publicConfig };
  for (const [name, stored] of Object.entries(integration.secrets)) {
    values[name] = decryptSecret(stored, key);
  }
  return { integration, values };
}

export function notConnected(provider: string): AppError {
  return new AppError(ERROR_CODES.CONFLICT, `${provider} is not connected for this workspace.`, {
    hint: 'Ask an Owner or Admin to connect it on the Integrations page.',
  });
}

/** Turns a provider failure into a message a person can act on (I5.5). */
export function providerFailure(error: unknown, what: string): AppError {
  if (error instanceof ProviderError) {
    return new AppError(
      error.transient ? ERROR_CODES.SERVICE_UNAVAILABLE : ERROR_CODES.UPSTREAM_FAILED,
      `${what}: ${error.message}`,
      {
        hint: error.transient
          ? 'The provider is having a temporary problem. Try again in a minute.'
          : 'Check the integration settings, then try again.',
        details: { providerStatus: error.status, providerCode: error.providerCode },
      },
    );
  }
  return new AppError(ERROR_CODES.UPSTREAM_FAILED, `${what}.`, { cause: error });
}

// ---------------------------------------------------------------------------
// The integrations page (I5.1)
// ---------------------------------------------------------------------------

export async function listIntegrations(workspaceId: Types.ObjectId, config: IntegrationsConfig) {
  const [rows, calendars, recentErrors] = await Promise.all([
    IntegrationModel.find({ workspaceId }).lean(),
    CalendarConnectionModel.find({ workspaceId }).select('status lastSuccessAt lastError').lean(),
    IntegrationEventModel.find({ workspaceId, result: { $in: ['error', 'rejected'] } })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean(),
  ]);

  const errorsFor = (provider: string) =>
    recentErrors
      .filter((event) => event.provider === provider)
      .slice(0, 5)
      .map((event) => ({
        at: event.createdAt.toISOString(),
        kind: event.kind,
        result: event.result,
        error: event.error,
      }));

  const workspaceEntries = (['twilio', 'stripe', 'telegram'] as const).map((provider) => {
    const row = rows.find((candidate) => candidate.provider === provider);
    const connected = row !== undefined && row.status !== 'disconnected';
    return {
      provider,
      ...INTEGRATION_CATALOG[provider],
      scope: 'workspace' as const,
      status: !connected ? ('not_connected' as const) : row.status,
      lastSuccessAt: connected ? (row.lastSuccessAt?.toISOString() ?? null) : null,
      lastErrorAt: connected ? (row.lastErrorAt?.toISOString() ?? null) : null,
      lastError: connected ? row.lastError : null,
      secretHints: connected ? row.secretHints : {},
      publicConfig: connected ? row.publicConfig : {},
      webhookUrls: connected ? webhookUrls(config, provider, row.webhookKey) : {},
      recentErrors: errorsFor(provider),
      fields: CREDENTIAL_FIELDS[provider],
    };
  });

  const needsReconnect = calendars.filter((entry) => entry.status === 'needs_reconnect').length;
  const lastCalendarSuccess = calendars
    .map((entry) => entry.lastSuccessAt?.getTime() ?? 0)
    .reduce((max, value) => Math.max(max, value), 0);

  const google = {
    provider: 'google' as const,
    ...INTEGRATION_CATALOG.google,
    scope: 'employee' as const,
    configured: config.google !== null,
    status:
      calendars.length === 0
        ? ('not_connected' as const)
        : needsReconnect > 0
          ? ('error' as const)
          : ('connected' as const),
    connectedEmployees: calendars.length - needsReconnect,
    needsReconnect,
    lastSuccessAt: lastCalendarSuccess === 0 ? null : new Date(lastCalendarSuccess).toISOString(),
    lastError: calendars.find((entry) => entry.lastError !== null)?.lastError ?? null,
    recentErrors: errorsFor('google'),
  };

  return { integrations: [...workspaceEntries, google] };
}

// ---------------------------------------------------------------------------
// Connect, update, disconnect (I5.2, I5.3, I5.7)
// ---------------------------------------------------------------------------

async function verify(
  provider: WorkspaceProvider,
  values: Record<string, string>,
): Promise<Record<string, string>> {
  if (provider === 'twilio') {
    const result = await providers().messaging.verifyCredentials({
      accountSid: values['accountSid'] ?? '',
      authToken: values['authToken'] ?? '',
      from: values['from'] ?? '',
    });
    return { accountName: result.accountName };
  }
  if (provider === 'stripe') {
    const result = await providers().payments.verifyCredentials({
      secretKey: values['secretKey'] ?? '',
      webhookSecret: values['webhookSecret'] ?? '',
    });
    if (result.livemode) {
      throw new ProviderError('That is a live-mode key. Use a test-mode key (sk_test_…).', {
        transient: false,
      });
    }
    return { mode: 'test' };
  }
  const bot = await providers().notifications.verifyBot(values['botToken'] ?? '');
  return { botUsername: bot.username };
}

export async function connectIntegration(input: {
  readonly workspaceId: Types.ObjectId;
  readonly provider: WorkspaceProvider;
  readonly values: Record<string, string>;
  readonly actor: Actor | null;
  readonly config: IntegrationsConfig;
}): Promise<void> {
  const key = requireKey(input.config.encryptionKey);
  const fields = CREDENTIAL_FIELDS[input.provider];

  // Fields left blank on an update keep their stored value, so an Admin can
  // change the sender number without re-typing a token they cannot see.
  const existing = await workspaceSecrets(input.workspaceId, input.provider, key);
  const values: Record<string, string> = { ...(existing?.values ?? {}) };
  for (const name of [...fields.secrets, ...fields.public]) {
    const supplied = input.values[name];
    if (supplied !== undefined && supplied.trim() !== '') values[name] = supplied.trim();
    if (values[name] === undefined) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'Some credentials are missing.', {
        details: { fields: { [name]: 'is required' } },
      });
    }
  }

  let verified: Record<string, string>;
  try {
    verified = await verify(input.provider, values);
  } catch (error) {
    await recordIntegrationEvent({
      workspaceId: input.workspaceId,
      provider: input.provider,
      direction: 'outbound',
      kind: 'credentials.verify',
      result: 'error',
      error,
    });
    throw providerFailure(error, 'The provider refused these credentials');
  }

  const secrets: Record<string, string> = {};
  const secretHints: Record<string, string> = {};
  for (const name of fields.secrets) {
    const value = values[name] ?? '';
    secrets[name] = encryptSecret(value, key);
    secretHints[name] = lastFour(value);
  }
  const publicConfig: Record<string, string> = { ...verified };
  for (const name of fields.public) publicConfig[name] = values[name] ?? '';

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const before = await IntegrationModel.findOne({
        workspaceId: input.workspaceId,
        provider: input.provider,
      })
        .session(session)
        .lean();

      await IntegrationModel.updateOne(
        { workspaceId: input.workspaceId, provider: input.provider },
        {
          $set: {
            status: 'connected',
            secrets,
            secretHints,
            publicConfig,
            lastSuccessAt: new Date(),
            lastError: null,
            lastErrorAt: null,
            connectedByMembershipId: input.actor?.membershipId ?? null,
          },
          $setOnInsert: { webhookKey: randomBytes(24).toString('hex') },
          $inc: { version: 1 },
        },
        { upsert: true, session },
      );

      const wasConnected = before !== null && before.status !== 'disconnected';
      await appendAuditEvent(
        {
          workspaceId: input.workspaceId,
          type: wasConnected
            ? AUDIT_EVENT_TYPES.INTEGRATION_UPDATED
            : AUDIT_EVENT_TYPES.INTEGRATION_CONNECTED,
          actor:
            input.actor === null
              ? { kind: 'system', label: 'seed' }
              : {
                  kind: 'user',
                  userId: input.actor.userId,
                  membershipId: input.actor.membershipId,
                  label: input.actor.label,
                },
          target: { kind: 'integration', id: input.provider, label: input.provider },
          // Hints only: a secret never enters the audit trail.
          ...(wasConnected
            ? { before: { secretHints: before.secretHints, ...before.publicConfig } }
            : {}),
          after: { secretHints, ...publicConfig },
        },
        session,
      );

      await appendOutbox(
        input.workspaceId,
        'integration.updated',
        { provider: input.provider },
        null,
        session,
      );
    });
  } finally {
    await session.endSession();
  }
}

export async function disconnectIntegration(input: {
  readonly workspaceId: Types.ObjectId;
  readonly provider: WorkspaceProvider;
  readonly actor: Actor;
}): Promise<boolean> {
  const session = await mongoose.startSession();
  try {
    let removed = false;
    await session.withTransaction(async () => {
      const updated = await IntegrationModel.updateOne(
        {
          workspaceId: input.workspaceId,
          provider: input.provider,
          status: { $ne: 'disconnected' },
        },
        // Secrets are erased, not just hidden: a disconnected integration holds none.
        { $set: { status: 'disconnected', secrets: {}, secretHints: {} }, $inc: { version: 1 } },
        { session },
      );
      if (updated.modifiedCount !== 1) return;
      removed = true;

      await appendAuditEvent(
        {
          workspaceId: input.workspaceId,
          type: AUDIT_EVENT_TYPES.INTEGRATION_DISCONNECTED,
          actor: {
            kind: 'user',
            userId: input.actor.userId,
            membershipId: input.actor.membershipId,
            label: input.actor.label,
          },
          target: { kind: 'integration', id: input.provider, label: input.provider },
        },
        session,
      );
      await appendOutbox(
        input.workspaceId,
        'integration.updated',
        { provider: input.provider },
        null,
        session,
      );
    });
    return removed;
  } finally {
    await session.endSession();
  }
}
