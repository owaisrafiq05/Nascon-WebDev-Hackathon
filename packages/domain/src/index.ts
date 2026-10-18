/**
 * Pure business rules. This package must never import a database driver, an HTTP
 * framework or a provider SDK, so every rule here is testable in isolation (Q14).
 */
export * from './assignment.js';
export * from './availability.js';
export * from './escalation.js';
