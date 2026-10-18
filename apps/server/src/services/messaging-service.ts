import { PERMISSIONS } from '@ubmp/domain';
import { AppError, ERROR_CODES, notFound } from '@ubmp/shared';
import mongoose, { type ClientSession, Types } from 'mongoose';

import type { IntegrationsConfig } from '../config.js';
import { ContactModel, contactDisplayName, type ContactDoc } from '../db/models/contact.js';
import {
  ConversationModel,
  type Channel,
  type ConversationDoc,
} from '../db/models/conversation.js';
import type { IntegrationDoc } from '../db/models/integration.js';
import { LeadModel } from '../db/models/lead.js';
import { MessageModel, type MessageDoc, type MessageStatus } from '../db/models/message.js';
import { ProviderError, withRetry } from '../integrations/http.js';
import { providers } from '../integrations/registry.js';
import { recordActivity } from '../repositories/activity-repository.js';
import { claimProviderEvent, recordIntegrationEvent } from '../repositories/integration-events.js';
import { appendOutbox } from '../repositories/outbox.js';
import type { Actor } from './crm-service.js';
import { webhookUrls, workspaceSecrets, notConnected } from './integration-service.js';
import {
  acknowledgeOnRecordedAction,
  createLeadInSession,
  membershipLabels,
} from './lead-service.js';
import type { AuthContext } from './session-service.js';

/**
 * Messaging (I1.1 - I1.9) over the workspace's Twilio connection.
 */

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

/** `whatsapp:+1 (555) 123-4567` -> `{ channel: 'whatsapp', phone: '+15551234567' }`. */
export function parseAddress(address: string): { channel: Channel; phone: string } {
  const channel: Channel = address.startsWith('whatsapp:') ? 'whatsapp' : 'sms';
  const raw = address.replace(/^whatsapp:/, '');
  const digits = raw.replace(/[^\d]/g, '');
  return { channel, phone: `+${digits}` };
}

export function addressFor(channel: Channel, phone: string): string {
  const { phone: normalized } = parseAddress(phone);
  return channel === 'whatsapp' ? `whatsapp:${normalized}` : normalized;
}

