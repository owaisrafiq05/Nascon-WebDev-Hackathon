# API contract: P4 web gap and P5 – P10

The endpoints the web app calls for leads, realtime, the dashboard and the four
integrations. All paths are under `/api`, all bodies are JSON, all money is in
**integer minor units** (cents) with an ISO 4217 `currency`. Every list is
paginated with `?page=&limit=` (default 25, max 100) and answers
`{ items, pageInfo: { page, limit, total, totalPages, hasNextPage, hasPreviousPage } }`.
Errors follow the existing `{ error: { code, message, hint?, details? } }` shape.

## Leads (P4, server already done)

- `GET /leads?mine=true&status=open|converted|closed|all&createdFrom=ISO&createdTo=ISO`
  item: `{ id, contactId, source, sourceLabel, status, assigneeMembershipId, assigneeEmail,
assignmentStatus: 'pending_ack'|'escalated'|'acknowledged'|..., escalationLevel, escalationTarget,
escalationCount, ownerUnavailable, assignedAt, acknowledgedAt, lastActivityAt,
acknowledgementDeadline: ISO|null, version, createdAt }`
- `POST /leads` `{ firstName, lastName?, email?, phone?, sourceLabel? }` or `{ contactId }`
  → 201 `{ leadId, assigneeMembershipId, unassignedReason: {code,message}|null }`
- `POST /leads/:leadId/acknowledge` → `{ acknowledged: boolean }`
- `POST /leads/:leadId/reassign` `{ toMembershipId? }` → `{ reassigned: boolean }` (members.manage)
- `GET /availability` → `{ members: [{ membershipId, email, baseLevel, availabilityStatus, openLeadCount }] }`
- `PATCH /availability/:membershipId` `{ status: 'available'|'busy'|'on_leave'|'offline' }`
  → `{ reassignedLeadIds: string[], flaggedLeadIds: string[] }`
- `GET /assignment-rules` / `PATCH /assignment-rules`
  `{ mode, maxOpenLeadsPerEmployee, acknowledgementWindowSeconds, escalationLevels: [{target, windowSeconds}],
backupMembershipId, managerMembershipId, idleRecoveryMinutes, recoveryMinEscalations }`
- `GET /recovery-queue` → `{ items: [{ leadId, reasons, reasonLabels: string[], sourceLabel,
assigneeMembershipId, assigneeEmail, escalationCount, createdAt, lastActivityAt }], total }`
- `GET /lead-forms`, `POST /lead-forms` `{ name, sourceLabel? }`

## Realtime (P5)

Socket.IO client: `io({ path: '/api/socket.io', withCredentials: true })` on the
same origin. The handshake uses the session cookie. One event name, `event`,
payload `{ type, payload: { ...ids }, personal?: true }`. Types:
`lead.created`, `lead.assigned`, `lead.escalated`, `lead.acknowledged`,
`message.received`, `message.updated`, `payment.updated`, `appointment.updated`,
`integration.updated`, `availability.changed`. The browser refetches; payloads
carry ids only.

## Dashboard (P5)

- `GET /dashboard?range=today|7d|30d` →
  `{ range, scope: 'personal'|'company', currency, generatedAt, hiddenTiles: string[],
tiles: [{ id, label, value: number|null, display: string, description: string,
drillDown: { path: string, query: Record<string,string> } | null, detail?: unknown }] }`
  Tile ids: `new_leads`, `open_pipeline_value` (detail `{ byStage: [{stageId, stageName, total, count, display}] }`,
  `value` null and display `Hidden` when the member may not see values), `avg_first_response`,
  `recovery_queue`, `escalations_24h`, `availability`
  (detail `{ available, busy, on_leave, offline, availableForAssignment }`),
  `upcoming_appointments`, `payments_this_month`.
  `drillDown.path` is a **web route**; `query` is passed through to that page's API call.
- `PUT /dashboard/preferences` `{ hiddenTiles: string[] }` → `{ hiddenTiles }`

## Integrations (P6, I5)

- `GET /integrations` → `{ integrations: [...] }`. Workspace providers
  (`twilio`, `stripe`, `telegram`): `{ provider, name, can: string[], cannot: string[], scope: 'workspace',
status: 'not_connected'|'connected'|'error', lastSuccessAt, lastErrorAt, lastError,
secretHints: Record<string,string> (e.g. "••••abcd"), publicConfig: Record<string,string>,
webhookUrls: Record<string,string|null>, recentErrors: [{at, kind, result, error}],
fields: { secrets: string[], public: string[] } }`.
  `google`: `{ provider:'google', name, can, cannot, scope:'employee', configured: boolean, status,
connectedEmployees, needsReconnect, lastSuccessAt, lastError, recentErrors }`.
- `PUT /integrations/:provider` — twilio `{ accountSid, authToken, from }`, stripe
  `{ secretKey, webhookSecret }`, telegram `{ botToken }`. Blank secret = keep stored value.
  → 200 `{ connected: true }`. Needs `integrations.manage`.
