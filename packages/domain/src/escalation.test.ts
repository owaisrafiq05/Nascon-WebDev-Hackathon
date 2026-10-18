import { describe, expect, it } from 'vitest';

import {
  acknowledge,
  acknowledgementDeadline,
  type AssignmentState,
  createAssignmentState,
  type EscalationConfig,
  escalationsDueSince,
  isAwaitingAcknowledgement,
  isOverdue,
  isSettled,
  nextEscalation,
  reassignForAbsence,
  reassignManually,
} from './escalation.js';

const T0 = 1_700_000_000_000;

/** The four levels of F3.5, with distinct durations so ordering is observable. */
const config: EscalationConfig = {
  levels: [
    { target: 'assignee', acknowledgementWindowMs: 60_000 },
    { target: 'next_eligible', acknowledgementWindowMs: 120_000 },
    { target: 'backup', acknowledgementWindowMs: 180_000 },
    { target: 'manager', acknowledgementWindowMs: 240_000 },
  ],
};

const DEADLINES = {
  level0: T0 + 60_000,
  level1: T0 + 60_000 + 120_000,
  level2: T0 + 60_000 + 120_000 + 180_000,
  level3: T0 + 60_000 + 120_000 + 180_000 + 240_000,
} as const;

describe('createAssignmentState', () => {
  it('starts at level 0 with the assignee, awaiting acknowledgement', () => {
    expect(createAssignmentState(T0)).toEqual({
      status: 'pending_ack',
      level: 0,
      target: 'assignee',
      windowStartedAt: T0,
      escalationCount: 0,
    });
  });
});

describe('acknowledgementDeadline', () => {
  it('is the window end for the current level (F3.4 countdown)', () => {
    expect(acknowledgementDeadline(createAssignmentState(T0), config)).toBe(DEADLINES.level0);
  });

  it('uses the new level duration after escalating', () => {
    const escalated = nextEscalation(createAssignmentState(T0), DEADLINES.level0, config);

    expect(acknowledgementDeadline(escalated!, config)).toBe(DEADLINES.level1);
  });

  it('is null once the lead is acknowledged', () => {
    const acked = acknowledge(createAssignmentState(T0), T0 + 1);

    expect(acknowledgementDeadline(acked, config)).toBeNull();
  });

  it('is null when the level is not configured', () => {
    expect(acknowledgementDeadline(createAssignmentState(T0), { levels: [] })).toBeNull();
  });
});

describe('isOverdue', () => {
  it('is false before the deadline and true at or after it', () => {
    const state = createAssignmentState(T0);

    expect(isOverdue(state, DEADLINES.level0 - 1, config)).toBe(false);
    expect(isOverdue(state, DEADLINES.level0, config)).toBe(true);
    expect(isOverdue(state, DEADLINES.level0 + 1, config)).toBe(true);
  });

  it('is false for a settled lead, however late the clock', () => {
    const acked = acknowledge(createAssignmentState(T0), T0);

    expect(isOverdue(acked, T0 + 10_000_000, config)).toBe(false);
  });
});

