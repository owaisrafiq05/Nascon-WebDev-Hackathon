import {
  type AssignmentLimits,
  type EmployeeAvailability,
  isAvailableEmployee,
} from './availability.js';
import {
  type AssignmentState,
  type EscalationConfig,
  isAwaitingAcknowledgement,
  isOverdue,
} from './escalation.js';

/**
 * One function per definition in Section 7 of the problem statement.
 *
 * Every dashboard figure, list and export calls these rather than computing a
 * sum of its own, which is what makes the same figure read the same on every
 * screen (F5.2, Q12).
 *
 * **Money is in minor units** (cents, pence, paisa) as integers. Floating-point
 * currency drifts once you add enough rows, and these totals are compared
 * against provider records. The web app divides by the currency's exponent for
 * display; nothing here does.
 *
 * **Totals are per currency.** Each function that adds money takes a `currency`
 * and ignores records in any other, so a USD payment can never be added to a
 * EUR one (I2.1 stores both amount and currency).
 */

export interface CurrencyScope {
  /** ISO 4217 code, for example 'USD'. Compared exactly. */
  readonly currency: string;
}

// ---------------------------------------------------------------------------
// Time to first response
// ---------------------------------------------------------------------------

/**
 * "Time from the lead's first assignment to its first acknowledgement."
 *
 * Note `firstAssignedAt`, not the glossary's "assigned time", which is the
 * *last* assignment. A lead that escalated three times is still measured from
 * the moment it first reached a person, so escalation cannot flatter the figure.
 */
export interface LeadResponseTimes {
  readonly firstAssignedAt: number | null;
  readonly firstAcknowledgedAt: number | null;
}

/** Milliseconds, or `null` while the lead has no first response to measure. */
export function timeToFirstResponse(lead: LeadResponseTimes): number | null {
  const { firstAssignedAt, firstAcknowledgedAt } = lead;
  if (firstAssignedAt === null || firstAcknowledgedAt === null) return null;

  const elapsed = firstAcknowledgedAt - firstAssignedAt;
  // A negative interval means contradictory timestamps. Excluded rather than
  // returned, so one bad record cannot drag an average below zero.
  return elapsed < 0 ? null : elapsed;
}

export interface AverageResponseTime {
  /** Mean milliseconds, or `null` when no lead has been acknowledged yet. */
  readonly averageMs: number | null;
  /** Leads that contributed, so the interface can say "based on n leads". */
  readonly sampleSize: number;
  /** Leads excluded because they have no first response yet. */
  readonly excluded: number;
}

/**
 * The dashboard's "average time to first response" (F5.1). Unacknowledged leads
 * are excluded rather than counted as zero, and the count of both groups is
 * returned so the figure can be explained when drilled into (F5.3).
 */
export function averageTimeToFirstResponse(
  leads: readonly LeadResponseTimes[],
): AverageResponseTime {
  let total = 0;
  let sampleSize = 0;

  for (const lead of leads) {
    const elapsed = timeToFirstResponse(lead);
    if (elapsed === null) continue;
    total += elapsed;
    sampleSize += 1;
  }

  return {
    averageMs: sampleSize === 0 ? null : total / sampleSize,
    sampleSize,
    excluded: leads.length - sampleSize,
  };
}

// ---------------------------------------------------------------------------
// Open pipeline value
// ---------------------------------------------------------------------------

/** Whether a stage means the opportunity is still in play, won, or lost. */
export const STAGE_OUTCOMES = ['open', 'won', 'lost'] as const;
export type StageOutcome = (typeof STAGE_OUTCOMES)[number];

export interface OpportunityForPipeline {
  readonly stageId: string;
  readonly stageOutcome: StageOutcome;
  /** Minor units. */
  readonly value: number;
  readonly currency: string;
}

export interface StageTotal {
  readonly stageId: string;
  /** Minor units. */
  readonly total: number;
  readonly count: number;
}

export interface OpenPipelineValue {
  /** Ordered by stage id, so the result is stable. */
  readonly byStage: readonly StageTotal[];
  /** Minor units, across every open stage. */
  readonly total: number;
  readonly count: number;
}

/**
 * "The sum of values of opportunities not in a won or lost stage, grouped by
 * stage."
 *
 * Masking is not applied here. Who may see a value is a permission question
 * answered on the server before this is called (F1.4); a metric that silently
 * returned zero for an unpermitted user would make the same figure differ
 * between screens, which Q12 forbids.
 *
 * `byStage` is ordered by stage id for determinism. Display order comes from the
 * pipeline's stage positions and is applied by the caller.
 */
