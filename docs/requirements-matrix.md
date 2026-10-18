# Requirements matrix

Tracks every requirement ID from `problem-statement.docx` against the phase that
delivers it and the code that does. Updated at the end of each phase.

Status: **done** · **partial** (with reason) · **not started**

## F1. Accounts, roles and permissions — P2

| ID   | Status      | Where                                                                                                                                                                                   |
| ---- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1.1 | not started | P2                                                                                                                                                                                      |
| F1.2 | not started | P2                                                                                                                                                                                      |
| F1.3 | not started | P2                                                                                                                                                                                      |
| F1.4 | not started | P2                                                                                                                                                                                      |
| F1.5 | not started | P2                                                                                                                                                                                      |
| F1.6 | partial     | The rule is encoded: `notFound` in `packages/shared/src/errors.ts` is used for "missing" and "another workspace" alike, and is tested. Enforcement arrives with the repositories in P2. |

## F2. Customizable CRM — P3

F2.1 – F2.8: not started.

## F3. Lead capture, assignment, acknowledgement, escalation — P1 (rules), P4 (wiring)

All rules now exist and are unit-tested in `packages/domain`. Every F3 row stays
**partial** until P4 persists the state, runs the timers in the worker and puts
screens on top; none of it is reachable by a user yet.

| ID   | Status      | Where                                                                                                                                                                                                                                                                                            |
| ---- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| F3.1 | not started | P4                                                                                                                                                                                                                                                                                               |
| F3.2 | partial     | `availability.ts` fixes the four statuses and which count as absence. Setting them is P4.                                                                                                                                                                                                        |
| F3.3 | partial     | **Rule done.** `assignment.ts` `assignLead` does round-robin among Available employees under the max-open-leads limit, with the cursor passed in and out. Refusals name one of five causes. 27 tests. Admin configuration and the API are P4.                                                    |
| F3.4 | partial     | **Rule done.** `acknowledgementDeadline` gives the countdown target and `acknowledge` settles the lead. The notification and the visible timer are P4.                                                                                                                                           |
| F3.5 | partial     | **Rule done.** `nextEscalation` walks assignee, next eligible, backup, manager, with the level count and each duration from configuration. 32 tests.                                                                                                                                             |
| F3.6 | partial     | **Rule done.** `reassignForAbsence` moves an unacknowledged lead and leaves an acknowledged one with its owner, which is the defined treatment. Triggering it on a status change is P4.                                                                                                          |
| F3.7 | partial     | **Rule done.** `recoveryQueueMembership` returns every reason that applies, from the three Section 7 grounds. The page is P4.                                                                                                                                                                    |
| F3.8 | partial     | **Rule done.** `nextEscalation` is pure, so two timers on one stored state both compute level n+1, never n+2; each window starts at the previous deadline, so no level is skipped or repeated. Plus the worker's non-overlapping ticker. The conditional write that makes it exactly-once is P4. |
| F3.9 | not started | P10                                                                                                                                                                                                                                                                                              |

## F4. Audit history — P2

F4.1 – F4.3: not started.

## F5. Operational dashboard — P5

F5.1, F5.3, F5.4 and F5.5: not started.

| ID   | Status  | Where                                                                                                                                                                                       |
| ---- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F5.2 | partial | **Definitions done.** `packages/domain/src/metrics.ts` holds one function per Section 7 definition and is the only place a figure is computed. 71 tests. The screens that call them are P5. |

## I1 – I5. Integrations — P6 – P10

All not started. `.env.example` declares every credential each provider will
need, and `docs/decisions.md` D7 explains why they are not validated yet.

## Section 6. Quality requirements

| ID  | Status      | Where it stands after P0                                                                                                                                                                                                                                                                                                                                                                                 |
| --- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | not started | P2                                                                                                                                                                                                                                                                                                                                                                                                       |
| Q2  | partial     | The `notFound`-for-another-workspace rule is encoded and tested. Endpoint enforcement is P2.                                                                                                                                                                                                                                                                                                             |
| Q3  | partial     | Helmet, a CORS allow-list, a 1 MB body limit and Zod-based validation plumbing are in place and tested in `apps/server/src/http/app.test.ts`. CSRF and per-endpoint schemas arrive with the first mutating endpoint in P2.                                                                                                                                                                               |
| Q4  | not started | P3, P4                                                                                                                                                                                                                                                                                                                                                                                                   |
| Q5  | partial     | Non-overlapping worker ticks, plus an idempotent, skip-free `nextEscalation` that two concurrent timers resolve to a single step. Lease-based job claims and the restart proof are P4.                                                                                                                                                                                                                   |
| Q6  | **done**    | `apps/server/src/db/mongoose.ts` owns the connection; `mongoose.test.ts` writes a document, disconnects, reconnects and reads it back. Verified live against a real single-node replica set: health went `up` → `degraded` → `up` across a database restart without restarting the API, and the set's configuration survived. The `docker-compose.yml` wrapper itself is unverified — see decisions D10. |
| Q7  | partial     | The scaffold page is fluid with no horizontal scroll and `overflow-x: hidden` is set globally. The Playwright width sweep is P11.                                                                                                                                                                                                                                                                        |
| Q8  | partial     | The status card labels its region, announces changes with `aria-live`, carries every status in words and a symbol as well as colour, has a visible focus ring, and honours `prefers-reduced-motion`. Covered by tests. A full keyboard sweep is P11.                                                                                                                                                     |
| Q9  | partial     | The pagination contract exists and is tested (`packages/shared/src/pagination.ts`, default 25, max 100). No list endpoint exists yet.                                                                                                                                                                                                                                                                    |
| Q10 | partial     | `ApiError` carries the server's message, hint and field errors; the status card renders loading, success and error states; all tested. Applies to every later screen.                                                                                                                                                                                                                                    |
| Q11 | not started | P5                                                                                                                                                                                                                                                                                                                                                                                                       |
| Q12 | partial     | **Definitions done.** Every Section 7 figure is one function in `packages/domain/src/metrics.ts`, and `availableEmployeeCount` delegates to the same predicate the assignment engine uses, so the dashboard cannot report someone as available whom the engine would refuse. Shown consistent once P5 puts screens on it.                                                                                |
| Q13 | **done**    | Zod-validated config in both Node processes, `.env.example` with every variable, no secrets in the repository, README setup instructions.                                                                                                                                                                                                                                                                |
| Q14 | **done**    | Domain rules, data access, integrations and presentation are separate packages with a one-way dependency rule, documented in `docs/architecture.md`.                                                                                                                                                                                                                                                     |
