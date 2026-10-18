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

| ID   | Status      | Where                                                                                                                                                                                         |
| ---- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F3.1 | not started | P4                                                                                                                                                                                            |
| F3.2 | partial     | `AVAILABILITY_STATUSES` in `packages/domain/src/availability.ts` fixes the four statuses; the UI and the API to set them are P4.                                                              |
| F3.3 | partial     | `isAvailableEmployee` implements the glossary definition, including the max-open-leads limit and the rule that a non-Available employee never qualifies. The round-robin engine itself is P1. |
| F3.4 | not started | P4                                                                                                                                                                                            |
| F3.5 | not started | P1 (state machine), P4 (wiring)                                                                                                                                                               |
| F3.6 | partial     | `isAbsent` fixes which statuses count as absence. The reassignment itself is P4.                                                                                                              |
| F3.7 | not started | P4                                                                                                                                                                                            |
| F3.8 | partial     | The worker's ticker cannot overlap ticks, which is the process-level half of this; tested in `apps/worker/src/ticker.test.ts`. The database-level claim is P4.                                |
| F3.9 | not started | P10                                                                                                                                                                                           |

## F4. Audit history — P2

F4.1 – F4.3: not started.

## F5. Operational dashboard — P5

F5.1 – F5.5: not started.

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
| Q5  | partial     | Non-overlapping worker ticks, tested. Lease-based job claims and the restart proof are P4.                                                                                                                                                                                                                                                                                                               |
| Q6  | **done**    | `apps/server/src/db/mongoose.ts` owns the connection; `mongoose.test.ts` writes a document, disconnects, reconnects and reads it back. Verified live against a real single-node replica set: health went `up` → `degraded` → `up` across a database restart without restarting the API, and the set's configuration survived. The `docker-compose.yml` wrapper itself is unverified — see decisions D10. |
| Q7  | partial     | The scaffold page is fluid with no horizontal scroll and `overflow-x: hidden` is set globally. The Playwright width sweep is P11.                                                                                                                                                                                                                                                                        |
| Q8  | partial     | The status card labels its region, announces changes with `aria-live`, carries every status in words and a symbol as well as colour, has a visible focus ring, and honours `prefers-reduced-motion`. Covered by tests. A full keyboard sweep is P11.                                                                                                                                                     |
| Q9  | partial     | The pagination contract exists and is tested (`packages/shared/src/pagination.ts`, default 25, max 100). No list endpoint exists yet.                                                                                                                                                                                                                                                                    |
| Q10 | partial     | `ApiError` carries the server's message, hint and field errors; the status card renders loading, success and error states; all tested. Applies to every later screen.                                                                                                                                                                                                                                    |
| Q11 | not started | P5                                                                                                                                                                                                                                                                                                                                                                                                       |
| Q12 | partial     | The health contract is declared once in `packages/shared` and used by both sides. The metric definitions that this requirement is really about are P1.                                                                                                                                                                                                                                                   |
| Q13 | **done**    | Zod-validated config in both Node processes, `.env.example` with every variable, no secrets in the repository, README setup instructions.                                                                                                                                                                                                                                                                |
| Q14 | **done**    | Domain rules, data access, integrations and presentation are separate packages with a one-way dependency rule, documented in `docs/architecture.md`.                                                                                                                                                                                                                                                     |