describe('nextEscalation ordering through every level (F3.5)', () => {
  it('does not escalate before the window runs out', () => {
    expect(nextEscalation(createAssignmentState(T0), DEADLINES.level0 - 1, config)).toBeNull();
  });

  it('escalates exactly at the deadline', () => {
    const next = nextEscalation(createAssignmentState(T0), DEADLINES.level0, config);

    expect(next).toEqual({
      status: 'escalated',
      level: 1,
      target: 'next_eligible',
      windowStartedAt: DEADLINES.level0,
      escalationCount: 1,
    });
  });

  it('walks assignee, next eligible, backup, manager in order', () => {
    const targets: string[] = [];
    let state: AssignmentState = createAssignmentState(T0);

    // Far-future clock, one step at a time, as the worker does.
    for (let i = 0; i < 10; i += 1) {
      const next = nextEscalation(state, T0 + 10_000_000, config);
      if (next === null) break;
      targets.push(next.target);
      state = next;
    }

    expect(targets).toEqual(['next_eligible', 'backup', 'manager']);
    expect(state.level).toBe(3);
    expect(state.escalationCount).toBe(3);
  });

  it('increments the level and the count by exactly one per step', () => {
    const steps = escalationsDueSince(createAssignmentState(T0), T0 + 10_000_000, config);

    expect(steps.map((step) => step.level)).toEqual([1, 2, 3]);
    expect(steps.map((step) => step.escalationCount)).toEqual([1, 2, 3]);
  });

  it('starts each window at the previous deadline, so no time is lost', () => {
    const steps = escalationsDueSince(createAssignmentState(T0), T0 + 10_000_000, config);

    expect(steps.map((step) => step.windowStartedAt)).toEqual([
      DEADLINES.level0,
      DEADLINES.level1,
      DEADLINES.level2,
    ]);
  });

  it('returns null at the last level: there is nobody left to escalate to', () => {
    let state: AssignmentState = createAssignmentState(T0);
    for (const step of escalationsDueSince(state, T0 + 10_000_000, config)) state = step;

    expect(state.level).toBe(3);
    expect(nextEscalation(state, DEADLINES.level3 + 1, config)).toBeNull();
    // It stays escalated and unacknowledged; the recovery queue surfaces it.
    expect(isAwaitingAcknowledgement(state)).toBe(true);
  });

  it('honours a configuration with fewer levels', () => {
    const twoLevels: EscalationConfig = {
      levels: [
        { target: 'assignee', acknowledgementWindowMs: 30_000 },
        { target: 'manager', acknowledgementWindowMs: 30_000 },
      ],
    };
    const steps = escalationsDueSince(createAssignmentState(T0), T0 + 10_000_000, twoLevels);

    expect(steps.map((step) => step.target)).toEqual(['manager']);
  });

  it('never escalates when only one level is configured', () => {
    const single: EscalationConfig = {
      levels: [{ target: 'assignee', acknowledgementWindowMs: 30_000 }],
    };

    expect(nextEscalation(createAssignmentState(T0), T0 + 10_000_000, single)).toBeNull();
  });
});

describe('nextEscalation is idempotent (F3.8)', () => {
  it('returns the same result when called twice with the same inputs', () => {
    const state = createAssignmentState(T0);

    const first = nextEscalation(state, DEADLINES.level0, config);
    const second = nextEscalation(state, DEADLINES.level0, config);

    expect(first).toEqual(second);
    expect(first?.level).toBe(1);
  });

  it('two timers firing together compute one escalation, not two', () => {
    const state = createAssignmentState(T0);
    const now = DEADLINES.level0 + 5_000;

    const timerA = nextEscalation(state, now, config);
    const timerB = nextEscalation(state, now, config);

    // Both propose level 1. Only one wins the conditional write in P4.
    expect(timerA?.level).toBe(1);
    expect(timerB?.level).toBe(1);
    expect(timerA).toEqual(timerB);
  });

  it('does not repeat a level once the escalation has been applied', () => {
    const state = createAssignmentState(T0);
    const now = DEADLINES.level0 + 5_000;
    const applied = nextEscalation(state, now, config)!;

    // The level-1 window has not run out at this clock reading.
    expect(nextEscalation(applied, now, config)).toBeNull();
  });

  it('does not skip levels when the worker was down for several windows', () => {
    // A worker that missed every window still passes through each level.
    const steps = escalationsDueSince(createAssignmentState(T0), DEADLINES.level3, config);

    expect(steps.map((step) => step.level)).toEqual([1, 2, 3]);
  });

  it('escalates only as far as the clock allows', () => {
    // Past level 1's deadline but not level 2's.
    const steps = escalationsDueSince(createAssignmentState(T0), DEADLINES.level1, config);

    expect(steps.map((step) => step.level)).toEqual([1, 2]);
  });

  it('does not mutate the state it was given', () => {
    const state = createAssignmentState(T0);
    const snapshot = { ...state };

    nextEscalation(state, T0 + 10_000_000, config);

    expect(state).toEqual(snapshot);
  });
});

