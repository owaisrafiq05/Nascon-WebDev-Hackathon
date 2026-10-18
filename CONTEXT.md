# CONTEXT.md — handover for continuing this build

Read `CLAUDE.md` first (project rules, non-negotiable), then
`docs/problem-statement.md` (requirement IDs are the acceptance criteria), then
`docs/decisions.md` (D1–D51, every non-obvious choice and why).

## Where things stand

| Phase                     | State                        | Pushed                                                           |
| ------------------------- | ---------------------------- | ---------------------------------------------------------------- |
| P0 monorepo scaffold      | **done**                     | `bf20c6e` … `eb6cd0c`                                            |
| P1 domain core            | **done**                     | `1a00a94`, `bd28773`, `be582e2`, `62cb8c5`                       |
| P2 accounts, roles, audit | **done**                     | `fbd5a21`, `b00b2c9`, `b316f18`, `06ccecc`, `0868237`            |
| P3 customizable CRM       | **done**                     | `5d4de9e`, `25658c6`, `6ebfb9b`, `3dce2f8`, `1a25981`, `c2d2679` |
| P4 leads/escalation       | **server done**, web pending | `ae2d391`                                                        |
| P5 realtime + dashboard   | **not started**              | —                                                                |
| P6–P12                    | not started                  | —                                                                |

`main` is green at `ae2d391`: **654 tests** + 6 Playwright flows,
`pnpm check` and `pnpm build` both exit 0.

Counts: domain 271 · server 330 · shared 25 · web 16 · worker 12.

## Remaining work, in order

### 1. P4 web module (`web-leads`) — the only P4 gap

Server side is complete and tested. Missing UI:

- **Lead inbox** for employees: `GET /api/leads?mine=true`. Each lead has
  `acknowledgementDeadline` (ISO) — render a live countdown and an Acknowledge
  button calling `POST /api/leads/:leadId/acknowledge`.
- **Availability toggle** for the current user:
  `PATCH /api/availability/:membershipId` with `{ status }`. Response carries
  `reassignedLeadIds` and `flaggedLeadIds` — show both, that is F3.6's "visible".
- **Manager views**: availability board (`GET /api/availability`), assignment
  rule editor (`GET`/`PATCH /api/assignment-rules`), recovery queue
  (`GET /api/recovery-queue`, each item has `reasonLabels` already in words),
  manual reassign (`POST /api/leads/:leadId/reassign`).
- Leads flagged `ownerUnavailable` must show "owner unavailable".

Follow the existing patterns: `apps/web/src/features/crm/crm-api.ts` for the
Zod-parsed data layer, `components/{Field,Button,Alert}.tsx` for form
primitives. Keyboard-operable alternatives are mandatory (Q8) — see
`MoveToStageMenu.tsx` for the precedent.

### 2. P5 realtime + dashboard

**Partially started, uncommitted.** Confirmed state at handover:

- `socket.io` **is** in `apps/server/package.json` (uncommitted, along with
  `pnpm-lock.yaml`).
- `socket.io-client` is **not** installed in `apps/web` — add it.
- No P5 source files exist. `apps/server/src/realtime/socket-server.ts` was
  being written when work stopped and was never saved.

Either commit the `socket.io` dependency with the first P5 module or run
`git checkout apps/server/package.json pnpm-lock.yaml` to start clean.

Plan as specified by the user:

- `apps/server/src/realtime/socket-server.ts`: Socket.IO on the HTTP server,
  path `/api/socket.io`. Handshake authenticates the **same** session cookie
  (`SESSION_COOKIE` from `http/middleware/authenticate.ts`, then
  `resolveSession`). Reject unauthenticated handshakes outright.
  Rooms: `workspace:{id}` and `user:{membershipId}`. Never emit outside a room
  — that is what makes cross-workspace leakage structurally impossible.
- **Payloads minimal** (ids + type only); the browser refetches through the
  permission-checked endpoint, so a socket cannot bypass `requirePermission`.
- **Outbox relay**: P4 already writes `OutboxEventModel` rows inside the same
  transaction as each change (`apps/server/src/db/models/outbox-event.ts`).
  The API process must poll undelivered rows, emit, then set `deliveredAt`
  _after_ the emit — a duplicate is harmless (client refetches), a loss is not.
- `GET /api/dashboard?range=today|7d|30d`: must call **only** the metric
  functions in `packages/domain/src/metrics.ts`. Do not re-implement any
  Section 7 definition — that is the whole point of Q12. Role-aware: a User
  gets personal figures, Owner/Admin company-wide. Opportunity values go
  through `maskOpportunityValues`.