/** Phones are stored as typed; match on the digits so `+1 555…` finds `+1555…`. */
async function findContactByPhone(
  workspaceId: Types.ObjectId,
  phone: string,
  session: ClientSession,
): Promise<ContactDoc | null> {
  const digits = phone.replace(/[^\d]/g, '');
  if (digits.length < 6) return null;
  // Every non-digit between digits is optional, so formatting does not matter.
  const pattern = `^\\+?${digits.split('').join('[^\\d]*')}$`;
  return ContactModel.findOne({ workspaceId, phone: { $regex: pattern } })
    .sort({ createdAt: 1 })
    .session(session)
    .lean();
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export function messageView(message: MessageDoc) {
  return {
    id: message._id.toString(),
    conversationId: message.conversationId.toString(),
    direction: message.direction,
    body: message.body,
    status: message.status,
    failureReason: message.failureReason,
    failureCode: message.failureCode,
    attempts: message.attempts,
    sentByMembershipId: message.sentByMembershipId?.toString() ?? null,
    createdAt: message.createdAt.toISOString(),
    statusUpdatedAt: message.statusUpdatedAt?.toISOString() ?? null,
  };
}

export function conversationView(
  conversation: ConversationDoc,
  contact: Pick<ContactDoc, 'firstName' | 'lastName' | 'optedOutOfMessaging'> | null,
  assigneeEmail: string | null,
) {
  return {
    id: conversation._id.toString(),
    contactId: conversation.contactId.toString(),
    contactName: contact === null ? '(deleted contact)' : contactDisplayName(contact),
    channel: conversation.channel,
    address: conversation.address,
    assigneeMembershipId: conversation.assigneeMembershipId?.toString() ?? null,
    assigneeEmail,
    lastMessageAt: conversation.lastMessageAt?.toISOString() ?? null,
    lastMessagePreview: conversation.lastMessagePreview,
    optedOut: contact?.optedOutOfMessaging ?? false,
  };
}

/**
 * Conversation visibility (I1.6): a member who manages members sees every
 * conversation; anyone else only those assigned to them. Same rule as leads.
 */
export function canSeeAllConversations(auth: AuthContext): boolean {
  return auth.permissions.has(PERMISSIONS.MEMBERS_MANAGE);
}

export async function findVisibleConversation(
  auth: AuthContext,
  conversationId: string,
): Promise<ConversationDoc> {
  if (!Types.ObjectId.isValid(conversationId)) throw notFound('That conversation does not exist.');
  const conversation = await ConversationModel.findOne({
    _id: new Types.ObjectId(conversationId),
    workspaceId: auth.workspaceId,
    ...(canSeeAllConversations(auth) ? {} : { assigneeMembershipId: auth.membershipId }),
  }).lean();
  // Another member's conversation reads as missing, like another workspace's.
  if (conversation === null) throw notFound('That conversation does not exist.');
  return conversation;
}

export async function conversationViews(
  workspaceId: Types.ObjectId,
  conversations: readonly ConversationDoc[],
) {
  const [contacts, labels] = await Promise.all([
    ContactModel.find({ workspaceId, _id: { $in: conversations.map((entry) => entry.contactId) } })
      .select('firstName lastName optedOutOfMessaging')
      .lean(),
    membershipLabels(workspaceId),
  ]);
  const byId = new Map(contacts.map((entry) => [entry._id.toString(), entry]));
  return conversations.map((conversation) =>
    conversationView(
      conversation,
      byId.get(conversation.contactId.toString()) ?? null,
      conversation.assigneeMembershipId === null
        ? null
        : (labels.get(conversation.assigneeMembershipId.toString())?.email ?? null),
    ),
  );
}

// ---------------------------------------------------------------------------
// Inbound (I1.1, I1.5, I1.8)
// ---------------------------------------------------------------------------

export interface InboundResult {
  readonly outcome: 'stored' | 'duplicate';
  readonly messageId?: string;
  readonly leadId?: string | null;
}

/**
 * Files an inbound message, already signature-verified by the caller.
 *
 * Everything happens in one transaction: claiming the MessageSid, creating the
 * contact and lead for an unknown number, the conversation and the message. A
 * second delivery of the same webhook finds the claim and stores nothing
 * (I1.8); a failure rolls back the claim so Twilio's retry is processed.
 */
export async function receiveInboundMessage(
  integration: IntegrationDoc,
  params: Record<string, string>,
): Promise<InboundResult> {
  const workspaceId = integration.workspaceId;
  const messageSid = params['MessageSid'] ?? params['SmsSid'] ?? '';
  const from = params['From'] ?? '';
  const body = (params['Body'] ?? '').slice(0, 1_600);
  if (messageSid === '' || from === '') {
    throw new AppError(ERROR_CODES.BAD_REQUEST, 'The webhook was missing MessageSid or From.');
  }

  const { channel, phone } = parseAddress(from);
  const session = await mongoose.startSession();
  try {
    let result: InboundResult = { outcome: 'duplicate' };

    await session.withTransaction(async () => {
      const claimed = await claimProviderEvent(
        {
          workspaceId,
          provider: 'twilio',
          kind: 'webhook.message_received',
          providerEventId: `message:${messageSid}`,
          reference: messageSid,
        },
        session,
      );
      if (!claimed) {
        result = { outcome: 'duplicate' };
        return;
      }

      let contact = await findContactByPhone(workspaceId, phone, session);
      let leadId: Types.ObjectId | null = null;

      if (contact === null) {
        // Unknown number: a new contact and a lead, labelled by source (I1.5, F3.1).
        const profileName = (params['ProfileName'] ?? '').trim();
        const created = await createLeadInSession(
          {
            workspaceId,
            source: 'messaging',
            sourceLabel: channel === 'whatsapp' ? 'WhatsApp message' : 'SMS message',
            contact: { firstName: profileName === '' ? phone : profileName, phone },
            actor: null,
          },
          session,
        );
        leadId = created.leadId;
        if (created.contactId !== null) {
          contact = await ContactModel.findById(created.contactId).session(session).lean();
        }
      }
      if (contact === null) throw new Error('inbound message has no contact');

      // Owner: the contact's owner, else the assignee of their newest open lead.
      const openLead = await LeadModel.findOne({
        workspaceId,
        contactId: contact._id,
        status: 'open',
      })
        .sort({ createdAt: -1 })
        .session(session)
        .lean();
      const assignee = contact.ownerMembershipId ?? openLead?.assigneeMembershipId ?? null;

      const now = new Date();
      const conversation = await ConversationModel.findOneAndUpdate(
        { workspaceId, contactId: contact._id, channel },
        {
          $setOnInsert: {
            workspaceId,
            contactId: contact._id,
            channel,
            address: addressFor(channel, phone),
          },
          $set: {
            lastMessageAt: now,
            lastMessagePreview: body.slice(0, 200),
            ...(assignee === null ? {} : { assigneeMembershipId: assignee }),
          },
          $inc: { unreadCount: 1 },
        },
        { upsert: true, returnDocument: 'after', session },
      ).lean();
      if (conversation === null) throw new Error('conversation upsert failed');

      const [message] = await MessageModel.create(
        [
          {
            workspaceId,
            conversationId: conversation._id,
            contactId: contact._id,
            direction: 'inbound',
            body: body === '' ? '(empty message)' : body,
            status: 'received',
            providerMessageId: messageSid,
            statusUpdatedAt: now,
          },
        ],
        { session, ordered: true },
      );
      if (message === undefined) throw new Error('message not created');

      // A customer replying STOP opts out, as carriers expect (I1.9).
      if (/^\s*(stop|unsubscribe|stopall|cancel|end|quit)\s*$/i.test(body)) {
        await ContactModel.updateOne(
          { _id: contact._id, workspaceId },
          { $set: { optedOutOfMessaging: true } },
          { session },
        );
      }

      await recordActivity(
        {
          workspaceId,
          type: 'message.received',
          targetKind: 'contact',
          targetId: contact._id,
          contactId: contact._id,
          actor: { label: `${contactDisplayName(contact)} (${channel})` },
          summary: `Message received: ${body.slice(0, 100)}`,
          payload: {
            conversationId: conversation._id.toString(),
            messageId: message._id.toString(),
          },
        },
        session,
      );

      await appendOutbox(
        workspaceId,
        'message.received',
        { conversationId: conversation._id.toString(), messageId: message._id.toString() },
        conversation.assigneeMembershipId,
        session,
      );

      result = {
        outcome: 'stored',
        messageId: message._id.toString(),
        leadId: leadId?.toString() ?? null,
      };
    });

    return result;
  } finally {
    await session.endSession();
  }
}

// ---------------------------------------------------------------------------
// Status callbacks (I1.4)
// ---------------------------------------------------------------------------

const STATUS_RANK: Record<MessageStatus, number> = {
  received: 0,
  queued: 1,
  sending: 2,
  sent: 3,
  delivered: 4,
  read: 5,
  failed: 6,
  undelivered: 6,
};

const TWILIO_STATUSES = new Set<MessageStatus>([
  'queued',
  'sending',
  'sent',
  'delivered',
  'read',
  'failed',
  'undelivered',
]);

/**
 * Applies a delivery status callback. Callbacks can arrive out of order, so a
 * status only moves forward: a late `sent` never overwrites `delivered`.
 */
export async function applyStatusCallback(
  integration: IntegrationDoc,
  params: Record<string, string>,
): Promise<'updated' | 'ignored' | 'duplicate'> {
  const sid = params['MessageSid'] ?? params['SmsSid'] ?? '';
  const status = (params['MessageStatus'] ?? params['SmsStatus'] ?? '') as MessageStatus;
  if (sid === '' || !TWILIO_STATUSES.has(status)) return 'ignored';

  const session = await mongoose.startSession();
  try {
    let outcome: 'updated' | 'ignored' | 'duplicate' = 'ignored';
    await session.withTransaction(async () => {
      const claimed = await claimProviderEvent(
        {
          workspaceId: integration.workspaceId,
          provider: 'twilio',
          kind: 'webhook.message_status',
          providerEventId: `status:${sid}:${status}`,
          reference: sid,
        },
        session,
      );
      if (!claimed) {
        outcome = 'duplicate';
        return;
      }

      const message = await MessageModel.findOne({
        workspaceId: integration.workspaceId,
        providerMessageId: sid,
      })
        .session(session)
        .lean();
      if (message === null || STATUS_RANK[status] <= STATUS_RANK[message.status]) {
        outcome = 'ignored';
        return;
      }

      const errorCode = params['ErrorCode'] ?? '';
      await MessageModel.updateOne(
        { _id: message._id },
        {
          $set: {
            status,
            statusUpdatedAt: new Date(),
            ...(status === 'failed' || status === 'undelivered'
              ? {
                  failureCode: errorCode === '' ? null : errorCode,
                  failureReason: twilioErrorReason(errorCode, params['ErrorMessage']),
                }
              : {}),
          },
        },
        { session },
      );
      await appendOutbox(
        integration.workspaceId,
        'message.updated',
        { conversationId: message.conversationId.toString(), messageId: message._id.toString() },
        message.sentByMembershipId,
        session,
      );
      outcome = 'updated';
    });
    return outcome;
  } finally {
    await session.endSession();
  }
}

/** Twilio error codes in words a salesperson can act on (I1.7). */
export function twilioErrorReason(code: string, fallback?: string): string {
  const known: Record<string, string> = {
    '63016':
      'WhatsApp refused a free-form message outside the 24-hour window. The customer must message first.',
    '63015': 'This phone has not joined the WhatsApp sandbox. Ask them to send the join phrase.',
    '63003': 'The number is not a valid WhatsApp address.',
    '21211': 'The phone number is not valid.',
    '21610': 'The recipient has unsubscribed (replied STOP) on this number.',
    '30003': 'The phone is unreachable or switched off.',
    '30005': 'The number does not exist.',
    '30006': 'The number cannot receive this kind of message.',
    '30007': 'The carrier filtered the message as spam.',
  };
  return (
    known[code] ??
    fallback ??
    (code === '' ? 'The provider reported a failure.' : `Provider error ${code}.`)
  );
}

// ---------------------------------------------------------------------------
// Sending (I1.3, I1.7, I1.9)
// ---------------------------------------------------------------------------

function optedOutError(): AppError {
  return new AppError(ERROR_CODES.CONFLICT, 'This contact has opted out of messaging.', {
    hint: 'They asked not to be messaged. Remove the opt-out only if they ask to be contacted again.',
    details: { reason: 'opted_out' },
  });
}

/**
 * Attempts delivery of an outbound message row through the provider.
 *
 * Temporary provider errors are retried with a delay (I5.5). If the send still
 * fails, the message stays visible as failed with the reason and can be
 * retried by the employee (I1.7); nothing is dropped.
 */
async function deliver(
  message: MessageDoc,
  conversation: ConversationDoc,
  config: IntegrationsConfig,
): Promise<MessageDoc> {
  const twilio = await workspaceSecrets(message.workspaceId, 'twilio', config.encryptionKey);

  const fail = async (reason: string, code: string | null, error: unknown) => {
    await recordIntegrationEvent({
      workspaceId: message.workspaceId,
      provider: 'twilio',
      direction: 'outbound',
      kind: 'api.send_message',
      result: 'error',
      reference: message._id.toString(),
      error,
    });
    return MessageModel.findOneAndUpdate(
      { _id: message._id },
      {
        $set: {
          status: 'failed',
          failureReason: reason,
          failureCode: code,
          statusUpdatedAt: new Date(),
        },
        $inc: { attempts: 1 },
      },
      { returnDocument: 'after' },
    ).lean();
  };

  if (twilio === null) {
    const updated = await fail(
      'Messaging is not connected for this workspace.',
      'not_connected',
      'not connected',
    );
    return updated ?? message;
  }

  const statusCallback =
    webhookUrls(config, 'twilio', twilio.integration.webhookKey)['status'] ?? null;

  try {
    const sent = await withRetry(() =>
      providers().messaging.send(
        {
          accountSid: twilio.values['accountSid'] ?? '',
          authToken: twilio.values['authToken'] ?? '',
          from: twilio.values['from'] ?? '',
        },
        {
          to: conversation.address,
          body: message.body,
          statusCallbackUrl: statusCallback,
        },
      ),
    );

    await recordIntegrationEvent({
      workspaceId: message.workspaceId,
      provider: 'twilio',
      direction: 'outbound',
      kind: 'api.send_message',
      result: 'ok',
      reference: sent.providerMessageId,
    });

    const status = TWILIO_STATUSES.has(sent.status as MessageStatus)
      ? (sent.status as MessageStatus)
      : 'queued';
    const updated = await MessageModel.findOneAndUpdate(
      { _id: message._id },
      {
        $set: {
          status,
          providerMessageId: sent.providerMessageId,
          failureReason: null,
          failureCode: null,
          statusUpdatedAt: new Date(),
        },
        $inc: { attempts: 1 },
      },
      { returnDocument: 'after' },
    ).lean();
    return updated ?? message;
  } catch (error) {
    const providerError = error instanceof ProviderError ? error : null;
    const code = providerError?.providerCode ?? null;
    const reason =
      providerError === null
        ? 'The message could not be sent.'
        : providerError.transient
          ? `Twilio is temporarily unavailable (${providerError.message}). Try again shortly.`
          : twilioErrorReason(code ?? '', providerError.message);
    const updated = await fail(reason, code, error);
    return updated ?? message;
  }
}

export async function sendMessage(input: {
  readonly auth: AuthContext;
  readonly conversation: ConversationDoc;
  readonly body: string;
  readonly actor: Actor;
  readonly config: IntegrationsConfig;
}): Promise<MessageDoc> {
  const { auth, conversation } = input;
  const contact = await ContactModel.findOne({
    _id: conversation.contactId,
    workspaceId: auth.workspaceId,
  }).lean();
  if (contact === null) throw notFound('That contact does not exist.');
  if (contact.optedOutOfMessaging) throw optedOutError();

  const connected = await workspaceSecrets(auth.workspaceId, 'twilio', input.config.encryptionKey);
  if (connected === null) throw notConnected('Messaging');

  const [message] = await MessageModel.create([
    {
      workspaceId: auth.workspaceId,
      conversationId: conversation._id,
      contactId: contact._id,
      direction: 'outbound',
      body: input.body,
      status: 'sending',
      sentByMembershipId: input.actor.membershipId,
    },
  ]);
  if (message === undefined) throw new Error('message not created');

  await ConversationModel.updateOne(
    { _id: conversation._id, workspaceId: auth.workspaceId },
    {
      $set: {
        lastMessageAt: new Date(),
        lastMessagePreview: input.body.slice(0, 200),
        unreadCount: 0,
        ...(conversation.assigneeMembershipId === null
          ? { assigneeMembershipId: input.actor.membershipId }
          : {}),
      },
    },
  );

  const delivered = await deliver(message.toObject(), conversation, input.config);

  await recordActivity({
    workspaceId: auth.workspaceId,
    type: 'message.sent',
    targetKind: 'contact',
    targetId: contact._id,
    contactId: contact._id,
    actor: input.actor,
    summary:
      delivered.status === 'failed'
        ? `Message failed: ${delivered.failureReason ?? 'unknown reason'}`
        : `Message sent: ${input.body.slice(0, 100)}`,
    payload: { conversationId: conversation._id.toString(), messageId: message._id.toString() },
  });

  await appendOutbox(
    auth.workspaceId,
    'message.updated',
    { conversationId: conversation._id.toString(), messageId: message._id.toString() },
    conversation.assigneeMembershipId,
  );

  if (delivered.status !== 'failed') {
    await acknowledgeOnRecordedAction(auth, contact._id, input.actor, 'a message');
  }

  return delivered;
}

/** Starts (or reuses) the conversation with a contact and sends the first message. */
export async function sendToContact(input: {
  readonly auth: AuthContext;
  readonly contactId: string;
  readonly body: string;
  readonly actor: Actor;
  readonly config: IntegrationsConfig;
}): Promise<{ conversation: ConversationDoc; message: MessageDoc }> {
  if (!Types.ObjectId.isValid(input.contactId)) throw notFound('That contact does not exist.');
  const contact = await ContactModel.findOne({
    _id: new Types.ObjectId(input.contactId),
    workspaceId: input.auth.workspaceId,
  }).lean();
  if (contact === null) throw notFound('That contact does not exist.');
  if (contact.optedOutOfMessaging) throw optedOutError();
  if (contact.phone === null || contact.phone.replace(/[^\d]/g, '').length < 6) {
    throw new AppError(ERROR_CODES.CONFLICT, 'This contact has no phone number to message.', {
      hint: 'Add a phone number in international format, such as +15551234567.',
    });
  }

  const twilio = await workspaceSecrets(
    input.auth.workspaceId,
    'twilio',
    input.config.encryptionKey,
  );
  if (twilio === null) throw notConnected('Messaging');
  const channel: Channel = (twilio.values['from'] ?? '').startsWith('whatsapp:')
    ? 'whatsapp'
    : 'sms';

  const conversation = await ConversationModel.findOneAndUpdate(
    { workspaceId: input.auth.workspaceId, contactId: contact._id, channel },
    {
      $setOnInsert: {
        workspaceId: input.auth.workspaceId,
        contactId: contact._id,
        channel,
        address: addressFor(channel, contact.phone),
        assigneeMembershipId: contact.ownerMembershipId ?? input.actor.membershipId,
      },
    },
    { upsert: true, returnDocument: 'after' },
  ).lean();
  if (conversation === null) throw new Error('conversation upsert failed');

  if (
    !canSeeAllConversations(input.auth) &&
    conversation.assigneeMembershipId !== null &&
    !conversation.assigneeMembershipId.equals(input.auth.membershipId)
  ) {
    throw new AppError(ERROR_CODES.FORBIDDEN, 'This conversation belongs to another employee.', {
      hint: 'Ask a manager to reassign the contact to you.',
    });
  }

  const message = await sendMessage({ ...input, conversation });
  return { conversation, message };
}

/** Re-sends a failed outbound message (I1.7). */
export async function retryMessage(
  auth: AuthContext,
  messageId: string,
  config: IntegrationsConfig,
): Promise<MessageDoc> {
  if (!Types.ObjectId.isValid(messageId)) throw notFound('That message does not exist.');
  const message = await MessageModel.findOne({
    _id: new Types.ObjectId(messageId),
    workspaceId: auth.workspaceId,
  }).lean();
  if (message === null) throw notFound('That message does not exist.');

  const conversation = await findVisibleConversation(auth, message.conversationId.toString());

  if (
    message.direction !== 'outbound' ||
    (message.status !== 'failed' && message.status !== 'undelivered')
  ) {
    throw new AppError(ERROR_CODES.CONFLICT, 'Only a failed message can be retried.');
  }

  const contact = await ContactModel.findOne({
    _id: message.contactId,
    workspaceId: auth.workspaceId,
  }).lean();
  if (contact?.optedOutOfMessaging === true) throw optedOutError();

  // Claimed by a conditional update, so a double click sends once.
  const claimed = await MessageModel.findOneAndUpdate(
    { _id: message._id, status: message.status },
    { $set: { status: 'sending', statusUpdatedAt: new Date() } },
    { returnDocument: 'after' },
  ).lean();
  if (claimed === null)
    throw new AppError(ERROR_CODES.CONFLICT, 'That message is already being retried.');

  const delivered = await deliver(claimed, conversation, config);
  await appendOutbox(
    auth.workspaceId,
    'message.updated',
    { conversationId: conversation._id.toString(), messageId },
    conversation.assigneeMembershipId,
  );
  return delivered;
}
