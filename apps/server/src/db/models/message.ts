import { model, Schema, type Types } from 'mongoose';

/**
 * One message in a conversation (I1.1 - I1.8).
 *
 * `providerMessageId` (the Twilio SID) is unique per workspace, so a webhook
 * delivered twice inserts once (I1.8). `status` follows the provider's
 * callbacks (I1.4); a failed send keeps its reason and can be retried (I1.7).
 */
export const MESSAGE_DIRECTIONS = ['inbound', 'outbound'] as const;
export const MESSAGE_STATUSES = [
  'received',
  'queued',
  'sending',
  'sent',
  'delivered',
  'read',
  'failed',
  'undelivered',
] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

export interface MessageDoc {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  conversationId: Types.ObjectId;
  contactId: Types.ObjectId;
  direction: (typeof MESSAGE_DIRECTIONS)[number];
  body: string;
  status: MessageStatus;
  providerMessageId: string | null;
  failureReason: string | null;
  failureCode: string | null;
  attempts: number;
  sentByMembershipId: Types.ObjectId | null;
  statusUpdatedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const messageSchema = new Schema<MessageDoc>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true },
    conversationId: { type: Schema.Types.ObjectId, ref: 'Conversation', required: true },
    contactId: { type: Schema.Types.ObjectId, ref: 'Contact', required: true },
    direction: { type: String, required: true, enum: MESSAGE_DIRECTIONS },
    body: { type: String, required: true, maxlength: 1_600 },
    status: { type: String, required: true, enum: MESSAGE_STATUSES },
    providerMessageId: { type: String, default: null, maxlength: 64 },
    failureReason: { type: String, default: null, maxlength: 500 },
    failureCode: { type: String, default: null, maxlength: 32 },
    attempts: { type: Number, default: 0, min: 0 },
    sentByMembershipId: { type: Schema.Types.ObjectId, ref: 'Membership', default: null },
    statusUpdatedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

messageSchema.index({ workspaceId: 1, conversationId: 1, createdAt: 1 });
messageSchema.index(
  { workspaceId: 1, providerMessageId: 1 },
  { unique: true, partialFilterExpression: { providerMessageId: { $type: 'string' } } },
);

export const MessageModel = model<MessageDoc>('Message', messageSchema);