- Dashboard preferences stored per user **on the server**, not localStorage
  (F5.5 says "remembered"; the user explicitly required server-side).
- Web dashboard: tiles with text labels (not colour alone), at least three
  tiles linking to a filtered list, show/hide menu, loading skeletons, error
  state with retry.

Required tests: dashboard figure equals the number computed from the same
records on the list page; User sees personal only, Owner company-wide; a client
in workspace A never receives workspace B events; unauthenticated handshake
rejected; Playwright — a lead created in one browser context appears on
another's dashboard without refresh.

Push modules: `realtime-server`, `realtime-relay`, `dashboard-api`,
`dashboard-web`.

### 3. P6–P12

Unstarted, per the master plan in the original prompt. P7 (Twilio), P8 (Stripe),
P9 (Google Calendar), P10 (Telegram) each need credentials from the user —
`.env.example` already declares every variable.

## How to run it

```bash
pnpm install
cp .env.example .env
docker compose up -d        # or see the mongod note below
pnpm dev                    # web :5173, API :4000, worker
pnpm check                  # lint + format + typecheck + test
pnpm --filter @ubmp/web e2e  # needs the stack running
```

**Docker is not installed on this machine.** Every live verification so far used
the `mongod` binary that `mongodb-memory-server` caches, started by hand as a
single-node replica set — a replica set is required because sign-up and every
ownership change use transactions:

```bash
MONGOD=$(ls node_modules/.cache/mongodb-memory-server/mongod-* | head -1)
"$MONGOD" --replSet rs0 --port 27017 --bind_ip 127.0.0.1 --dbpath /tmp/ubmpdb &
# then initiate rs0 once: rs.initiate({_id:'rs0',members:[{_id:0,host:'127.0.0.1:27017'}]})
```

`docker-compose.yml` is written and committed but has never been exercised
(decisions D10).

## Things that will bite you

- **`pnpm check` must be green before any commit.** I pushed `1a25981` with a
  lint error and had to follow up with `c2d2679`. Read the exit code _before_
  committing, not after.
- **No `Co-Authored-By` or AI attribution** in commit messages. Verify with
  `./scripts/verify-commit-msg.sh HEAD`.
- Mongoose 9: multi-document `create()` inside a session needs
  `{ session, ordered: true }`. Hooks are promise-based, not callback-based.
- `exactOptionalPropertyTypes` is on. `Partial<T>` does **not** admit
  `undefined`, so Zod `.partial()` output needs an explicitly written update
  interface (see `CompanyUpdateInput` in `crm-service.ts`).
- Models holding a custom-field map need `minimize: false`, or Mongoose strips
  `{}` and readers must handle both absent and empty.
- Express 5 types `req.params` values as `string | string[] | undefined` — use
  `requireParam(req, name)` from `http/params.ts`.
- The shared test app's rate limiters keep counters across tests. `testConfig`
  sets a high `publicFormRateLimit`; a limiter's own test builds its own app
  with a low value.
- Playwright locators: scope to a region (`getByRole('region', { name: … })`)
  when a label repeats. An ambiguous locator once revealed a genuine a11y
  defect — repeated controls need unique accessible names (D42).

## Architecture invariants — do not break these

- `packages/domain` imports nothing. No DB driver, no HTTP framework, no SDK.
- Every tenant query goes through `scoped(model, { workspaceId })` from
  `apps/server/src/repositories/scoped.ts`. `workspaceId` always comes from the
  session, never a URL or body.
- Another workspace's record answers **404, never 403** — and a malformed id
  answers 404 too, so the two are indistinguishable.
- The audit trail is append-only, guarded three ways: no mutating repository
  method, GET-only routes, schema rejects non-insert writes.
- Mutations write their audit and activity entries in the **same transaction**
  as the change.
- Ownership changes are conditional on `version` (optimistic concurrency).
- Business timers live in `scheduled_jobs` and are claimed with a lease; never
  an in-memory `setTimeout`.
- Opportunity value masking is one function, `packages/domain/src/masking.ts`,
  applied on every read path including exports and saved lists.

## Requirement status

`docs/requirements-matrix.md` tracks every ID honestly, including partials and
why. Summary: F1.x, F2.x, F4.x **done**. F3.x done server-side, UI pending.
F5.x not started. I1–I5 not started. Q1, Q2, Q3, Q6, Q10, Q13, Q14 done; the
rest partial pending P11's hardening pass.
