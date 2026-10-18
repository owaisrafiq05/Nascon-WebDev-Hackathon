import { describe, expect, it } from 'vitest';

import type { AvailabilityStatus, EmployeeAvailability } from './availability.js';
import {
  acknowledge,
  type AssignmentState,
  createAssignmentState,
  type EscalationConfig,
  escalationsDueSince,
  nextEscalation,
  reassignForAbsence,
  reassignManually,
} from './escalation.js';
import {
  availableEmployeeCount,
  averageTimeToFirstResponse,
  collectedRevenue,
  type LeadForRecovery,
  openPipelineValue,
  type OpportunityForPipeline,
  type PaymentRecord,
  projectedRevenue,
  RECOVERY_REASONS,
  recoveryQueue,
  recoveryQueueMembership,
  type RecoveryQueueConfig,
  timeToFirstResponse,
} from './metrics.js';

const T0 = 1_700_000_000_000;
const USD = { currency: 'USD' };

// ---------------------------------------------------------------------------
// timeToFirstResponse
// ---------------------------------------------------------------------------

describe('timeToFirstResponse', () => {
  it('measures from the first assignment to the first acknowledgement', () => {
    expect(timeToFirstResponse({ firstAssignedAt: T0, firstAcknowledgedAt: T0 + 90_000 })).toBe(
      90_000,
    );
  });

  it('is null while the lead has not been acknowledged', () => {
    expect(timeToFirstResponse({ firstAssignedAt: T0, firstAcknowledgedAt: null })).toBeNull();
  });

  it('is null for a lead that was never assigned', () => {
    expect(timeToFirstResponse({ firstAssignedAt: null, firstAcknowledgedAt: T0 })).toBeNull();
  });

  it('is zero for an immediate acknowledgement, not null', () => {
    expect(timeToFirstResponse({ firstAssignedAt: T0, firstAcknowledgedAt: T0 })).toBe(0);
  });

  it('excludes contradictory timestamps rather than returning a negative', () => {
    expect(
      timeToFirstResponse({ firstAssignedAt: T0, firstAcknowledgedAt: T0 - 1_000 }),
    ).toBeNull();
  });

  it('measures from the FIRST assignment, so escalation cannot flatter it', () => {
    // Escalated at +60s and acknowledged at +70s: the figure is 70s, not 10s.
    expect(timeToFirstResponse({ firstAssignedAt: T0, firstAcknowledgedAt: T0 + 70_000 })).toBe(
      70_000,
    );
  });
});

describe('averageTimeToFirstResponse', () => {
  it('averages only the leads that were acknowledged', () => {
    const result = averageTimeToFirstResponse([
      { firstAssignedAt: T0, firstAcknowledgedAt: T0 + 10_000 },
      { firstAssignedAt: T0, firstAcknowledgedAt: T0 + 30_000 },
      { firstAssignedAt: T0, firstAcknowledgedAt: null },
    ]);

    expect(result).toEqual({ averageMs: 20_000, sampleSize: 2, excluded: 1 });
  });

  it('is null with no leads at all', () => {
    expect(averageTimeToFirstResponse([])).toEqual({
      averageMs: null,
      sampleSize: 0,
      excluded: 0,
    });
  });

  it('is null when nothing has been acknowledged, not zero', () => {
    const result = averageTimeToFirstResponse([
      { firstAssignedAt: T0, firstAcknowledgedAt: null },
      { firstAssignedAt: T0, firstAcknowledgedAt: null },
    ]);

    expect(result.averageMs).toBeNull();
    expect(result.excluded).toBe(2);
  });

  it('does not count an unacknowledged lead as a fast response', () => {
    const withSlow = averageTimeToFirstResponse([
      { firstAssignedAt: T0, firstAcknowledgedAt: T0 + 60_000 },
      { firstAssignedAt: T0, firstAcknowledgedAt: null },
    ]);

    expect(withSlow.averageMs).toBe(60_000);
  });
});

