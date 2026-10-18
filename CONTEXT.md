# CONTEXT.md — handover for continuing this build

Read `CLAUDE.md` first (project rules, non-negotiable), then
`docs/problem-statement.md` (requirement IDs are the acceptance criteria), then
`docs/decisions.md` (D1–D51, every non-obvious choice and why).

## Where things stand

P0 – P10 are built. `pnpm check` is green: domain 276, server 399, web 47,
worker 12, shared 25 tests. `docs/requirements-matrix.md` has the honest
status per ID; `docs/api-contract.md` is the endpoint list the web app codes to.

What is **not** done:

- Integrations are tested against in-memory fakes only (`apps/server/src/test/fakes.ts`).
  No real Twilio / Stripe / Google / Telegram credentials have been supplied, so
  live sandbox verification is outstanding. README "Integrations" has the setup.
- Web UI is deliberately simple; a redesign is planned.
- Playwright flows exist only for accounts and CRM.
- Q7 / Q8 sweeps (P11 hardening) not started.

Module map for P5 – P10:

| Area               | Server                                                                                                                                                | Web                                        |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| Realtime           | `realtime/socket-server.ts`, `realtime/outbox-relay.ts`, `repositories/outbox.ts`                                                                     | `features/realtime/`                       |
| Dashboard          | `services/dashboard-service.ts`, `routes/dashboard.ts`                                                                                                | `features/dashboard/`                      |
| Integrations core  | `services/integration-service.ts`, `services/secret-box.ts`, `integrations/http.ts`, `integrations/registry.ts`, `repositories/integration-events.ts` | `features/integrations/`                   |
| Webhooks           | `routes/webhooks.ts` (raw body, mounted before parsers)                                                                                               | —                                          |
| Messaging (Twilio) | `services/messaging-service.ts`, `integrations/twilio/`                                                                                               | `features/messaging/`                      |
| Payments (Stripe)  | `services/payment-service.ts`, `integrations/stripe/`                                                                                                 | `features/payments/`                       |
| Calendar (Google)  | `services/calendar-service.ts`, `integrations/google/`                                                                                                | `features/calendar/`, `features/settings/` |
| Alerts (Telegram)  | `services/notification-service.ts`, job `notification.send`                                                                                           | `features/settings/`                       |

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
- The webhook router is mounted on `/api`; its raw body parser must stay
  per-route. A router-level `express.raw` swallows every other endpoint's body.
- supertest JSON-encodes a `Buffer` passed to `.send()`; send a string when the
  bytes must match a signature.
- `apps/worker` lints against `apps/server/dist` types: run
  `pnpm --filter @ubmp/server build` after changing `job-runner.ts`.
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
