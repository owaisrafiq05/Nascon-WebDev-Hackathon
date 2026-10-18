import { describe, expect, it } from 'vitest';

import {
  escalationCount,
  inPeriod,
  newLeadCount,
  paymentsReceived,
  upcomingAppointmentCount,
} from './metrics.js';

const period = { from: 1_000, to: 2_000 };

describe('inPeriod', () => {
  it('is half-open', () => {
    expect(inPeriod(1_000, period)).toBe(true);
    expect(inPeriod(1_999, period)).toBe(true);
    expect(inPeriod(2_000, period)).toBe(false);
    expect(inPeriod(999, period)).toBe(false);
  });
});

describe('newLeadCount (F5.1)', () => {
  it('counts leads created inside the period only', () => {
    expect(
      newLeadCount([{ createdAt: 500 }, { createdAt: 1_500 }, { createdAt: 2_500 }], period),
    ).toBe(1);
  });
});

describe('escalationCount (Section 7)', () => {
  it('counts automatic escalations and excludes manual and absence reassignments', () => {
    expect(
      escalationCount(
        [
          { at: 1_100, kind: 'escalation' },
          { at: 1_200, kind: 'manual' },
          { at: 1_300, kind: 'absence' },
          { at: 1_400, kind: 'escalation' },
          { at: 3_000, kind: 'escalation' },
        ],
        period,
      ),
    ).toBe(2);
  });
});

describe('upcomingAppointmentCount', () => {
  it('counts scheduled appointments from now on', () => {
    expect(
      upcomingAppointmentCount(
        [
          { startsAt: 100, status: 'scheduled' },
          { startsAt: 1_000, status: 'scheduled' },
          { startsAt: 5_000, status: 'cancelled' },
        ],
        1_000,
      ),
    ).toBe(1);
  });
});

describe('paymentsReceived (I2.6)', () => {
  const base = { currency: 'USD', confirmedByWebhook: true, refundedAmount: 0 } as const;

  it('sums confirmed payments paid within the period, net of refunds', () => {
    const result = paymentsReceived(
      [
        { ...base, status: 'paid', amount: 1_000, paidAt: 1_500 },
        { ...base, status: 'refunded', amount: 500, refundedAmount: 500, paidAt: 1_600 },
        { ...base, status: 'paid', amount: 9_000, paidAt: 5_000 },
        { ...base, status: 'pending', amount: 7_000, paidAt: null },
        { ...base, status: 'paid', amount: 300, paidAt: 1_700, confirmedByWebhook: false },
      ],
      period,
      { currency: 'USD' },
    );
    expect(result).toEqual({ gross: 1_500, refunded: 500, net: 1_000, paymentCount: 2 });
  });
});
