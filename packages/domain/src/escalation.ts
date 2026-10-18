/**
 * The acknowledgement and escalation state machine for one lead assignment
 * (F3.4, F3.5, F3.8).
 *
 * Every transition is a pure function of the current state, the clock reading
 * and the workspace configuration. Nothing here reads a clock or a database of
 * its own, which is what makes "escalate exactly once" testable: the worker
 * computes the next state, then persists it with optimistic concurrency, and a
 * second timer firing on the same stored state computes the same single step.
 */

/**
 * Who a level hands the lead to (F3.5): the original assignee, then the next
 * eligible employee, then a designated backup, then a manager. Which employee
 * each name resolves to is the assignment engine's job, not this module's.
 */
export const ESCALATION_TARGETS = ['assignee', 'next_eligible', 'backup', 'manager'] as const;
export type EscalationTarget = (typeof ESCALATION_TARGETS)[number];

export interface EscalationLevelConfig {
  readonly target: EscalationTarget;
  /** How long this level has to acknowledge. Short in demos (Q13). */
  readonly acknowledgementWindowMs: number;
}

export interface EscalationConfig {
  /**
   * Ordered levels. Index 0 is the original assignee's window; each later index
   * is one escalation step. Both the count and each duration are configurable
   * per workspace (F3.5).
   */
  readonly levels: readonly EscalationLevelConfig[];
}

export const ASSIGNMENT_STATUSES = [
  'pending_ack',
  'escalated',
  'acknowledged',
  'reassigned_manual',
  'reassigned_absence',
] as const;
export type AssignmentStatus = (typeof ASSIGNMENT_STATUSES)[number];

/** Fields every state carries, whatever its status. */
interface AssignmentStateBase {
  readonly level: number;
  readonly target: EscalationTarget;
  /**
   * Automatic escalations so far. Manual reassignments are deliberately not
   * counted here: the Section 7 definition of escalation counts them separately.
   */
  readonly escalationCount: number;
}

/** A state still waiting for the current holder to acknowledge. */
export interface AwaitingAssignmentState extends AssignmentStateBase {
  readonly status: 'pending_ack' | 'escalated';
  /** When this level's acknowledgement window began. */
  readonly windowStartedAt: number;
}

export interface SettledAssignmentState extends AssignmentStateBase {
  readonly status: 'acknowledged' | 'reassigned_manual' | 'reassigned_absence';
  readonly settledAt: number;
}

export type AssignmentState = AwaitingAssignmentState | SettledAssignmentState;

/** The first state of a freshly assigned lead: level 0, awaiting the assignee. */
export function createAssignmentState(assignedAt: number): AssignmentState {
  return {
    status: 'pending_ack',
    level: 0,
    target: 'assignee',
    windowStartedAt: assignedAt,
    escalationCount: 0,
  };
}

export function isAwaitingAcknowledgement(
  state: AssignmentState,
): state is AwaitingAssignmentState {
  return state.status === 'pending_ack' || state.status === 'escalated';
}

/** No further escalation can happen from a settled state. */
export function isSettled(state: AssignmentState): state is SettledAssignmentState {
  return !isAwaitingAcknowledgement(state);
}

/**
 * When the current level's window runs out, or `null` if the lead is settled or
 * its level is not configured. The web app counts down to this (F3.4).
 */
export function acknowledgementDeadline(
  state: AssignmentState,
  config: EscalationConfig,
): number | null {
  if (!isAwaitingAcknowledgement(state)) return null;

  const level = config.levels[state.level];
  if (level === undefined) return null;

  return state.windowStartedAt + level.acknowledgementWindowMs;
}

/** Whether the window has run out without an acknowledgement. */
export function isOverdue(state: AssignmentState, now: number, config: EscalationConfig): boolean {
  const deadline = acknowledgementDeadline(state, config);
  return deadline !== null && now >= deadline;
}

/**
 * The state after the next escalation, or `null` when none is due.
 *
 * `null` is returned when:
 *   - the lead is already acknowledged or was reassigned (escalation stops)
 *   - the window has not run out yet
 *   - the current level is the last one configured, so there is nobody left to
 *     escalate to; the lead stays `escalated` and unacknowledged, and
 *     `recoveryQueueMembership` is what surfaces it (F3.7)
 *
 * Two properties this function is built around (F3.8):
 *
 * **Idempotent.** It is a pure function, so calling it twice with the same state
 * and clock reading returns the same single step. Two timers firing together
 * therefore compute one escalation, not two, and only one of them wins the
 * conditional write in the worker.
 *
 * **Never skips a level.** The new window starts at the previous window's
 * deadline, not at `now`. A worker that was down for three windows advances one
 * level per call, through every level in order, instead of jumping to the last
 * one and losing the intermediate steps.
 */
export function nextEscalation(
  state: AssignmentState,
  now: number,
  config: EscalationConfig,
): AwaitingAssignmentState | null {
  if (!isAwaitingAcknowledgement(state)) return null;

  const currentLevel = config.levels[state.level];
  if (currentLevel === undefined) return null;

  const deadline = state.windowStartedAt + currentLevel.acknowledgementWindowMs;
  if (now < deadline) return null;

  const nextIndex = state.level + 1;
  const nextLevel = config.levels[nextIndex];
  if (nextLevel === undefined) return null;

  return {
    status: 'escalated',
    level: nextIndex,
    target: nextLevel.target,
    windowStartedAt: deadline,
    escalationCount: state.escalationCount + 1,
  };
}

/**
 * Acknowledgement (Section 7): the assignee pressed Acknowledge, or took a
 * recorded action on the lead. Either way escalation stops.
 *
 * Acknowledging an already settled lead changes nothing, so a late click after a
 * manual reassignment cannot take ownership back.
 */
export function acknowledge(state: AssignmentState, acknowledgedAt: number): AssignmentState {
  if (isSettled(state)) return state;

  return {
    status: 'acknowledged',
    level: state.level,
    target: state.target,
    escalationCount: state.escalationCount,
    settledAt: acknowledgedAt,
  };
}

/** A manager moved the lead by hand. Counted separately from escalations. */
export function reassignManually(state: AssignmentState, reassignedAt: number): AssignmentState {
  if (isSettled(state)) return state;

  return {
    status: 'reassigned_manual',
    level: state.level,
    target: state.target,
    escalationCount: state.escalationCount,
    settledAt: reassignedAt,
  };
}

/**
 * The holder went On leave or Offline, so an unacknowledged lead moves on
 * (F3.6). An acknowledged lead is left alone: it already has someone
 * accountable, and the glossary counts this as a reassignment rather than an
 * escalation.
 */
export function reassignForAbsence(state: AssignmentState, reassignedAt: number): AssignmentState {
  if (isSettled(state)) return state;

  return {
    status: 'reassigned_absence',
    level: state.level,
    target: state.target,
    escalationCount: state.escalationCount,
    settledAt: reassignedAt,
  };
}

/**
 * Advances through every level whose window has already passed, returning each
 * step in order. Used by the worker when it has been down and several windows
 * expired while it was away, and by tests that assert the full chain.
 *
 * `maxSteps` bounds the walk so a misconfigured zero-length window cannot spin.
 */
export function escalationsDueSince(
  state: AssignmentState,
  now: number,
  config: EscalationConfig,
  maxSteps = config.levels.length,
): readonly AwaitingAssignmentState[] {
  const steps: AwaitingAssignmentState[] = [];
  let current = state;

  for (let i = 0; i < maxSteps; i += 1) {
    const next = nextEscalation(current, now, config);
    if (next === null) break;
    steps.push(next);
    current = next;
  }

  return steps;
}
