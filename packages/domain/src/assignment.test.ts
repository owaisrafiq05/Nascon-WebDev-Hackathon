import { describe, expect, it } from 'vitest';

import {
  type AssignmentCandidate,
  type AssignmentRules,
  assignLead,
  EMPTY_CURSOR,
  eligibleEmployees,
  type RoundRobinCursor,
  UNASSIGNABLE_REASONS,
} from './assignment.js';
import type { AvailabilityStatus } from './availability.js';

const rules: AssignmentRules = { strategy: 'round_robin', maxOpenLeadsPerEmployee: 3 };

function employee(
  employeeId: string,
  status: AvailabilityStatus = 'available',
  openLeadCount = 0,
): AssignmentCandidate {
  return { employeeId, status, openLeadCount };
}

const lead = { leadId: 'lead-1' };

/** Assigns `count` leads in sequence, feeding the cursor forward as P4 will. */
function rotate(
  candidates: readonly AssignmentCandidate[],
  count: number,
  startCursor: RoundRobinCursor = EMPTY_CURSOR,
): string[] {
  const picked: string[] = [];
  let cursor = startCursor;

  for (let i = 0; i < count; i += 1) {
    const decision = assignLead({ leadId: `lead-${String(i)}` }, candidates, rules, cursor);
    if (!decision.assigned) break;
    picked.push(decision.employeeId);
    cursor = decision.cursor;
  }

  return picked;
}

describe('assignLead round-robin fairness', () => {
  it('starts at the first candidate when there is no cursor', () => {
    const decision = assignLead(lead, [employee('a'), employee('b')], rules);

    expect(decision).toEqual({
      assigned: true,
      employeeId: 'a',
      cursor: { lastAssignedEmployeeId: 'a' },
    });
  });

  it('deals each employee one lead per round, in order', () => {
    expect(rotate([employee('a'), employee('b'), employee('c')], 6)).toEqual([
      'a',
      'b',
      'c',
      'a',
      'b',
      'c',
    ]);
  });

  it('spreads 9 leads evenly over 3 employees', () => {
    const picked = rotate([employee('a'), employee('b'), employee('c')], 9);
    const counts = picked.reduce<Record<string, number>>((acc, id) => {
      acc[id] = (acc[id] ?? 0) + 1;
      return acc;
    }, {});

    expect(counts).toEqual({ a: 3, b: 3, c: 3 });
  });

  it('resumes after the cursor rather than restarting', () => {
    const decision = assignLead(lead, [employee('a'), employee('b'), employee('c')], rules, {
      lastAssignedEmployeeId: 'b',
    });

    expect(decision.assigned && decision.employeeId).toBe('c');
  });

  it('wraps to the first candidate after the last', () => {
    const decision = assignLead(lead, [employee('a'), employee('b')], rules, {
      lastAssignedEmployeeId: 'b',
    });

    expect(decision.assigned && decision.employeeId).toBe('a');
  });

  it('starts from the beginning when the cursor names someone no longer listed', () => {
    const decision = assignLead(lead, [employee('a'), employee('b')], rules, {
      lastAssignedEmployeeId: 'departed',
    });

    expect(decision.assigned && decision.employeeId).toBe('a');
  });

  it('does not cost a skipped employee their place in the rotation', () => {
    // b is Busy for this round, so a and c share it; b keeps its slot order.
    const candidates = [employee('a'), employee('b', 'busy'), employee('c')];

    expect(rotate(candidates, 4)).toEqual(['a', 'c', 'a', 'c']);
  });

  it('is deterministic: the same inputs always give the same decision', () => {
    const candidates = [employee('a'), employee('b'), employee('c')];
    const cursor = { lastAssignedEmployeeId: 'a' };

    const first = assignLead(lead, candidates, rules, cursor);
    const second = assignLead(lead, candidates, rules, cursor);

    expect(first).toEqual(second);
  });

  it('keeps no state between calls: the cursor is the only carrier', () => {
    const candidates = [employee('a'), employee('b')];

    // Called repeatedly with the default cursor, it always answers 'a'.
    expect(assignLead(lead, candidates, rules).assigned && 'a').toBe('a');
    expect(assignLead(lead, candidates, rules)).toEqual(assignLead(lead, candidates, rules));
  });
});

describe('assignLead respects availability (F3.3)', () => {
  it.each<AvailabilityStatus>(['busy', 'on_leave', 'offline'])(
    'never assigns to an employee who is %s',
    (status) => {
      const decision = assignLead(lead, [employee('away', status), employee('ok')], rules);

      expect(decision.assigned && decision.employeeId).toBe('ok');
    },
  );

  it('skips everyone who is not Available, whatever their load', () => {
    const candidates = [
      employee('busy', 'busy', 0),
      employee('leave', 'on_leave', 0),
      employee('offline', 'offline', 0),
      employee('available', 'available', 2),
    ];

    expect(rotate(candidates, 3)).toEqual(['available', 'available', 'available']);
  });
});

