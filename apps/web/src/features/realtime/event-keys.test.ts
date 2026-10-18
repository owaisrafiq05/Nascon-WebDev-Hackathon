import { describe, expect, it } from 'vitest';

import { personalNotice, queryKeysForEvent } from './event-keys.js';

describe('realtime events (P5)', () => {
  it('always refreshes the dashboard', () => {
    expect(queryKeysForEvent('payment.updated')).toContainEqual(['dashboard']);
  });

  it('maps lead events to the inbox and recovery queue', () => {
    const keys = queryKeysForEvent('lead.escalated');
    expect(keys).toContainEqual(['leads']);
    expect(keys).toContainEqual(['recovery-queue']);
  });

  it('maps message and appointment events to their lists', () => {
    expect(queryKeysForEvent('message.received')).toContainEqual(['conversations']);
    expect(queryKeysForEvent('appointment.updated')).toContainEqual(['appointments']);
  });

  it('announces only personal lead events', () => {
    expect(personalNotice({ type: 'lead.assigned', personal: true })).toBe(
      'A lead was assigned to you.',
    );
    expect(personalNotice({ type: 'lead.escalated', personal: true })).toContain('escalated');
    expect(personalNotice({ type: 'lead.assigned' })).toBeNull();
    expect(personalNotice({ type: 'message.received', personal: true })).toBeNull();
  });
});
