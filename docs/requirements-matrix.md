# Requirements matrix

Tracks every requirement ID from `problem-statement.docx` against the code that
delivers it. Status: **done** · **partial** (with reason) · **not started**.

"Fakes" below means the provider path runs end to end in API tests against an
in-memory provider (`apps/server/src/test/fakes.ts`), with real signature
verification, idempotency and persistence. **Live** means checked against the
real sandbox. No provider credentials have been supplied yet, so every
integration row is code-complete and fake-tested but **not yet live-verified**.

## F1. Accounts, roles and permissions — P2

| ID   | Status | Where                                                                                                                       |
| ---- | ------ | --------------------------------------------------------------------------------------------------------------------------- |
| F1.1 | done   | `auth-service.ts`, `routes/auth.ts`, `auth.test.ts`                                                                         |
| F1.2 | done   | `membership-service.ts`, `members.test.ts`                                                                                  |
| F1.3 | done   | `packages/domain/src/permissions.ts`, `permission-set-service.ts`                                                           |
| F1.4 | done   | `packages/domain/src/masking.ts`; dashboard pipeline tile shows `Hidden`                                                    |
| F1.5 | done   | `require-permission.ts` on every route; tests per module                                                                    |
| F1.6 | done   | `workspaceId` from session on every query; 404 for other workspaces; sockets join workspace rooms only (`realtime.test.ts`) |

## F2. Customizable CRM — P3

| ID          | Status | Where                                                                                |
| ----------- | ------ | ------------------------------------------------------------------------------------ |
| F2.1 – F2.6 | done   | `crm-service.ts`, `pipeline-service.ts`, `saved-lists.ts`                            |
| F2.7        | done   | `activity-repository.ts`; messages, payments and appointments now write entries      |
| F2.8        | done   | `customer-view-service.ts` fills conversations, payments, appointments; e2e opens it |

## F3. Leads — P1 rules, P4 wiring, P10 alerts

| ID          | Status       | Where                                                                                                                      |
| ----------- | ------------ | -------------------------------------------------------------------------------------------------------------------------- |
| F3.1        | done         | web form, manual entry, and inbound message (`messaging-service.ts receiveInboundMessage`)                                 |
| F3.2 – F3.8 | done         | `lead-service.ts`, worker; UI `features/leads/`                                                                            |
| F3.4        | done         | Section 7 "recorded action" now acknowledges: notes, stage changes, messages, appointments (`acknowledgeOnRecordedAction`) |
| F3.9        | done (fakes) | escalation queues a Telegram alert in the same transaction (`notification-service.ts`)                                     |

## F4. Audit history — P2

F4.1 – F4.3: **done**. Assignment rule changes now audited with before/after;
integration connect/update/disconnect audited without secrets.

## F5. Operational dashboard — P5

| ID   | Status | Where                                                                                                 |
| ---- | ------ | ----------------------------------------------------------------------------------------------------- |
| F5.1 | done   | `dashboard-service.ts`, all eight figures                                                             |
| F5.2 | done   | every figure from `packages/domain/src/metrics.ts`; test asserts tile = drill-down list total         |
| F5.3 | done   | drill-downs: new leads, pipeline, recovery, escalations (audit), availability, appointments, payments |
| F5.4 | done   | `MEMBERS_MANAGE` holders get company scope, others personal; tested                                   |
| F5.5 | done   | `PUT /dashboard/preferences`, stored on the membership (server-side)                                  |

## I1 – I5. Integrations — P6 – P10

| ID          | Status       | Notes                                                                                                                                                                                                                                                |
| ----------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I1.1 – I1.9 | done (fakes) | Twilio webhook signature (HMAC-SHA1), MessageSid idempotency, contact match by digits, STOP opt-out, status callbacks forward-only, failed sends kept with reason and retryable. Needs live sandbox check.                                           |
| I2.1 – I2.8 | done (fakes) | Stripe Checkout via REST, `Stripe-Signature` verified on raw body with 300 s tolerance, event-id idempotency, expired/failed/refunded, collected vs projected via domain functions, no card fields. Needs live test-mode check.                      |
| I3.1 – I3.7 | done (fakes) | OAuth with signed member-bound state, encrypted tokens, auto refresh, `needs_reconnect` on `invalid_grant`, freebusy overlap warning, UTC + IANA zone storage, reschedule/cancel sync, non-bookable employees with reason. Needs a Google test user. |
| I4.1 – I4.4 | done (fakes) | Telegram bot per workspace, chat id per employee, 3 attempts then `failed`, visible on Integrations page.                                                                                                                                            |
| I5.1 – I5.8 | done         | Integrations page with status, last success, recent errors, can/cannot text; per-workspace encrypted credentials; sync history; transient retry; permission + audit; provider failure isolated (timeouts, try/catch, no shared state).               |

## Section 6. Quality

| ID                       | Status  | Notes                                                                              |
| ------------------------ | ------- | ---------------------------------------------------------------------------------- |
| Q1, Q2, Q3, Q6, Q13, Q14 | done    |                                                                                    |
| Q4                       | done    | version checks on leads, opportunities, appointments, payments                     |
| Q5                       | done    | leases, idempotency keys, provider event claims inside transactions                |
| Q7                       | done    | `e2e/responsive.spec.ts`: every screen at 360, 768, 1280 px, no sideways scroll    |
| Q8                       | partial | sweep checks every control has a name; no contrast or full keyboard audit yet      |
| Q9                       | done    | every new list paginated (default 25, max 100)                                     |
| Q10                      | done    | every action shows loading, success and error; provider errors explained           |
| Q11                      | done    | Socket.IO + outbox relay; live-verified that a created lead reaches another socket |
| Q12                      | done    | dashboard and lists share the same filters and domain functions                    |

## Known gaps

- Playwright covers accounts, CRM, leads, realtime, dashboard and the
  integration screens without credentials. Messaging, payment and calendar
  flows that need a live provider are covered by API tests against fakes only.
- Integrations not yet exercised against real sandboxes (credentials needed).
  `pnpm check:integrations` verifies credentials once they are in `.env`.
