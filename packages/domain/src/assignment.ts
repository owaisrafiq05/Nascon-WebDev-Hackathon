import {
  type AssignmentLimits,
  type EmployeeAvailability,
  isAvailableEmployee,
} from './availability.js';

/**
 * Round-robin lead assignment (F3.3).
 *
 * Pure: the caller supplies the candidate list, the rules and the cursor, and
 * receives a decision plus the next cursor. There is no module-level state, so
 * two workspaces assigning at the same time cannot interfere, and a decision can
 * be replayed in a test by passing the same inputs.
 */

/** An employee the engine may consider, with everything needed to judge them. */
export interface AssignmentCandidate extends EmployeeAvailability {
  readonly employeeId: string;
}

export const ASSIGNMENT_STRATEGIES = ['round_robin'] as const;
export type AssignmentStrategy = (typeof ASSIGNMENT_STRATEGIES)[number];

export interface AssignmentRules extends AssignmentLimits {
  readonly strategy: AssignmentStrategy;
}

/**
 * Where the last round ended. Held by the caller (a workspace document in P4)
 * rather than in this module, so it is persisted and auditable.
 */
export interface RoundRobinCursor {
  /** The employee the previous assignment went to, or `null` before the first. */
  readonly lastAssignedEmployeeId: string | null;
}

export const EMPTY_CURSOR: RoundRobinCursor = { lastAssignedEmployeeId: null };

export interface LeadForAssignment {
  readonly leadId: string;
  /**
   * Employees who must not receive this lead. Used when escalating, so "the next
   * eligible employee" never means the assignee who just let the window expire
   * (F3.5).
   */
  readonly excludeEmployeeIds?: readonly string[];
}

/**
 * Why nobody could be assigned. The caller turns this into a recovery-queue
 * reason the user can read (F3.7), so each case is distinct and actionable.
 */
export const UNASSIGNABLE_REASONS = {
  /** The workspace has no employees to consider at all. */
  NO_CANDIDATES: 'no_candidates',
  /** Every candidate was excluded for this particular lead. */
  ALL_EXCLUDED: 'all_excluded',
  /** Candidates exist, but none has status Available. */
  NONE_AVAILABLE: 'none_available',
  /** Available employees exist, but all are at the open-lead limit. */
  ALL_AT_CAPACITY: 'all_at_capacity',
  /** `maxOpenLeadsPerEmployee` is below 1, so no one can ever qualify. */
  LIMIT_BELOW_ONE: 'limit_below_one',
} as const;

export type UnassignableReason = (typeof UNASSIGNABLE_REASONS)[keyof typeof UNASSIGNABLE_REASONS];

export type AssignmentDecision =
  | {
      readonly assigned: true;
      readonly employeeId: string;
      readonly cursor: RoundRobinCursor;
    }
  | {
      readonly assigned: false;
      readonly reason: UnassignableReason;
      /** Unchanged, so a failed attempt does not consume anyone's turn. */
      readonly cursor: RoundRobinCursor;
    };

/**
 * Picks the next employee for `lead`.
 *
 * Fairness: the scan starts at the position *after* the cursor in the candidate
 * list and wraps once. Scanning the full list rather than only the eligible
 * subset means an employee who was skipped while Busy does not lose their place
 * in the rotation, and a cursor pointing at someone now ineligible still
 * advances correctly.
 *
 * `candidates` must be in a stable order (P4 orders them by employee id); the
 * same inputs always produce the same decision.
 */
export function assignLead(
  lead: LeadForAssignment,
  candidates: readonly AssignmentCandidate[],
  rules: AssignmentRules,
  cursor: RoundRobinCursor = EMPTY_CURSOR,
): AssignmentDecision {
  const refuse = (reason: UnassignableReason): AssignmentDecision => ({
    assigned: false,
    reason,
    cursor,
  });

  if (candidates.length === 0) return refuse(UNASSIGNABLE_REASONS.NO_CANDIDATES);
  if (rules.maxOpenLeadsPerEmployee < 1) return refuse(UNASSIGNABLE_REASONS.LIMIT_BELOW_ONE);

  const excluded = new Set(lead.excludeEmployeeIds ?? []);
  const considered = candidates.filter((candidate) => !excluded.has(candidate.employeeId));
  if (considered.length === 0) return refuse(UNASSIGNABLE_REASONS.ALL_EXCLUDED);

  // Position in the considered list, so exclusions do not shift the rotation.
  const cursorIndex = considered.findIndex(
    (candidate) => candidate.employeeId === cursor.lastAssignedEmployeeId,
  );
  const startIndex = cursorIndex === -1 ? 0 : cursorIndex + 1;

  for (let step = 0; step < considered.length; step += 1) {
    const candidate = considered[(startIndex + step) % considered.length];
    if (candidate !== undefined && isAvailableEmployee(candidate, rules)) {
      return {
        assigned: true,
        employeeId: candidate.employeeId,
        cursor: { lastAssignedEmployeeId: candidate.employeeId },
      };
    }
  }

  // Nobody qualified. Distinguish "all busy or away" from "all full", because
  // the two call for different action from a manager.
  const anyAvailableStatus = considered.some((candidate) => candidate.status === 'available');
  return refuse(
    anyAvailableStatus ? UNASSIGNABLE_REASONS.ALL_AT_CAPACITY : UNASSIGNABLE_REASONS.NONE_AVAILABLE,
  );
}

/**
 * The employees who could currently take a lead, in candidate order. Used by the
 * dashboard's availability figure and by admin screens that explain why a lead
 * could not be placed.
 */
export function eligibleEmployees(
  candidates: readonly AssignmentCandidate[],
  rules: AssignmentLimits,
): readonly AssignmentCandidate[] {
  return candidates.filter((candidate) => isAvailableEmployee(candidate, rules));
}
