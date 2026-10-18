/**
 * Employee availability (F3.2) and the "available employee" definition from the
 * glossary in Section 7:
 *
 *   "A user whose status is Available and whose open-lead count is below the
 *    configured limit."
 *
 * The assignment engine (P1), the dashboard availability figure (F5.1) and the
 * reassignment-on-absence rule (F3.6) all call this one function, so none of them
 * can drift from the definition (Q12).
 */
export const AVAILABILITY_STATUSES = ['available', 'busy', 'on_leave', 'offline'] as const;

export type AvailabilityStatus = (typeof AVAILABILITY_STATUSES)[number];

export function isAvailabilityStatus(value: unknown): value is AvailabilityStatus {
  return typeof value === 'string' && (AVAILABILITY_STATUSES as readonly string[]).includes(value);
}

/**
 * Statuses that mean the employee is away, not merely unavailable right now.
 * Setting one of these immediately reassigns their unacknowledged leads (F3.6).
 */
export const ABSENT_STATUSES: readonly AvailabilityStatus[] = ['on_leave', 'offline'];

export function isAbsent(status: AvailabilityStatus): boolean {
  return ABSENT_STATUSES.includes(status);
}

/** The minimum an employee record must expose for availability to be decided. */
export interface EmployeeAvailability {
  readonly status: AvailabilityStatus;
  /** Leads currently assigned to this employee that are not yet closed. */
  readonly openLeadCount: number;
}

export interface AssignmentLimits {
  /** Maximum number of open leads one employee may hold (F3.3). */
  readonly maxOpenLeadsPerEmployee: number;
}

/**
 * The single definition of "available employee". `Busy` is deliberately not
 * available: F3.3 requires that employees who are not Available never receive
 * leads.
 */
export function isAvailableEmployee(
  employee: EmployeeAvailability,
  limits: AssignmentLimits,
): boolean {
  if (employee.status !== 'available') return false;
  return employee.openLeadCount < limits.maxOpenLeadsPerEmployee;
}
