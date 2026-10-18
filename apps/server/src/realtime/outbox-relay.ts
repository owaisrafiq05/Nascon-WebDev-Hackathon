import { OutboxEventModel } from '../db/models/outbox-event.js';
import type { Logger } from '../logger.js';
import type { RealtimeHub } from './socket-server.js';

/**
 * Relays outbox rows to sockets (Q11).
 *
 * Services write an outbox row in the same transaction as each change. This
 * loop claims undelivered rows, emits each to its workspace room (and to the
 * member room when the row names one), then marks it delivered **after** the
 * emit. A crash between the two re-emits on restart: a duplicate is harmless
 * because the browser only refetches, a lost event is not.
 *
 * The claim is an atomic `findOneAndUpdate` with a short lease, so two API
 * processes never relay the same row at the same moment.
 */
export const RELAY_LEASE_MS = 10_000;

export async function relayOnce(hub: RealtimeHub, maxEvents = 100): Promise<number> {
  let relayed = 0;

  for (let index = 0; index < maxEvents; index += 1) {
    const now = new Date();
    const row = await OutboxEventModel.findOneAndUpdate(
      {
        deliveredAt: null,
        $or: [{ claimedUntil: null }, { claimedUntil: { $lte: now } }],
      },
      { $set: { claimedUntil: new Date(now.getTime() + RELAY_LEASE_MS) } },
      { sort: { createdAt: 1 }, returnDocument: 'after' },
    ).lean();

    if (row === null) break;

    const event = { type: row.type, payload: row.payload };
    hub.emitToWorkspace(row.workspaceId.toString(), event);
    if (row.membershipId !== null) {
      hub.emitToMember(row.membershipId.toString(), { ...event, personal: true });
    }

    await OutboxEventModel.updateOne({ _id: row._id }, { $set: { deliveredAt: new Date() } });
    relayed += 1;
  }

  return relayed;
}

/** A non-overlapping polling loop: the next pass starts after the last finishes. */
export function startOutboxRelay(
  hub: RealtimeHub,
  options: { readonly intervalMs: number; readonly logger: Logger },
): { stop(): void } {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  const loop = async (): Promise<void> => {
    if (stopped) return;
    try {
      await relayOnce(hub);
    } catch (error) {
      options.logger.error({ err: error }, 'outbox relay pass failed');
    }
    if (!stopped) timer = setTimeout(() => void loop(), options.intervalMs);
  };

  void loop();

  return {
    stop() {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}
