import { model, Schema, type Types } from 'mongoose';

/**
 * "All messages with one contact on one channel, linked to the contact, its
 * assigned employee and, when applicable, an opportunity" (Section 7).
 */
export const CHANNELS = ['whatsapp', 'sms'] as const;
export type Channel = (typeof CHANNELS)[number];

export interface ConversationDoc {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  contactId: Types.ObjectId;
  channel: Channel;
  /** The customer's address on the channel, e.g. `whatsapp:+15551234567`. */
  address: string;
  assigneeMembershipId: Types.ObjectId | null;
  opportunityId: Types.ObjectId | null;
  lastMessageAt: Date | null;
  lastMessagePreview: string;
  unreadCount: number;
  createdAt: Date;
  updatedAt: Date;
}

const conversationSchema = new Schema<ConversationDoc>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true },
    contactId: { type: Schema.Types.ObjectId, ref: 'Contact', required: true },
    channel: { type: String, required: true, enum: CHANNELS },
    address: { type: String, required: true, maxlength: 64 },
    assigneeMembershipId: { type: Schema.Types.ObjectId, ref: 'Membership', default: null },
    opportunityId: { type: Schema.Types.ObjectId, ref: 'Opportunity', default: null },
    lastMessageAt: { type: Date, default: null },
    lastMessagePreview: { type: String, default: '', maxlength: 200 },
    unreadCount: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true },
);

conversationSchema.index({ workspaceId: 1, contactId: 1, channel: 1 }, { unique: true });
conversationSchema.index({ workspaceId: 1, lastMessageAt: -1 });
conversationSchema.index({ workspaceId: 1, assigneeMembershipId: 1, lastMessageAt: -1 });

export const ConversationModel = model<ConversationDoc>('Conversation', conversationSchema);
