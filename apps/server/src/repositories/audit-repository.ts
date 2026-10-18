import type { AuditEventType } from '@ubmp/domain';
import { offsetFor, paginate, type Paginated, type PaginationQuery } from '@ubmp/shared';
import type { ClientSession, Types } from 'mongoose';

import { AuditEventModel, type AuditEventDoc } from '../db/models/audit-event.js';

/**
 * The only way the platform touches the audit trail.
 *
 * This module deliberately exposes **no update and no delete**. That is the
 * first of the three guards behind F4.3: there is no method to call, the router
 * mounts only GET routes, and the schema refuses non-insert writes. A test
 * asserts the absence of a mutating method here, so adding one is a visible
 * change rather than a quiet one.
 */

export interface AuditActor {
  readonly kind: 'user' | 'system';
  readonly userId?: Types.ObjectId | undefined;
  readonly membershipId?: Types.ObjectId | undefined;
  /** How the actor should read in the log, captured at the time of the event. */
  readonly label: string;
}

export interface AuditTarget {
  readonly kind: string;
  readonly id?: string | undefined;
  readonly label?: string | undefined;
}

export interface AppendAuditEvent {
  readonly workspaceId: Types.ObjectId;
  readonly type: AuditEventType;
  readonly actor: AuditActor;
  readonly target: AuditTarget;
  readonly before?: Record<string, unknown> | undefined;
  readonly after?: Record<string, unknown> | undefined;
  readonly requestId?: string | undefined;
  readonly at?: Date | undefined;
}

/**
 * Appends one entry.
 *
 * `session` is passed by callers that write inside a transaction, so the audit
 * entry and the change it describes commit together: an entry can never exist
 * for a change that was rolled back, and a change can never commit unaudited
 * (CLAUDE.md: "the same logical operation").
 */
export async function appendAuditEvent(
  event: AppendAuditEvent,
  session?: ClientSession,
): Promise<void> {
  await AuditEventModel.create(
    [
      {
        workspaceId: event.workspaceId,
        type: event.type,
        at: event.at ?? new Date(),
        actorKind: event.actor.kind,
        actorUserId: event.actor.userId ?? null,
        actorMembershipId: event.actor.membershipId ?? null,
        actorLabel: event.actor.label,
        targetKind: event.target.kind,
        targetId: event.target.id ?? null,
        targetLabel: event.target.label ?? '',
        before: event.before ?? null,
        after: event.after ?? null,
        requestId: event.requestId ?? null,
      },
    ],
    session === undefined ? {} : { session },
  );
}

export interface AuditQuery {
  readonly workspaceId: Types.ObjectId;
  /** Filter by event type (F4.2). Empty means every type. */
  readonly types?: readonly AuditEventType[] | undefined;
  /** Filter by the user who acted (F4.2). */
  readonly actorUserId?: Types.ObjectId | undefined;
  readonly from?: Date | undefined;
  readonly to?: Date | undefined;
}

export type AuditEventRecord = Omit<AuditEventDoc, '_id'> & { readonly _id: Types.ObjectId };

/**
 * Reads the trail, newest first, paginated (Q9).
 *
 * `workspaceId` is always part of the filter, so one workspace's log can never
 * include another's entries (F1.6).
 */
export async function queryAuditEvents(
  query: AuditQuery,
  pagination: PaginationQuery,
): Promise<Paginated<AuditEventRecord>> {
  // Built as a plain object rather than a `FilterQuery<AuditEventDoc>`: the
  // document has two `Record<string, unknown>` fields (`before`, `after`) and
  // Mongoose's deep filter type cannot be instantiated over them.
  const filter: Record<string, unknown> = { workspaceId: query.workspaceId };

  if (query.types !== undefined && query.types.length > 0) {
    filter['type'] = { $in: [...query.types] };
  }
  if (query.actorUserId !== undefined) {
    filter['actorUserId'] = query.actorUserId;
  }
  if (query.from !== undefined || query.to !== undefined) {
    filter['at'] = {
      ...(query.from === undefined ? {} : { $gte: query.from }),
      ...(query.to === undefined ? {} : { $lte: query.to }),
    };
  }

  const [items, total] = await Promise.all([
    AuditEventModel.find(filter)
      .sort({ at: -1, _id: -1 })
      .skip(offsetFor(pagination))
      .limit(pagination.limit)
      .lean<AuditEventRecord[]>(),
    AuditEventModel.countDocuments(filter),
  ]);

  return paginate(items, pagination, total);
}
