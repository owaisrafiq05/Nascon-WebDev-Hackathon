/**
 * Pure business rules. This package must never import a database driver, an HTTP
 * framework or a provider SDK, so every rule here is testable in isolation (Q14).
 *
 * Phase 1 adds, alongside the availability rules already here:
 *   - the round-robin assignment engine (F3.3)
 *   - the escalation state machine (F3.5, F3.8)
 *   - the metric definitions from Section 7 used by every dashboard and export
 *     (F5.2, I2.6, Q12)
 */
export * from './availability.js';
