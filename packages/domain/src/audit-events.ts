/**
 * The audit log's event vocabulary (F4.1).
 *
 * Declared here, in the domain, because the server writes these values, the
 * worker writes some of them too, and the web app's audit viewer filters by
 * them (F4.2). One list means a filter cannot drift from what is recorded.
 *
 * Values are the stored strings: `<subject>.<past-tense verb>`, dotted so the
 * viewer can group by subject. They are persisted data, so an existing value is
 * never renamed; a new one is added instead.
 *
 * Entries are append-only. Nothing in the platform updates or deletes one
 * (F4.3), which is why there is no `audit.*` event for editing an audit entry.
 */
export const AUDIT_EVENT_TYPES = {
  // --- Lead ownership (F3.x). The reason the platform exists.
  LEAD_CAPTURED: 'lead.captured',
  LEAD_ASSIGNED: 'lead.assigned',
  LEAD_ACKNOWLEDGED: 'lead.acknowledged',
  LEAD_ESCALATED: 'lead.escalated',
  LEAD_REASSIGNED_MANUAL: 'lead.reassigned_manual',
  LEAD_REASSIGNED_ABSENCE: 'lead.reassigned_absence',
  LEAD_RECOVERED: 'lead.recovered',

  // --- Accounts, roles and permissions (F1.x)
  USER_INVITED: 'user.invited',
  USER_ROLE_CHANGED: 'user.role_changed',
  USER_PERMISSIONS_CHANGED: 'user.permissions_changed',
  USER_AVAILABILITY_CHANGED: 'user.availability_changed',
  USER_DELETED: 'user.deleted',
  ROLE_CREATED: 'role.created',
  ROLE_UPDATED: 'role.updated',
  ROLE_DELETED: 'role.deleted',

  // --- Configuration changes (F2.x, F3.3)
  PIPELINE_CREATED: 'pipeline.created',
  PIPELINE_UPDATED: 'pipeline.updated',
  PIPELINE_DELETED: 'pipeline.deleted',
  STAGE_CREATED: 'stage.created',
  STAGE_UPDATED: 'stage.updated',
  STAGE_REORDERED: 'stage.reordered',
  STAGE_DELETED: 'stage.deleted',
  CUSTOM_FIELD_CREATED: 'custom_field.created',
  CUSTOM_FIELD_UPDATED: 'custom_field.updated',
  CUSTOM_FIELD_DELETED: 'custom_field.deleted',
  ASSIGNMENT_RULES_UPDATED: 'assignment_rules.updated',
  ESCALATION_CONFIG_UPDATED: 'escalation_config.updated',

  // --- CRM record deletions. Edits live in the activity history; deletions are
  // audited because they cannot be seen on a record that no longer exists.
  CONTACT_DELETED: 'contact.deleted',
  COMPANY_DELETED: 'company.deleted',
  OPPORTUNITY_DELETED: 'opportunity.deleted',

  // --- Data leaving the workspace (F1.3 export permission)
  RECORDS_EXPORTED: 'records.exported',

  // --- Integrations (I5.7)
  INTEGRATION_CONNECTED: 'integration.connected',
  INTEGRATION_UPDATED: 'integration.updated',
  INTEGRATION_DISCONNECTED: 'integration.disconnected',
} as const;

export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[keyof typeof AUDIT_EVENT_TYPES];

export const ALL_AUDIT_EVENT_TYPES: readonly AuditEventType[] = Object.values(AUDIT_EVENT_TYPES);

export function isAuditEventType(value: unknown): value is AuditEventType {
  return typeof value === 'string' && (ALL_AUDIT_EVENT_TYPES as readonly string[]).includes(value);
}

/**
 * The subject part of an event type, used to group the audit viewer's filter
 * (F4.2). `'lead.escalated'` gives `'lead'`.
 */
export function auditEventSubject(type: AuditEventType): string {
  const [subject] = type.split('.');
  return subject ?? type;
}

/**
 * Events the system raises on its own, with no human actor. The audit entry
 * records "system" as the actor for these (F4.1), and the viewer explains why
 * no user is named.
 */
export const SYSTEM_AUDIT_EVENT_TYPES: readonly AuditEventType[] = [
  AUDIT_EVENT_TYPES.LEAD_CAPTURED,
  AUDIT_EVENT_TYPES.LEAD_ASSIGNED,
  AUDIT_EVENT_TYPES.LEAD_ESCALATED,
  AUDIT_EVENT_TYPES.LEAD_REASSIGNED_ABSENCE,
];

export function isSystemAuditEvent(type: AuditEventType): boolean {
  return SYSTEM_AUDIT_EVENT_TYPES.includes(type);
}
