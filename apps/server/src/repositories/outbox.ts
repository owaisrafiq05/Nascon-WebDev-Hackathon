import type { ClientSession, Types } from 'mongoose';

import { OutboxEventModel, type OutboxEventType } from '../db/models/outbox-event.js';

/**
 * Appends a realtime event, inside the caller's transaction when there is one,
 * so an event is never emitted for a change that rolled back (Q11).
 *
 * The payload must hold ids only: the browser refetches through a
 * permission-checked endpoint.
 */
export async function appendOutbox(
  workspaceId: Types.ObjectId,
  type: OutboxEventType,
  payload: Record<string, unknown>,
  membershipId: Types.ObjectId | null = null,
  session?: ClientSession,
): Promise<void> {
  await OutboxEventModel.create(
    [{ workspaceId, type, payload, membershipId }],
    session === undefined ? {} : { session, ordered: true },
  );
}
