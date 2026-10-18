import { AppError, ERROR_CODES } from '@ubmp/shared';
import type { ClientSession, Types } from 'mongoose';

import type { IntegrationsConfig } from '../config.js';
import { ContactModel, contactDisplayName } from '../db/models/contact.js';
import type { LeadDoc } from '../db/models/lead.js';
import { MembershipModel } from '../db/models/membership.js';
import { NotificationModel, type NotificationDoc } from '../db/models/notification.js';
import { providers } from '../integrations/registry.js';
import { recordIntegrationEvent } from '../repositories/integration-events.js';
import { scheduleJob } from '../repositories/job-queue.js';
import { notConnected, providerFailure, workspaceSecrets } from './integration-service.js';

/**
 * External escalation alerts over Telegram (F3.9, I4.1 - I4.4).
 */
export const NOTIFICATION_MAX_ATTEMPTS = 3;
export const NOTIFICATION_RETRY_DELAY_MS = 5_000;

const TARGET_WORDS: Record<string, string> = {
  next_eligible: 'the next available employee',
  backup: 'the designated backup',
  manager: 'the manager',
  assignee: 'the assignee',
};

/**
 * Owes an alert for an escalation. Called inside the escalation's transaction,
 * so the alert exists if and only if the escalation committed.
 */
export async function queueEscalationAlert(
  input: {
    readonly lead: LeadDoc;
    readonly newOwner: Types.ObjectId;
    readonly level: number;
    readonly target: string;
    readonly assignmentVersion: number;
  },
  session: ClientSession,
): Promise<void> {
  const { lead } = input;
  const contact =
    lead.contactId === null
      ? null
      : await ContactModel.findById(lead.contactId)
          .select('firstName lastName')
          .session(session)
          .lean();
  const name = contact === null ? 'A lead' : contactDisplayName(contact);

  const text = [
    `Lead escalated to you: ${name}`,
    `Source: ${lead.sourceLabel}`,
    `Reason: not acknowledged within the window; moved to ${TARGET_WORDS[input.target] ?? input.target} (level ${String(input.level)}, escalation ${String(lead.escalationCount + 1)}).`,
  ].join('\n');

  const [notification] = await NotificationModel.create(
    [
      {
        workspaceId: lead.workspaceId,
        membershipId: input.newOwner,
        leadId: lead._id,
        text,
        status: 'pending',
      },
    ],
    { session, ordered: true },
  );
  if (notification === undefined) throw new Error('notification not created');

  await scheduleJob(
    {
      workspaceId: lead.workspaceId,
      type: 'notification.send',
      targetId: notification._id,
      runAt: new Date(),
      idempotencyKey: `notification.send:${lead._id.toString()}:v${String(input.assignmentVersion)}`,
      payload: { notificationId: notification._id.toString() },
    },
    session,
  );
}

/** The link that opens the lead (I4.2). */
export function leadLink(config: IntegrationsConfig, leadId: string): string {
  return `${config.webAppUrl}/leads?lead=${leadId}`;
}

export type DeliveryOutcome = 'sent' | 'skipped' | 'retry' | 'failed' | 'already_sent';

/**
 * Delivers one alert. A failure is recorded on the notification and retried up
 * to `NOTIFICATION_MAX_ATTEMPTS` times; after that it stays `failed`, visible
 * to Admins on the integrations page (I4.4). An employee with no chat id, or a
 * workspace with no bot, is `skipped` with the reason, not retried.
 */
export async function deliverNotification(
  notificationId: Types.ObjectId,
  config: IntegrationsConfig,
): Promise<DeliveryOutcome> {
  const notification = await NotificationModel.findById(notificationId).lean();
  if (notification === null) return 'skipped';
  if (notification.status === 'sent') return 'already_sent';

  const skip = async (reason: string): Promise<DeliveryOutcome> => {
    await NotificationModel.updateOne(
      { _id: notification._id },
      { $set: { status: 'skipped', lastError: reason } },
    );
    return 'skipped';
  };

  const membership = await MembershipModel.findOne({
    _id: notification.membershipId,
    workspaceId: notification.workspaceId,
  }).lean();
  if (membership === null) return skip('The employee no longer exists.');
  if (membership.telegramChatId === null || membership.telegramChatId === '') {
    return skip('The employee has not set a Telegram chat id.');
  }

  const telegram = await workspaceSecrets(
    notification.workspaceId,
    'telegram',
    config.encryptionKey,
  );
  if (telegram === null) return skip('Telegram is not connected for this workspace.');

  const text = `${notification.text}\nOpen: ${leadLink(config, notification.leadId.toString())}`;
  const attempts = notification.attempts + 1;

  try {
    const sent = await providers().notifications.send(
      telegram.values['botToken'] ?? '',
      membership.telegramChatId,
      text,
    );
    await NotificationModel.updateOne(
      { _id: notification._id },
      { $set: { status: 'sent', sentAt: new Date(), lastError: null, attempts } },
    );
    await recordIntegrationEvent({
      workspaceId: notification.workspaceId,
      provider: 'telegram',
      direction: 'outbound',
      kind: 'api.send_alert',
      result: 'ok',
      reference: sent.messageId,
    });
    return 'sent';
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const final = attempts >= NOTIFICATION_MAX_ATTEMPTS;
    await NotificationModel.updateOne(
      { _id: notification._id },
      { $set: { status: final ? 'failed' : 'pending', lastError: message, attempts } },
    );
    await recordIntegrationEvent({
      workspaceId: notification.workspaceId,
      provider: 'telegram',
      direction: 'outbound',
      kind: 'api.send_alert',
      result: 'error',
      reference: notification._id.toString(),
      error,
    });
    return final ? 'failed' : 'retry';
  }
}

export async function sendTestAlert(
  workspaceId: Types.ObjectId,
  membershipId: Types.ObjectId,
  config: IntegrationsConfig,
): Promise<void> {
  const membership = await MembershipModel.findOne({ _id: membershipId, workspaceId }).lean();
  if (membership?.telegramChatId === null || membership?.telegramChatId === undefined) {
    throw new AppError(ERROR_CODES.CONFLICT, 'Set your Telegram chat id first.');
  }
  const telegram = await workspaceSecrets(workspaceId, 'telegram', config.encryptionKey);
  if (telegram === null) throw notConnected('Telegram');
  try {
    await providers().notifications.send(
      telegram.values['botToken'] ?? '',
      membership.telegramChatId,
      'Test alert: escalation alerts will arrive here.',
    );
    await recordIntegrationEvent({
      workspaceId,
      provider: 'telegram',
      direction: 'outbound',
      kind: 'api.send_test',
      result: 'ok',
    });
  } catch (error) {
    await recordIntegrationEvent({
      workspaceId,
      provider: 'telegram',
      direction: 'outbound',
      kind: 'api.send_test',
      result: 'error',
      error,
    });
    throw providerFailure(error, 'Telegram refused the test alert');
  }
}

export function notificationView(notification: NotificationDoc, email: string | null) {
  return {
    id: notification._id.toString(),
    membershipId: notification.membershipId.toString(),
    memberEmail: email,
    leadId: notification.leadId.toString(),
    status: notification.status,
    attempts: notification.attempts,
    lastError: notification.lastError,
    sentAt: notification.sentAt?.toISOString() ?? null,
    createdAt: notification.createdAt.toISOString(),
    text: notification.text,
  };
}
