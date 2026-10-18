/**
 * Pure business rules. This package must never import a database driver, an HTTP
 * framework or a provider SDK, so every rule here is testable in isolation (Q14).
 *
 *   assignment    round-robin lead assignment              (F3.3)
 *   availability  the "available employee" definition       (F3.2, Section 7)
 *   escalation    acknowledgement and escalation states     (F3.4, F3.5, F3.8)
 *   metrics       one function per Section 7 definition     (F5.2, I2.6, Q12)
 *   audit-events  the audit log's event vocabulary          (F4.1)
 *   permissions   base levels and configurable permissions  (F1.2, F1.3)
 *   masking       opportunity value field protection        (F1.4)
 *   custom-fields definitions and the validation built from them (F2.2, F2.4)
 *   pipeline      stage ordering and safe stage deletion    (F2.5)
 */
export * from './assignment.js';
export * from './audit-events.js';
export * from './availability.js';
export * from './custom-fields.js';
export * from './masking.js';
export * from './escalation.js';
export * from './metrics.js';
export * from './permissions.js';
export * from './pipeline.js';