describe('assignLead respects the open-lead limit (F3.3)', () => {
  it('skips an employee who is already at the limit', () => {
    const decision = assignLead(
      lead,
      [employee('full', 'available', 3), employee('free', 'available', 1)],
      rules,
    );

    expect(decision.assigned && decision.employeeId).toBe('free');
  });

  it('assigns to an employee one below the limit', () => {
    const decision = assignLead(lead, [employee('nearly', 'available', 2)], rules);

    expect(decision.assigned && decision.employeeId).toBe('nearly');
  });

  it('skips an employee over the limit, not only exactly at it', () => {
    const decision = assignLead(lead, [employee('over', 'available', 9), employee('free')], rules);

    expect(decision.assigned && decision.employeeId).toBe('free');
  });
});

describe('assignLead exclusions', () => {
  it('never returns an excluded employee, so escalation moves on (F3.5)', () => {
    const decision = assignLead(
      { leadId: 'lead-1', excludeEmployeeIds: ['a'] },
      [employee('a'), employee('b')],
      rules,
    );

    expect(decision.assigned && decision.employeeId).toBe('b');
  });

  it('keeps the rotation over the remaining candidates', () => {
    const candidates = [employee('a'), employee('b'), employee('c')];
    let cursor: RoundRobinCursor = EMPTY_CURSOR;
    const picked: string[] = [];

    for (let i = 0; i < 4; i += 1) {
      const decision = assignLead(
        { leadId: `lead-${String(i)}`, excludeEmployeeIds: ['b'] },
        candidates,
        rules,
        cursor,
      );
      if (!decision.assigned) break;
      picked.push(decision.employeeId);
      cursor = decision.cursor;
    }

    expect(picked).toEqual(['a', 'c', 'a', 'c']);
  });
});

describe('assignLead when nobody is eligible', () => {
  it('reports NO_CANDIDATES for an empty workspace', () => {
    const decision = assignLead(lead, [], rules);

    expect(decision).toEqual({
      assigned: false,
      reason: UNASSIGNABLE_REASONS.NO_CANDIDATES,
      cursor: EMPTY_CURSOR,
    });
  });

  it('reports ALL_EXCLUDED when the lead has run out of new people', () => {
    const decision = assignLead(
      { leadId: 'lead-1', excludeEmployeeIds: ['a', 'b'] },
      [employee('a'), employee('b')],
      rules,
    );

    expect(decision.assigned).toBe(false);
    expect(!decision.assigned && decision.reason).toBe(UNASSIGNABLE_REASONS.ALL_EXCLUDED);
  });

  it('reports NONE_AVAILABLE when everyone is away or busy', () => {
    const decision = assignLead(
      lead,
      [employee('a', 'offline'), employee('b', 'on_leave'), employee('c', 'busy')],
      rules,
    );

    expect(!decision.assigned && decision.reason).toBe(UNASSIGNABLE_REASONS.NONE_AVAILABLE);
  });

  it('reports ALL_AT_CAPACITY when Available employees exist but are full', () => {
    const decision = assignLead(
      lead,
      [employee('a', 'available', 3), employee('b', 'available', 5)],
      rules,
    );

    expect(!decision.assigned && decision.reason).toBe(UNASSIGNABLE_REASONS.ALL_AT_CAPACITY);
  });

  it('distinguishes capacity from absence when the two are mixed', () => {
    const decision = assignLead(
      lead,
      [employee('away', 'offline'), employee('full', 'available', 3)],
      rules,
    );

    expect(!decision.assigned && decision.reason).toBe(UNASSIGNABLE_REASONS.ALL_AT_CAPACITY);
  });

  it('reports LIMIT_BELOW_ONE for a misconfigured rule, rather than blaming staff', () => {
    const decision = assignLead(lead, [employee('a')], {
      strategy: 'round_robin',
      maxOpenLeadsPerEmployee: 0,
    });

    expect(!decision.assigned && decision.reason).toBe(UNASSIGNABLE_REASONS.LIMIT_BELOW_ONE);
  });

  it('leaves the cursor untouched, so a failure costs nobody their turn', () => {
    const cursor = { lastAssignedEmployeeId: 'a' };
    const decision = assignLead(lead, [employee('a', 'offline')], rules, cursor);

    expect(decision.cursor).toEqual(cursor);
  });
});

describe('eligibleEmployees', () => {
  it('returns only Available employees below the limit, in candidate order', () => {
    const result = eligibleEmployees(
      [
        employee('a'),
        employee('full', 'available', 3),
        employee('busy', 'busy'),
        employee('b', 'available', 1),
      ],
      rules,
    );

    expect(result.map((candidate) => candidate.employeeId)).toEqual(['a', 'b']);
  });

  it('is empty when nobody qualifies', () => {
    expect(eligibleEmployees([employee('a', 'offline')], rules)).toEqual([]);
  });
});
