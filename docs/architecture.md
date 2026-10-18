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

## The auth model (P2)

### Identity, workspace, membership

A **user** is a person and is global: one account, one email, one password. A
**workspace** is one company's isolated environment. A **membership** joins the
two and is the unit of authorisation — it carries the base level and the
permission sets. The same person can be an Owner of one workspace and a User in
another, and a session is always bound to one membership, never to a user alone.

### Permissions are configuration, not role names

Three base levels are fixed: Owner, Admin, User (F1.2). Everything else is a
**permission set** stored per workspace — the role-like configuration of F1.3.
A "Manager" is a seeded permission set, not a fourth level, which is what
Section 2 asks for.

Code asks `hasPermission(permissions, 'crm.record.delete')` and never
`baseLevel === 'admin'`. The split between the two:

- **Base levels carry workspace administration** (`members.manage`,
  `workspace.manage`). `ASSIGNABLE_PERMISSIONS` excludes these, so a workspace
  cannot define a set that hands out member management.
- **Permission sets carry everything else.** A User holds nothing by level;
  everything they can do was granted.
- **An Owner always holds every permission** and cannot be reduced, so they can
  never lock themselves out of a workspace they pay for.

`effectivePermissions` is the union of level, sets and per-member grants. It
drops stored strings the codebase no longer knows, so a removed permission
cannot keep granting access through a stale set.

### Sessions

```
  cookie  ubmp.sid   32 random bytes, httpOnly, SameSite=Lax, Secure in prod
  stored  sessions   SHA-256(token) only — never the token itself
```

Server-side, in MongoDB, because that is what makes revocation real. Permissions
are re-read from the database on **every request** rather than baked into the
cookie, so removing someone's access takes effect on their next request instead
of whenever a token happens to expire. Signing out, removing a membership and
changing a level all revoke sessions.

There is no session signing secret. A 256-bit random token has nothing to guess,
so a plain digest is sufficient and there is no key to rotate or leak.

### CSRF

A **synchroniser token**, not a bare double-submit. The expected value lives in
the session document; the server publishes it in a readable `ubmp.csrf` cookie
and the page echoes it in `X-CSRF-Token`. An attacker who can set cookies on the
victim's browser still cannot make the header agree with the server's copy.

It applies only when a session cookie authenticated the request, so sign-in and
sign-up are reachable, and provider webhooks are verified by provider signature
instead (I1.2, I2.3).

### Where enforcement happens

```
  route middleware   requireSession() -> requirePermission(...)
  service            canManageMembership(...) again, for membership changes
  repository         scoped(model, { workspaceId }) injects the tenant
```

Three layers on purpose. The middleware is the common path; the service check
means a future endpoint cannot reach a membership without the Admin-cannot-touch-
Owner rule; the scoped repository means a query cannot omit `workspaceId` at all.
`workspaceId` always comes from the session.

A record belonging to another workspace answers **404, never 403**, because a 403
would confirm the identifier exists. A malformed identifier answers 404 too, so
"not an id" and "not yours" cannot be told apart (F1.6, Q2).

### Field-level masking

`opportunity.value.view` is a permission of its own (F1.4). The rule is one
function in `packages/domain/src/masking.ts`, applied on all three read paths the
requirement names — list, detail and export. The export writes its value cell
through `opportunityValueExportCell` rather than reading `record.value`, so a CSV
writer cannot bypass it. Masking nulls the value and sets `valueMasked`, so a
reader can tell "no value recorded" from "you may not see this".

Metrics never mask: who may see a figure is answered before the metric is called.
A metric returning zero for an unpermitted user would make the same figure differ
between screens, which Q12 forbids.

### Audit

Append-only, guarded three times over (F4.3): the repository exports no mutating
method, the router mounts only GET routes, and the schema rejects every
non-insert write. Each entry is appended inside the same transaction as the
change it describes, so a change cannot commit unaudited and an entry cannot
survive a rollback.
