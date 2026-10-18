import type { ClientSession, Types } from 'mongoose';

import {
  IntegrationEventModel,
  type IntegrationEventResult,
  type IntegrationProvider,
} from '../db/models/integration-event.js';
import { IntegrationModel, type WorkspaceProvider } from '../db/models/integration.js';
import { ProviderError } from '../integrations/http.js';

/**
 * Writes the synchronization history (I5.4) and keeps each integration's
 * "last worked" and "last error" up to date (I5.1).
 */
export interface RecordEventInput {
  readonly workspaceId: Types.ObjectId | null;
  readonly provider: IntegrationProvider;
  readonly direction: 'inbound' | 'outbound';
  readonly kind: string;
  readonly result: IntegrationEventResult;
  readonly reference?: string | null | undefined;
  readonly providerEventId?: string | null | undefined;
  readonly error?: unknown;
}

export async function recordIntegrationEvent(input: RecordEventInput): Promise<void> {
  const providerError = input.error instanceof ProviderError ? input.error : null;
  const message =
    input.error === undefined
      ? null
      : input.error instanceof Error
        ? input.error.message
        : typeof input.error === 'string'
          ? input.error
          : 'unknown error';

  await IntegrationEventModel.create({
    workspaceId: input.workspaceId,
    provider: input.provider,
    direction: input.direction,
    kind: input.kind,
    result: input.result,
    reference: input.reference ?? null,
    providerEventId: input.providerEventId ?? null,
    httpStatus: providerError?.status ?? null,
    error: message?.slice(0, 1_000) ?? null,
    transient: providerError?.transient ?? null,
  });

  if (input.workspaceId !== null && input.provider !== 'google') {
    await markIntegrationHealth(input.workspaceId, input.provider, input.result, message);
  }
}

export async function markIntegrationHealth(
  workspaceId: Types.ObjectId,
  provider: WorkspaceProvider,
  result: IntegrationEventResult,
  message: string | null,
): Promise<void> {
  if (result === 'ok') {
    await IntegrationModel.updateOne(
      { workspaceId, provider, status: { $ne: 'disconnected' } },
      { $set: { lastSuccessAt: new Date(), status: 'connected' } },
    );
  } else if (result === 'error') {
    await IntegrationModel.updateOne(
      { workspaceId, provider, status: { $ne: 'disconnected' } },
      { $set: { lastErrorAt: new Date(), lastError: message, status: 'error' } },
    );
  }
}

/**
 * Claims a provider event id for processing (I1.8, I2.4).
 *
 * Called inside the transaction that applies the event, so a failure rolls the
 * claim back with the change and the provider's retry is processed normally.
 * A delivery whose id is already claimed returns false; two concurrent
 * deliveries collide on the unique index and the loser is reported as a
 * duplicate by `isDuplicateKeyError`.
 */
export async function claimProviderEvent(
  input: {
    readonly workspaceId: Types.ObjectId;
    readonly provider: IntegrationProvider;
    readonly kind: string;
    readonly providerEventId: string;
    readonly reference?: string | null | undefined;
  },
  session: ClientSession,
): Promise<boolean> {
  const existing = await IntegrationEventModel.findOne({
    provider: input.provider,
    providerEventId: input.providerEventId,
  })
    .session(session)
    .select('_id')
    .lean();
  if (existing !== null) return false;

  await IntegrationEventModel.create(
    [
      {
        workspaceId: input.workspaceId,
        provider: input.provider,
        direction: 'inbound',
        kind: input.kind,
        result: 'ok',
        reference: input.reference ?? null,
        providerEventId: input.providerEventId,
      },
    ],
    { session, ordered: true },
  );
  return true;
}

export function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 11000;
}
