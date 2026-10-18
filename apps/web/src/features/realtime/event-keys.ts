import { z } from 'zod';

/** The one socket event the server emits (P5). Payloads carry ids only. */
export const realtimeEventSchema = z.object({
  type: z.string(),
  payload: z.record(z.string(), z.unknown()).optional(),
  personal: z.boolean().optional(),
});

export type RealtimeEvent = z.infer<typeof realtimeEventSchema>;

/**
 * Which cached queries an event makes stale. Query keys are prefixes, so
 * `['leads']` covers every filter and page of the inbox.
 */
export function queryKeysForEvent(type: string): string[][] {
  const keys: string[][] = [['dashboard']];

  if (type.startsWith('lead.')) {
    keys.push(['leads'], ['recovery-queue'], ['contact-view'], ['availability']);
  } else if (type.startsWith('message.')) {
    keys.push(['conversations'], ['messages'], ['contact-view']);
  } else if (type.startsWith('payment.')) {
    keys.push(['payments'], ['contact-view']);
  } else if (type.startsWith('appointment.')) {
    keys.push(['appointments'], ['contact-view']);
  } else if (type.startsWith('integration.')) {
    keys.push(['integrations'], ['integration-events'], ['notifications'], ['calendar']);
  } else if (type === 'availability.changed') {
    keys.push(['availability'], ['leads'], ['recovery-queue']);
  }

  return keys;
}

/** The toast text for an event addressed to this member, if any. */
export function personalNotice(event: RealtimeEvent): string | null {
  if (event.personal !== true) return null;
  if (event.type === 'lead.assigned') return 'A lead was assigned to you.';
  if (event.type === 'lead.escalated') return 'A lead was escalated to you.';
  return null;
}