// ---------------------------------------------------------------------------
// openPipelineValue
// ---------------------------------------------------------------------------

function opportunity(
  stageId: string,
  stageOutcome: OpportunityForPipeline['stageOutcome'],
  value: number,
  currency = 'USD',
): OpportunityForPipeline {
  return { stageId, stageOutcome, value, currency };
}

describe('openPipelineValue', () => {
  it('groups open opportunities by stage', () => {
    const result = openPipelineValue(
      [
        opportunity('qualify', 'open', 100_00),
        opportunity('qualify', 'open', 250_00),
        opportunity('proposal', 'open', 400_00),
      ],
      USD,
    );

    expect(result.byStage).toEqual([
      { stageId: 'proposal', total: 400_00, count: 1 },
      { stageId: 'qualify', total: 350_00, count: 2 },
    ]);
    expect(result.total).toBe(750_00);
    expect(result.count).toBe(3);
  });

  it('excludes won and lost opportunities', () => {
    const result = openPipelineValue(
      [
        opportunity('qualify', 'open', 100_00),
        opportunity('closed-won', 'won', 900_00),
        opportunity('closed-lost', 'lost', 500_00),
      ],
      USD,
    );

    expect(result.total).toBe(100_00);
    expect(result.byStage.map((stage) => stage.stageId)).toEqual(['qualify']);
  });

  it('is zero with no opportunities', () => {
    expect(openPipelineValue([], USD)).toEqual({ byStage: [], total: 0, count: 0 });
  });

  it('is zero when every opportunity is already won or lost', () => {
    const result = openPipelineValue(
      [opportunity('w', 'won', 900_00), opportunity('l', 'lost', 500_00)],
      USD,
    );

    expect(result).toEqual({ byStage: [], total: 0, count: 0 });
  });

  it('never adds another currency into the total', () => {
    const result = openPipelineValue(
      [opportunity('qualify', 'open', 100_00), opportunity('qualify', 'open', 999_00, 'EUR')],
      USD,
    );

    expect(result.total).toBe(100_00);
    expect(result.count).toBe(1);
  });

  it('counts a zero-value open opportunity in the count but not the total', () => {
    const result = openPipelineValue([opportunity('qualify', 'open', 0)], USD);

    expect(result).toEqual({
      byStage: [{ stageId: 'qualify', total: 0, count: 1 }],
      total: 0,
      count: 1,
    });
  });

  it('orders stages deterministically whatever the input order', () => {
    const a = openPipelineValue([opportunity('b', 'open', 1), opportunity('a', 'open', 1)], USD);
    const b = openPipelineValue([opportunity('a', 'open', 1), opportunity('b', 'open', 1)], USD);

    expect(a.byStage).toEqual(b.byStage);
    expect(a.byStage.map((stage) => stage.stageId)).toEqual(['a', 'b']);
  });
});

// ---------------------------------------------------------------------------
// collectedRevenue
// ---------------------------------------------------------------------------

function payment(overrides: Partial<PaymentRecord> = {}): PaymentRecord {
  return {
    status: 'paid',
    amount: 100_00,
    currency: 'USD',
    confirmedByWebhook: true,
    refundedAmount: 0,
    ...overrides,
  };
}