export function openPipelineValue(
  opportunities: readonly OpportunityForPipeline[],
  { currency }: CurrencyScope,
): OpenPipelineValue {
  const totals = new Map<string, { total: number; count: number }>();
  let total = 0;
  let count = 0;

  for (const opportunity of opportunities) {
    if (opportunity.currency !== currency) continue;
    if (opportunity.stageOutcome !== 'open') continue;

    const existing = totals.get(opportunity.stageId) ?? { total: 0, count: 0 };
    totals.set(opportunity.stageId, {
      total: existing.total + opportunity.value,
      count: existing.count + 1,
    });
    total += opportunity.value;
    count += 1;
  }

  const byStage = [...totals.entries()]
    .map(([stageId, entry]) => ({ stageId, total: entry.total, count: entry.count }))
    .sort((left, right) => left.stageId.localeCompare(right.stageId));

  return { byStage, total, count };
}

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------

export const PAYMENT_STATUSES = ['pending', 'paid', 'expired', 'failed', 'refunded'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export interface PaymentRecord {
  readonly status: PaymentStatus;
  /** Minor units, as requested from the provider. */
  readonly amount: number;
  readonly currency: string;
  /**
   * True only once the provider's webhook confirmed it. A record created
   * optimistically by the interface is not revenue until this is true (I2.2).
   */
  readonly confirmedByWebhook: boolean;
  /** Minor units already refunded and confirmed. 0 when none. */
  readonly refundedAmount: number;
}

export interface CollectedRevenue {
  /** Minor units confirmed as received, before refunds. */
  readonly gross: number;
  /** Minor units given back. */
  readonly refunded: number;
  /** `gross - refunded`. The figure the dashboard shows. */
  readonly net: number;
  readonly paymentCount: number;
}

/**
 * "The sum of payments confirmed by the payment provider's webhook, minus
 * confirmed refunds" (I2.6).
 *
 * A payment counts only when `confirmedByWebhook` is true, so a checkout session
 * the interface created, or one a user believes succeeded, never appears as
 * collected revenue until the provider says so. `pending`, `expired` and
 * `failed` never count. `refunded` does count toward gross, with the refund
 * subtracted, so a fully refunded payment nets zero and a partial refund leaves
 * the remainder.
 */
export function collectedRevenue(
  payments: readonly PaymentRecord[],
  { currency }: CurrencyScope,
): CollectedRevenue {
  let gross = 0;
  let refunded = 0;
  let paymentCount = 0;

  for (const payment of payments) {
    if (payment.currency !== currency) continue;
    if (!payment.confirmedByWebhook) continue;
    if (payment.status !== 'paid' && payment.status !== 'refunded') continue;

    gross += payment.amount;
    refunded += payment.refundedAmount;
    paymentCount += 1;
  }

  return { gross, refunded, net: gross - refunded, paymentCount };
}

export interface ProjectedRevenue {
  /** Minor units held in opportunities that are neither won nor lost. */
  readonly openOpportunities: number;
  /** Minor units requested from customers but not yet paid. */
  readonly unpaidRequests: number;
  readonly total: number;
}

/**
 * "The value of open opportunities and of payment requests not yet paid."
 *
 * Only `pending` payments count as "not yet paid": `expired` and `failed` will
 * not arrive, and `refunded` was already paid. The two components are returned
 * separately as well as summed, because an open opportunity that also has a
 * pending payment request contributes to both halves of the definition, and a
 * reader comparing this with collected revenue needs to see why (Q12).
 */
export function projectedRevenue(
  opportunities: readonly OpportunityForPipeline[],
  payments: readonly PaymentRecord[],
  { currency }: CurrencyScope,
): ProjectedRevenue {
  const openOpportunities = openPipelineValue(opportunities, { currency }).total;

  let unpaidRequests = 0;
  for (const payment of payments) {
    if (payment.currency !== currency) continue;
    if (payment.status !== 'pending') continue;
    unpaidRequests += payment.amount;
  }

  return {
    openOpportunities,
    unpaidRequests,
    total: openOpportunities + unpaidRequests,
  };
}

// ---------------------------------------------------------------------------
// Recovery queue
// ---------------------------------------------------------------------------

/** Why a lead is in the recovery queue. Shown per item (F3.7). */
export const RECOVERY_REASONS = {
  UNACKNOWLEDGED_BEYOND_WINDOW: 'unacknowledged_beyond_window',
  ESCALATED_REPEATEDLY: 'escalated_repeatedly',
  IDLE_TOO_LONG: 'idle_too_long',
} as const;

export type RecoveryReason = (typeof RECOVERY_REASONS)[keyof typeof RECOVERY_REASONS];

export interface RecoveryQueueConfig {
  /** "two or more times" in Section 7, configurable per workspace. */
  readonly minEscalations: number;
  /** How long with no recorded action counts as untouched. */
  readonly idlePeriodMs: number;
}

export interface LeadForRecovery {
  readonly leadId: string;
  readonly state: AssignmentState;
  /** When the lead was created, used as the idle baseline before any action. */
  readonly createdAt: number;
  /** Last note, message, call log, stage change or appointment. */
  readonly lastRecordedActionAt: number | null;
}

export interface RecoveryQueueMembership {
  readonly leadId: string;
  readonly inQueue: boolean;
  /** Every reason that applies, in a stable order. */
  readonly reasons: readonly RecoveryReason[];
}

/**
 * "A lead that is unacknowledged beyond its window, has escalated two or more
 * times, or has no recorded action for the configured idle period."
 *
 * A settled lead is never in the queue. Once it has been acknowledged, or a
 * manager has moved it, or absence handling has passed it on, it has an
 * accountable owner and is no longer waiting to be rescued; the escalation
 * history stays visible in the activity log and the audit trail instead. A lead
 * reassigned away gets a fresh assignment state, which is judged on its own.
 */
export function recoveryQueueMembership(
  lead: LeadForRecovery,
  now: number,
  config: { readonly escalation: EscalationConfig; readonly recovery: RecoveryQueueConfig },
): RecoveryQueueMembership {
  if (!isAwaitingAcknowledgement(lead.state)) {
    return { leadId: lead.leadId, inQueue: false, reasons: [] };
  }

  const reasons: RecoveryReason[] = [];

  if (isOverdue(lead.state, now, config.escalation)) {
    reasons.push(RECOVERY_REASONS.UNACKNOWLEDGED_BEYOND_WINDOW);
  }

  if (lead.state.escalationCount >= config.recovery.minEscalations) {
    reasons.push(RECOVERY_REASONS.ESCALATED_REPEATEDLY);
  }

  const idleSince = lead.lastRecordedActionAt ?? lead.createdAt;
  if (now - idleSince >= config.recovery.idlePeriodMs) {
    reasons.push(RECOVERY_REASONS.IDLE_TOO_LONG);
  }

  return { leadId: lead.leadId, inQueue: reasons.length > 0, reasons };
}

/** The recovery queue itself, and the count the dashboard shows (F5.1). */
export function recoveryQueue(
  leads: readonly LeadForRecovery[],
  now: number,
  config: { readonly escalation: EscalationConfig; readonly recovery: RecoveryQueueConfig },
): readonly RecoveryQueueMembership[] {
  return leads
    .map((lead) => recoveryQueueMembership(lead, now, config))
    .filter((membership) => membership.inQueue);
}

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

/**
 * "A user whose status is Available and whose open-lead count is below the
 * configured limit."
 *
 * Delegates to the same predicate the assignment engine uses, so the dashboard
 * can never report someone as available whom the engine would refuse to
 * assign to (Q12).
 */
export function availableEmployeeCount(
  employees: readonly EmployeeAvailability[],
  limits: AssignmentLimits,
): number {
  return employees.filter((employee) => isAvailableEmployee(employee, limits)).length;
}

// ---------------------------------------------------------------------------
// Counts over a period (F5.1)
// ---------------------------------------------------------------------------

/** A half-open period `[from, to)`, in epoch milliseconds. */
export interface Period {
  readonly from: number;
  readonly to: number;
}

export function inPeriod(at: number, { from, to }: Period): boolean {
  return at >= from && at < to;
}

/** "New leads": leads created by intake within the period. */
export function newLeadCount(
  leads: readonly { readonly createdAt: number }[],
  period: Period,
): number {
  return leads.filter((lead) => inPeriod(lead.createdAt, period)).length;
}

export const REASSIGNMENT_KINDS = ['escalation', 'manual', 'absence'] as const;
export type ReassignmentKind = (typeof REASSIGNMENT_KINDS)[number];

/**
 * "Escalation: an automatic reassignment caused by an expired acknowledgement
 * window; manual reassignments are counted separately." Only `escalation`
 * entries count here.
 */
export function escalationCount(
  reassignments: readonly { readonly at: number; readonly kind: ReassignmentKind }[],
  period: Period,
): number {
  return reassignments.filter((entry) => entry.kind === 'escalation' && inPeriod(entry.at, period))
    .length;
}

/** "Upcoming appointments": scheduled, starting at or after `now`. */
export function upcomingAppointmentCount(
  appointments: readonly {
    readonly startsAt: number;
    readonly status: 'scheduled' | 'cancelled';
  }[],
  now: number,
): number {
  return appointments.filter(
    (appointment) => appointment.status === 'scheduled' && appointment.startsAt >= now,
  ).length;
}

/**
 * "Payments received" in a period: collected revenue (webhook-confirmed,
 * minus refunds) restricted to payments whose confirmation falls inside it.
 */
export function paymentsReceived(
  payments: readonly (PaymentRecord & { readonly paidAt: number | null })[],
  period: Period,
  scope: CurrencyScope,
): CollectedRevenue {
  return collectedRevenue(
    payments.filter((payment) => payment.paidAt !== null && inPeriod(payment.paidAt, period)),
    scope,
  );
}
