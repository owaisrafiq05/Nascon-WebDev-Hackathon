import { offsetFor, paginate, type Paginated, type PaginationQuery } from '@ubmp/shared';
import type { ClientSession, Types } from 'mongoose';

import {
  ActivityModel,
  type ActivityDoc,
  type ActivityTarget,
  type ActivityType,
} from '../db/models/activity.js';

/**
 * Writing and reading the activity history (F2.7).
 *
 * Every service mutation records one entry, inside the same transaction as the
 * change where there is one, so the timeline cannot claim something that was
 * rolled back.
 */
export interface RecordActivityInput {
  readonly workspaceId: Types.ObjectId;
  readonly type: ActivityType;
  readonly targetKind: ActivityTarget;
  readonly targetId: Types.ObjectId;
  readonly contactId?: Types.ObjectId | null | undefined;
  readonly actor: {
    readonly membershipId?: Types.ObjectId | undefined;
    readonly userId?: Types.ObjectId | undefined;
    readonly label: string;
  };
  readonly summary: string;
  readonly payload?: Record<string, unknown> | undefined;
  readonly at?: Date | undefined;
}

export async function recordActivity(
  input: RecordActivityInput,
  session?: ClientSession,
): Promise<void> {
  await ActivityModel.create(
    [
      {
        workspaceId: input.workspaceId,
        type: input.type,
        targetKind: input.targetKind,
        targetId: input.targetId,
        contactId: input.contactId ?? null,
        actorMembershipId: input.actor.membershipId ?? null,
        actorUserId: input.actor.userId ?? null,
        actorLabel: input.actor.label,
        summary: input.summary,
        payload: input.payload ?? {},
        createdAt: input.at ?? new Date(),
      },
    ],
    session === undefined ? {} : { session, ordered: true },
  );
}

export type ActivityRecord = ActivityDoc;

/**
 * One record's timeline, newest first and paginated (F2.7, Q9).
 *
 * Asking for a contact returns its opportunities' entries too, which is what
 * makes the contact page a complete customer view (F2.8).
 */
export async function queryActivity(
  query: {
    readonly workspaceId: Types.ObjectId;
    readonly targetKind: ActivityTarget;
    readonly targetId: Types.ObjectId;
    readonly types?: readonly ActivityType[] | undefined;
  },
  pagination: PaginationQuery,
): Promise<Paginated<ActivityRecord>> {
  const filter: Record<string, unknown> =
    query.targetKind === 'contact'
      ? {
          workspaceId: query.workspaceId,
          // Either about the contact itself, or about something of theirs.
          $or: [{ targetKind: 'contact', targetId: query.targetId }, { contactId: query.targetId }],
        }
      : {
          workspaceId: query.workspaceId,
          targetKind: query.targetKind,
          targetId: query.targetId,
        };

  if (query.types !== undefined && query.types.length > 0) {
    filter['type'] = { $in: [...query.types] };
  }

  const [items, total] = await Promise.all([
    ActivityModel.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip(offsetFor(pagination))
      .limit(pagination.limit)
      .lean<ActivityRecord[]>(),
    ActivityModel.countDocuments(filter),
  ]);

  return paginate(items, pagination, total);
}