describe('acknowledgement stops escalation', () => {
  it('settles the lead at the level that acknowledged it', () => {
    const acked = acknowledge(createAssignmentState(T0), T0 + 10_000);

    expect(acked).toEqual({
      status: 'acknowledged',
      level: 0,
      target: 'assignee',
      escalationCount: 0,
      settledAt: T0 + 10_000,
    });
  });

  it('means no further escalation, however far the clock runs', () => {
    const acked = acknowledge(createAssignmentState(T0), T0 + 10_000);

    expect(nextEscalation(acked, T0 + 10_000_000, config)).toBeNull();
    expect(escalationsDueSince(acked, T0 + 10_000_000, config)).toEqual([]);
  });

  it('keeps the escalation count, so a late acknowledgement is still visible', () => {
    const escalated = nextEscalation(createAssignmentState(T0), DEADLINES.level0, config)!;
    const acked = acknowledge(escalated, DEADLINES.level0 + 1_000);

    expect(acked.escalationCount).toBe(1);
    expect(acked.level).toBe(1);
    expect(acked.target).toBe('next_eligible');
  });

  it('changes nothing when the lead was already settled', () => {
    const reassigned = reassignManually(createAssignmentState(T0), T0 + 1_000);
    const lateClick = acknowledge(reassigned, T0 + 2_000);

    expect(lateClick).toBe(reassigned);
  });
});

describe('manual reassignment and absence', () => {
  it('reassignManually settles the lead and stops escalation', () => {
    const state = reassignManually(createAssignmentState(T0), T0 + 5_000);

    expect(state.status).toBe('reassigned_manual');
    expect(isSettled(state)).toBe(true);
    expect(nextEscalation(state, T0 + 10_000_000, config)).toBeNull();
  });

  it('does not count a manual reassignment as an escalation (Section 7)', () => {
    const state = reassignManually(createAssignmentState(T0), T0 + 5_000);

    expect(state.escalationCount).toBe(0);
  });

  it('reassignForAbsence moves an unacknowledged lead on (F3.6)', () => {
    const state = reassignForAbsence(createAssignmentState(T0), T0 + 5_000);

    expect(state.status).toBe('reassigned_absence');
    expect(nextEscalation(state, T0 + 10_000_000, config)).toBeNull();
  });

  it('leaves an already acknowledged lead with its accountable owner (F3.6)', () => {
    const acked = acknowledge(createAssignmentState(T0), T0 + 1_000);
    const afterAbsence = reassignForAbsence(acked, T0 + 2_000);

    expect(afterAbsence).toBe(acked);
    expect(afterAbsence.status).toBe('acknowledged');
  });

  it('does not count an absence reassignment as an escalation', () => {
    const escalated = nextEscalation(createAssignmentState(T0), DEADLINES.level0, config)!;
    const state = reassignForAbsence(escalated, DEADLINES.level0 + 1);

    expect(state.escalationCount).toBe(1);
  });
});

describe('state predicates', () => {
  it('treats pending_ack and escalated as awaiting', () => {
    const pending = createAssignmentState(T0);
    const escalated = nextEscalation(pending, DEADLINES.level0, config)!;

    expect(isAwaitingAcknowledgement(pending)).toBe(true);
    expect(isAwaitingAcknowledgement(escalated)).toBe(true);
    expect(isSettled(pending)).toBe(false);
  });

  it('treats all three settled statuses as settled', () => {
    const base = createAssignmentState(T0);

    expect(isSettled(acknowledge(base, T0))).toBe(true);
    expect(isSettled(reassignManually(base, T0))).toBe(true);
    expect(isSettled(reassignForAbsence(base, T0))).toBe(true);
  });
});