describe('collectedRevenue', () => {
  it('sums payments the provider webhook confirmed', () => {
    const result = collectedRevenue([payment(), payment({ amount: 50_00 })], USD);

    expect(result).toEqual({ gross: 150_00, refunded: 0, net: 150_00, paymentCount: 2 });
  });

  it('is zero with no payments', () => {
    expect(collectedRevenue([], USD)).toEqual({
      gross: 0,
      refunded: 0,
      net: 0,
      paymentCount: 0,
    });
  });

  it('ignores a paid payment the webhook has not confirmed (I2.6)', () => {
    const result = collectedRevenue([payment({ confirmedByWebhook: false })], USD);

    expect(result.net).toBe(0);
    expect(result.paymentCount).toBe(0);
  });

  it.each<PaymentRecord['status']>(['pending', 'expired', 'failed'])(
    'never counts a %s payment',
    (status) => {
      expect(collectedRevenue([payment({ status })], USD).net).toBe(0);
    },
  );

  it('subtracts a confirmed refund', () => {
    const result = collectedRevenue(
      [payment({ amount: 100_00, status: 'refunded', refundedAmount: 100_00 })],
      USD,
    );

    expect(result).toEqual({ gross: 100_00, refunded: 100_00, net: 0, paymentCount: 1 });
  });

  it('leaves the remainder after a partial refund', () => {
    const result = collectedRevenue(
      [payment({ amount: 100_00, status: 'refunded', refundedAmount: 30_00 })],
      USD,
    );

    expect(result.net).toBe(70_00);
  });

  it('nets a refund against other payments', () => {
    const result = collectedRevenue(
      [payment({ amount: 200_00 }), payment({ status: 'refunded', refundedAmount: 100_00 })],
      USD,
    );

    expect(result).toEqual({ gross: 300_00, refunded: 100_00, net: 200_00, paymentCount: 2 });
  });

  it('can go negative if refunds exceed receipts in the period', () => {
    const result = collectedRevenue(
      [payment({ amount: 10_00, status: 'refunded', refundedAmount: 50_00 })],
      USD,
    );

    expect(result.net).toBe(-40_00);
  });

  it('never adds another currency', () => {
    const result = collectedRevenue([payment(), payment({ currency: 'EUR', amount: 999_00 })], USD);

    expect(result.net).toBe(100_00);
  });
});

// ---------------------------------------------------------------------------
// projectedRevenue
// ---------------------------------------------------------------------------