- `DELETE /integrations/:provider` → 204
- `GET /integrations/events?provider=&page=&limit=` → items
  `{ id, provider, direction, kind, result: 'ok'|'error'|'rejected'|'duplicate'|'ignored',
reference, httpStatus, error, transient, createdAt }`
- `GET /notifications?page=&limit=&status=` (integrations.manage) → items
  `{ id, membershipId, memberEmail, leadId, status: 'pending'|'sent'|'failed'|'skipped', attempts, lastError, sentAt, createdAt, text }`
- `GET /me/notification-settings` → `{ telegramChatId, telegramConnected, botUsername }`
- `PUT /me/notification-settings` `{ telegramChatId: string|null }` → same shape
- `POST /me/notification-settings/test` → `{ sent: true }`

## Messaging (P7, I1)

Conversation: `{ id, contactId, contactName, channel: 'whatsapp'|'sms', address,
assigneeMembershipId, assigneeEmail, lastMessageAt, lastMessagePreview, optedOut }`

Message: `{ id, conversationId, direction: 'inbound'|'outbound', body,
status: 'received'|'queued'|'sending'|'sent'|'delivered'|'read'|'failed'|'undelivered',
failureReason, failureCode, attempts, sentByMembershipId, createdAt, statusUpdatedAt }`

- `GET /conversations?mine=true` → paginated conversations (newest activity first)
- `GET /conversations/:id/messages` → `{ conversation, items: Message[] (oldest first), pageInfo }`
- `POST /conversations/:id/messages` `{ body }` → 201 Message (may come back `failed` with a reason)
- `POST /contacts/:contactId/messages` `{ body }` → 201 `{ conversationId, message }`
- `POST /messages/:id/retry` → 200 Message
- `POST /contacts/:contactId/opt-out` `{ optedOut: boolean }` → `{ optedOut }`
- Sending to an opted-out contact → 409 `CONFLICT`, message explains why.

## Payments (P8, I2)

Payment: `{ id, opportunityId, opportunityName, contactId, contactName,
requestedByMembershipId, requestedByEmail, amount, currency, description,
status: 'pending'|'paid'|'expired'|'failed'|'refunded', confirmedByWebhook, refundedAmount,
providerReference, checkoutUrl, failureReason, paidAt, expiresAt, createdAt }`

- `POST /opportunities/:id/payments` `{ amount, currency, description? }` → 201 Payment
- `GET /opportunities/:id/payments` → `{ items: Payment[] }`
- `GET /payments?status=&paidFrom=ISO` → paginated Payments
- `POST /payments/:id/send` → `{ sent: true, messageId }` (sends the link by messaging)
- Summary: `GET /payments/summary` → `{ currency, collected: {gross, refunded, net, paymentCount},
projected: {openOpportunities, unpaidRequests, total} }` (I2.6)

## Calendar (P9, I3)

Appointment: `{ id, contactId, contactName, opportunityId, employeeMembershipId,
employeeEmail, title, notes, startsAt, endsAt, timeZone, status: 'scheduled'|'cancelled',
googleEventLink, version, createdAt }`

- `GET /calendar/connection` → `{ configured, status: 'not_connected'|'connected'|'needs_reconnect', googleEmail, timeZone }`
- `POST /calendar/connect` → `{ authorizationUrl }` (browser navigates there; Google returns to
  `/api/integrations/google/callback`, which redirects to the web app `/settings?calendar=connected|error`)
- `DELETE /calendar/connection` → 204
- `GET /calendar/employees` → `{ items: [{ membershipId, email, name, calendarStatus, timeZone, bookable, reason }] }`
- `GET /calendar/busy?membershipId=&from=ISO&to=ISO` → `{ busy: [{start, end}], timeZone }`
- `POST /appointments` `{ contactId, opportunityId?, employeeMembershipId, title, notes?,
startsAt: ISO, endsAt: ISO, timeZone, allowOverlap?: boolean }` → 201 Appointment;
  overlap without `allowOverlap` → 409 `CONFLICT` with `details.conflicts: [{start,end}]`
- `GET /appointments?contactId=&opportunityId=&upcoming=true` → paginated Appointments
- `PATCH /appointments/:id` `{ startsAt, endsAt, timeZone, title?, notes?, version, allowOverlap? }` → Appointment
- `POST /appointments/:id/cancel` → Appointment

## Customer view (F2.8)

`GET /contacts/:id/view` keeps its shape; `conversations`, `payments` and
`appointments` become `{ items: [...], availableFrom: null, reason: null }`
holding Conversation, Payment and Appointment objects as above.
