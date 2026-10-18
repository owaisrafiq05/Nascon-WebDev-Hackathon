import { ALL_AUDIT_EVENT_TYPES, type AuditEventType } from '@ubmp/domain';
import { model, Schema, type Types } from 'mongoose';

/**
 * The append-only audit trail (F4.1, F4.3).
 *
 * Tamper resistance is enforced in three places, because one of them alone would
 * be easy to work around later:
 *   1. the repository exposes only `append` and query methods, with no update or
 *      delete at all (`apps/server/src/repositories/audit-repository.ts`)
 *   2. the router mounts only GET routes
 *   3. the schema below blocks document-level writes through Mongoose
 */
export interface AuditEventDoc {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  type: AuditEventType;
  at: Date;
  /** `system` when the platform acted on its own, e.g. an escalation (F4.1). */
  actorKind: 'user' | 'system';
  actorUserId: Types.ObjectId | null;
  actorMembershipId: Types.ObjectId | null;
  /** Readable at the time of the event, so the log survives a rename. */
  actorLabel: string;
  targetKind: string;
  targetId: string | null;
  targetLabel: string;
  /** Previous and next values, where a change has them (F4.1). */
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  /** Correlates the entry with the request that caused it. */
  requestId: string | null;
}

const auditEventSchema = new Schema<AuditEventDoc>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true },
    type: { type: String, required: true, enum: ALL_AUDIT_EVENT_TYPES },
    at: { type: Date, required: true, default: () => new Date() },
    actorKind: { type: String, required: true, enum: ['user', 'system'] },
    actorUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    actorMembershipId: { type: Schema.Types.ObjectId, ref: 'Membership', default: null },
    actorLabel: { type: String, required: true, maxlength: 320 },
    targetKind: { type: String, required: true, maxlength: 64 },
    targetId: { type: String, default: null, maxlength: 64 },
    targetLabel: { type: String, default: '', maxlength: 320 },
    before: { type: Schema.Types.Mixed, default: null },
    after: { type: Schema.Types.Mixed, default: null },
    requestId: { type: String, default: null, maxlength: 64 },
  },
  // No timestamps: `at` is the event time and nothing may change afterwards, so
  // an `updatedAt` would be a field that must never move.
  { timestamps: false, strict: true },
);

// The viewer's filters: by date, by event type, and by actor (F4.2).
auditEventSchema.index({ workspaceId: 1, at: -1 });
auditEventSchema.index({ workspaceId: 1, type: 1, at: -1 });
auditEventSchema.index({ workspaceId: 1, actorUserId: 1, at: -1 });

/**
 * Refuses any write that is not an insert, so even a mistaken `save()` on a
 * loaded entry fails loudly rather than rewriting history (F4.3).
 *
 * Written as rejecting async hooks rather than the callback style, which is what
 * Mongoose 9 expects.
 */
const APPEND_ONLY_MESSAGE = 'Audit events are append-only and cannot be modified or removed.';

function refuseMutation(): Promise<never> {
  return Promise.reject(new Error(APPEND_ONLY_MESSAGE));
}

for (const hook of [
  'updateOne',
  'updateMany',
  'findOneAndUpdate',
  'replaceOne',
  'deleteOne',
  'deleteMany',
  'findOneAndDelete',
] as const) {
  // `{ query: true, document: false }`: the guard belongs on the query form, so
  // it fires for `Model.updateOne(...)` rather than only on a loaded document.
  auditEventSchema.pre(hook, { query: true, document: false }, refuseMutation);
}

// An insert is the one permitted write. Anything else on a loaded document is
// an attempt to rewrite an existing entry.
auditEventSchema.pre('save', function () {
  return this.isNew ? Promise.resolve() : Promise.reject(new Error(APPEND_ONLY_MESSAGE));
});

export const AuditEventModel = model<AuditEventDoc>('AuditEvent', auditEventSchema);
