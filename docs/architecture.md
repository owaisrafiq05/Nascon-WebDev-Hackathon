# Architecture

## Processes

Three processes share one MongoDB database.

```
                    ┌──────────────┐
  browser ─────────▶│  apps/web    │  Vite dev server, port 5173
                    │  React SPA   │  proxies /api ──┐
                    └──────────────┘                 │
                                                     ▼
                    ┌───────────────────────────────────────┐
  providers ───────▶│  apps/server                          │  port 4000
  (webhooks)        │  Express: routes → controllers →      │
                    │  services → repositories              │
                    └───────────────────┬───────────────────┘
                                        │
                                   ┌────▼────┐
                                   │ MongoDB │  replica set rs0
                                   └────▲────┘
                                        │
                    ┌───────────────────┴───────────────────┐
                    │  apps/worker                          │
                    │  claims leased scheduled_jobs,        │
                    │  runs escalation timers               │
                    └───────────────────────────────────────┘
```

The worker is a separate process, not a thread of the server, because escalation
must keep running when the API is restarted and must resume after a crash (Q5).
It coordinates only through the database: there is no direct call between them.

## Packages

| Path              | Contains                                                        | May depend on      |
| ----------------- | --------------------------------------------------------------- | ------------------ |
| `packages/config` | TypeScript compiler presets                                     | nothing            |
| `packages/domain` | Pure business rules: assignment, escalation, metric definitions | nothing            |
| `packages/shared` | Error vocabulary, pagination contract, env helpers, API schemas | `zod`              |
| `apps/server`     | HTTP API, repositories, integrations                            | `domain`, `shared` |
| `apps/worker`     | Scheduled jobs, timers, outbound notifications                  | `domain`, `shared` |
| `apps/web`        | React SPA                                                       | `shared`           |

`packages/domain` must never import a database driver, an HTTP framework or a
provider SDK. That is what makes every rule in it testable without I/O, and it is
the structural half of Q14.

`packages/shared` holds contracts that both sides of the wire need. The health
response and the API error envelope are declared there once and used by the
server to produce and by the web app to parse, so a change to either cannot pass
typecheck on only one side (Q12).

## Server layering

```
  http/routes/*        URL shape, Zod parsing of params and body
  http/controllers/*   request → service call → response shape      [P2+]
  services/*           use cases, permission checks, audit writes   [P2+]
  repositories/*       Mongoose access, always scoped by workspace  [P2+]
```

Controllers never touch Mongoose. Services never read `req` or `res`. In P0 only
the route layer exists, because the only endpoint is `GET /api/health`, which has
no business rule behind it.

## Cross-cutting rules that shape the code

**Tenant scoping.** From P2, every query on tenant data goes through a
`scoped(workspaceId)` repository factory, and `workspaceId` comes from the
authenticated session rather than from the URL or body. A missing or mismatched
workspace produces `NOT_FOUND`, never `FORBIDDEN`, so a guessed identifier cannot
be used to learn that a record exists (F1.6, Q2). `packages/shared/src/errors.ts`
documents this on `notFound`.

**Timers.** Business timers live in a `scheduled_jobs` collection and are claimed
by the worker with a `lockedUntil` lease. Nothing relies on an in-memory
`setTimeout`, so a restart mid-window does not lose an escalation (Q5).

**Concurrency.** Leads, opportunities and assignments carry a `version` and are
updated conditionally. Timer claims use atomic `findOneAndUpdate`, so two timers
firing together escalate once (F3.8).

**Webhooks.** The provider signature is verified against the raw body before any
parsing or write, and the provider's event id is stored with a unique index so a
repeated delivery is processed once (I1.8, I2.4).

**Audit.** Important mutations append to an audit collection in the same logical
operation as the change. The collection has no update or delete route (F4.3).

**Errors.** One vocabulary, in `packages/shared/src/errors.ts`. The code
determines the HTTP status, so a route cannot return a status that contradicts the
code. Unexpected errors are logged in full and reported to the browser as a
generic message, so an internal detail never reaches a user.

## Request lifecycle

```
request id → helmet → CORS allow-list → body limit → route → 404 → error handler
```

The order is set in `apps/server/src/http/app.ts`. The request id is first so
every later log line and error response can be correlated. The error handler is
last and is the only place an error becomes a response.

## Configuration

`apps/server/src/config.ts` and `apps/worker/src/config.ts` are the only modules
that read `process.env`. Each validates its environment with Zod at startup and
exposes a typed object, so a missing variable stops the process with a readable
message instead of surfacing later as `undefined` (Q13). Variable _values_ never
appear in a validation error, because the environment holds signing secrets
(I5.3).
