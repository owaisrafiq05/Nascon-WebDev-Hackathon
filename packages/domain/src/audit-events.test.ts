import { describe, expect, it } from 'vitest';

import {
  ALL_AUDIT_EVENT_TYPES,
  AUDIT_EVENT_TYPES,
  auditEventSubject,
  isAuditEventType,
  isSystemAuditEvent,
} from './audit-events.js';

describe('AUDIT_EVENT_TYPES', () => {
  it('covers every category F4.1 requires to be recorded', () => {
    // Assignment, acknowledgement, escalation, reassignment, role or permission
    // changes, field or pipeline configuration changes, integration connection
    // changes, and deletions.
    const required = [
      AUDIT_EVENT_TYPES.LEAD_ASSIGNED,
      AUDIT_EVENT_TYPES.LEAD_ACKNOWLEDGED,
      AUDIT_EVENT_TYPES.LEAD_ESCALATED,
      AUDIT_EVENT_TYPES.LEAD_REASSIGNED_MANUAL,
      AUDIT_EVENT_TYPES.LEAD_REASSIGNED_ABSENCE,
      AUDIT_EVENT_TYPES.USER_ROLE_CHANGED,
      AUDIT_EVENT_TYPES.USER_PERMISSIONS_CHANGED,
      AUDIT_EVENT_TYPES.CUSTOM_FIELD_CREATED,
      AUDIT_EVENT_TYPES.PIPELINE_UPDATED,
      AUDIT_EVENT_TYPES.INTEGRATION_CONNECTED,
      AUDIT_EVENT_TYPES.CONTACT_DELETED,
    ];

    for (const type of required) {
      expect(ALL_AUDIT_EVENT_TYPES).toContain(type);
    }
  });

  it('has no duplicate stored values', () => {
    expect(new Set(ALL_AUDIT_EVENT_TYPES).size).toBe(ALL_AUDIT_EVENT_TYPES.length);
  });

  it('uses the subject.verb shape throughout, so the viewer can group', () => {
    for (const type of ALL_AUDIT_EVENT_TYPES) {
      expect(type).toMatch(/^[a-z_]+\.[a-z_]+$/);
    }
  });

  it('has no event for editing or deleting an audit entry (F4.3)', () => {
    expect(ALL_AUDIT_EVENT_TYPES.some((type) => type.startsWith('audit.'))).toBe(false);
  });
});

describe('isAuditEventType', () => {
  it('accepts every declared value', () => {
    for (const type of ALL_AUDIT_EVENT_TYPES) {
      expect(isAuditEventType(type)).toBe(true);
    }
  });

  it('rejects anything else, so a filter cannot query an unknown type', () => {
    expect(isAuditEventType('lead.exploded')).toBe(false);
    expect(isAuditEventType('LEAD_ASSIGNED')).toBe(false);
    expect(isAuditEventType(undefined)).toBe(false);
    expect(isAuditEventType(7)).toBe(false);
  });
});

describe('auditEventSubject', () => {
  it('returns the part before the dot', () => {
    expect(auditEventSubject(AUDIT_EVENT_TYPES.LEAD_ESCALATED)).toBe('lead');
    expect(auditEventSubject(AUDIT_EVENT_TYPES.INTEGRATION_CONNECTED)).toBe('integration');
  });
});

describe('isSystemAuditEvent', () => {
  it('marks the events no human triggers', () => {
    expect(isSystemAuditEvent(AUDIT_EVENT_TYPES.LEAD_ESCALATED)).toBe(true);
    expect(isSystemAuditEvent(AUDIT_EVENT_TYPES.LEAD_ASSIGNED)).toBe(true);
  });

  it('does not mark an action a person took', () => {
    expect(isSystemAuditEvent(AUDIT_EVENT_TYPES.LEAD_ACKNOWLEDGED)).toBe(false);
    expect(isSystemAuditEvent(AUDIT_EVENT_TYPES.USER_ROLE_CHANGED)).toBe(false);
    expect(isSystemAuditEvent(AUDIT_EVENT_TYPES.LEAD_REASSIGNED_MANUAL)).toBe(false);
  });
});
