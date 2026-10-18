import { model, Schema, type Types } from 'mongoose';

/**
 * An external alert to an employee (F3.9, I4.1 - I4.4).
 *
 * Created in the same transaction as the escalation that causes it, so an
 * escalation never commits without its alert being owed. Delivery is a
 * scheduled job with limited retries; a failure stays here, visible to Admins
 * (I4.4).
 */
export const NOTIFICATION_STATUSES = ['pending', 'sent', 'failed', 'skipped'] as const;
export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];

export interface NotificationDoc {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  membershipId: Types.ObjectId;
  leadId: Types.ObjectId;
  channel: 'telegram';
  text: string;
  status: NotificationStatus;
  attempts: number;
  lastError: string | null;
  sentAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const notificationSchema = new Schema<NotificationDoc>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true },
    membershipId: { type: Schema.Types.ObjectId, ref: 'Membership', required: true },
    leadId: { type: Schema.Types.ObjectId, ref: 'Lead', required: true },
    channel: { type: String, required: true, enum: ['telegram'], default: 'telegram' },
    text: { type: String, required: true, maxlength: 4_000 },
    status: { type: String, required: true, enum: NOTIFICATION_STATUSES, default: 'pending' },
    attempts: { type: Number, default: 0, min: 0 },
    lastError: { type: String, default: null, maxlength: 1_000 },
    sentAt: { type: Date, default: null },
  },
  { timestamps: true },
);

notificationSchema.index({ workspaceId: 1, createdAt: -1 });
notificationSchema.index({ workspaceId: 1, status: 1, createdAt: -1 });

export const NotificationModel = model<NotificationDoc>('Notification', notificationSchema);