describe('projectedRevenue', () => {
  it('adds open opportunities to payment requests not yet paid', () => {
    const result = projectedRevenue(
      [opportunity('qualify', 'open', 500_00)],
      [payment({ status: 'pending', amount: 200_00 })],
      USD,
    );

    expect(result).toEqual({
      openOpportunities: 500_00,
      unpaidRequests: 200_00,
      total: 700_00,
    });
  });

  it('is zero with nothing at all', () => {
    expect(projectedRevenue([], [], USD)).toEqual({
      openOpportunities: 0,
      unpaidRequests: 0,
      total: 0,
    });
  });

  it('excludes won and lost opportunities', () => {
    const result = projectedRevenue(
      [opportunity('w', 'won', 900_00), opportunity('l', 'lost', 400_00)],
      [],
      USD,
    );

    expect(result.openOpportunities).toBe(0);
  });

  it.each<PaymentRecord['status']>(['paid', 'expired', 'failed', 'refunded'])(
    'does not treat a %s payment as still expected',
    (status) => {
      expect(projectedRevenue([], [payment({ status })], USD).unpaidRequests).toBe(0);
    },
  );

  it('counts a pending request even when the webhook has not confirmed anything', () => {
    const result = projectedRevenue(
      [],
      [payment({ status: 'pending', confirmedByWebhook: false, amount: 75_00 })],
      USD,
    );

    expect(result.unpaidRequests).toBe(75_00);
  });

  it('reports the two halves separately, so overlap is visible (Q12)', () => {
    // One open opportunity that also has a pending request against it.
    const result = projectedRevenue(
      [opportunity('proposal', 'open', 100_00)],
      [payment({ status: 'pending', amount: 100_00 })],
      USD,
    );

    expect(result.openOpportunities).toBe(100_00);
    expect(result.unpaidRequests).toBe(100_00);
    expect(result.total).toBe(200_00);
  });

  it('is kept apart from collected revenue (I2.6)', () => {
    const payments = [payment({ amount: 100_00 }), payment({ status: 'pending', amount: 60_00 })];

    expect(collectedRevenue(payments, USD).net).toBe(100_00);
    expect(projectedRevenue([], payments, USD).unpaidRequests).toBe(60_00);
  });

  it('never adds another currency', () => {
    const result = projectedRevenue(
      [opportunity('q', 'open', 10_00, 'EUR')],
      [payment({ status: 'pending', currency: 'EUR', amount: 10_00 })],
      USD,
    );

    expect(result.total).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// recoveryQueueMembership
// ---------------------------------------------------------------------------

const escalation: EscalationConfig = {
  levels: [
    { target: 'assignee', acknowledgementWindowMs: 60_000 },
    { target: 'next_eligible', acknowledgementWindowMs: 60_000 },
    { target: 'backup', acknowledgementWindowMs: 60_000 },
    { target: 'manager', acknowledgementWindowMs: 60_000 },
  ],
};

const recovery: RecoveryQueueConfig = { minEscalations: 2, idlePeriodMs: 3_600_000 };
const config = { escalation, recovery };

function lead(overrides: Partial<LeadForRecovery> = {}): LeadForRecovery {
  return {
    leadId: 'lead-1',
    state: createAssignmentState(T0),
    createdAt: T0,
    lastRecordedActionAt: null,
    ...overrides,
  };
}

/** A state that has escalated `times` levels from T0. */
function escalatedState(times: number): AssignmentState {
  const steps = escalationsDueSince(createAssignmentState(T0), T0 + 10_000_000, escalation);
  const step = steps[times - 1];
  if (step === undefined) throw new Error(`cannot escalate ${String(times)} times`);
  return step;
}

describe('recoveryQueueMembership', () => {
  it('is empty for a lead still inside its window', () => {
    const result = recoveryQueueMembership(lead(), T0 + 30_000, config);

    expect(result).toEqual({ leadId: 'lead-1', inQueue: false, reasons: [] });
  });

  it('flags a lead unacknowledged beyond its window', () => {
    const result = recoveryQueueMembership(lead(), T0 + 60_001, config);

    expect(result.inQueue).toBe(true);
    expect(result.reasons).toContain(RECOVERY_REASONS.UNACKNOWLEDGED_BEYOND_WINDOW);
  });

  it('flags a lead that escalated twice or more', () => {
    const result = recoveryQueueMembership(
      lead({ state: escalatedState(2), lastRecordedActionAt: T0 + 100 }),
      T0 + 100_000,
      config,
    );

    expect(result.reasons).toContain(RECOVERY_REASONS.ESCALATED_REPEATEDLY);
  });

  it('does not flag a lead that escalated only once', () => {
    const once = escalatedState(1);
    const result = recoveryQueueMembership(
      lead({ state: once, lastRecordedActionAt: T0 + 100 }),
      // Inside level 1's window, so the overdue reason does not apply either.
      T0 + 70_000,
      config,
    );

    expect(result.reasons).not.toContain(RECOVERY_REASONS.ESCALATED_REPEATEDLY);
    expect(result.inQueue).toBe(false);
  });

  it('honours a configured escalation threshold other than two', () => {
    const result = recoveryQueueMembership(
      lead({ state: escalatedState(1), lastRecordedActionAt: T0 + 100 }),
      T0 + 70_000,
      { escalation, recovery: { ...recovery, minEscalations: 1 } },
    );

    expect(result.reasons).toContain(RECOVERY_REASONS.ESCALATED_REPEATEDLY);
  });

  it('flags a lead with no recorded action for the idle period', () => {
    const result = recoveryQueueMembership(lead(), T0 + 3_600_000, config);

    expect(result.reasons).toContain(RECOVERY_REASONS.IDLE_TOO_LONG);
  });

  it('measures idleness from the last action when there is one', () => {
    const recent = lead({ lastRecordedActionAt: T0 + 3_000_000 });
    const result = recoveryQueueMembership(recent, T0 + 3_600_000, config);

    expect(result.reasons).not.toContain(RECOVERY_REASONS.IDLE_TOO_LONG);
  });

  it('measures idleness from creation before any action', () => {
    const result = recoveryQueueMembership(lead(), T0 + 3_599_999, config);

    expect(result.reasons).not.toContain(RECOVERY_REASONS.IDLE_TOO_LONG);
  });

  it('reports every reason that applies at once', () => {
    const result = recoveryQueueMembership(
      lead({ state: escalatedState(3) }),
      T0 + 10_000_000,
      config,
    );

    expect(result.reasons).toEqual([
      RECOVERY_REASONS.UNACKNOWLEDGED_BEYOND_WINDOW,
      RECOVERY_REASONS.ESCALATED_REPEATEDLY,
      RECOVERY_REASONS.IDLE_TOO_LONG,
    ]);
  });

  it('excludes an acknowledged lead, however many times it escalated', () => {
    const acked = acknowledge(escalatedState(3), T0 + 200_000);
    const result = recoveryQueueMembership(lead({ state: acked }), T0 + 10_000_000, config);

    expect(result).toEqual({ leadId: 'lead-1', inQueue: false, reasons: [] });
  });

  it('excludes a manually reassigned lead', () => {
    const moved = reassignManually(createAssignmentState(T0), T0 + 1_000);
    const result = recoveryQueueMembership(lead({ state: moved }), T0 + 10_000_000, config);

    expect(result.inQueue).toBe(false);
  });

  it('excludes a lead reassigned because of absence', () => {
    const moved = reassignForAbsence(createAssignmentState(T0), T0 + 1_000);
    const result = recoveryQueueMembership(lead({ state: moved }), T0 + 10_000_000, config);

    expect(result.inQueue).toBe(false);
  });

  it('still flags a lead stuck at the final level with nowhere to escalate', () => {
    const final = escalatedState(3);
    expect(nextEscalation(final, T0 + 10_000_000, escalation)).toBeNull();

    const result = recoveryQueueMembership(lead({ state: final }), T0 + 10_000_000, config);

    expect(result.inQueue).toBe(true);
  });
});

describe('recoveryQueue', () => {
  it('returns only the leads in the queue', () => {
    const leads = [
      lead({ leadId: 'overdue' }),
      lead({
        leadId: 'fine',
        state: acknowledge(createAssignmentState(T0), T0 + 1_000),
        lastRecordedActionAt: T0 + 1_000,
      }),
    ];

    const queue = recoveryQueue(leads, T0 + 60_001, config);

    expect(queue.map((item) => item.leadId)).toEqual(['overdue']);
  });

  it('is empty when nothing needs rescuing', () => {
    expect(recoveryQueue([lead()], T0 + 1_000, config)).toEqual([]);
  });

  it('is empty with no leads', () => {
    expect(recoveryQueue([], T0, config)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// availableEmployeeCount
// ---------------------------------------------------------------------------

function worker(status: AvailabilityStatus, openLeadCount = 0): EmployeeAvailability {
  return { status, openLeadCount };
}

describe('availableEmployeeCount', () => {
  const limits = { maxOpenLeadsPerEmployee: 3 };

  it('counts Available employees below the limit', () => {
    expect(availableEmployeeCount([worker('available'), worker('available', 2)], limits)).toBe(2);
  });

  it('is zero with no employees', () => {
    expect(availableEmployeeCount([], limits)).toBe(0);
  });

  it.each<AvailabilityStatus>(['busy', 'on_leave', 'offline'])(
    'does not count an employee who is %s',
    (status) => {
      expect(availableEmployeeCount([worker(status)], limits)).toBe(0);
    },
  );

  it('does not count an employee at or over the limit', () => {
    expect(availableEmployeeCount([worker('available', 3), worker('available', 4)], limits)).toBe(
      0,
    );
  });

  it('agrees with the assignment engine, which is the point of sharing it (Q12)', () => {
    const employees = [worker('available', 3), worker('busy'), worker('available', 1)];

    expect(availableEmployeeCount(employees, limits)).toBe(1);
  });
});
