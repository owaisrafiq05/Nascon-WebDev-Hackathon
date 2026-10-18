# Decisions

Each entry records a choice that was not forced by the problem statement, so a
reader does not have to re-derive it. Newest phase last.

---

## P0 — Monorepo scaffold

### D1. No Turborepo

`CLAUDE.md` allows Turborepo "only if it stays simple". `pnpm -r` already runs
workspace scripts in topological order, which is the only property the build
needs at this size. Turborepo would add a dependency, a config file and a cache
directory for no behaviour we use. Revisit if the test suite grows slow enough
that remote caching matters.

### D2. TypeScript pinned to 5.9.3, not the 7.x on `latest`

`typescript-eslint@8` declares `typescript: ">=4.8.4 <6.1.0"`. Installing
TypeScript 7 would leave the lint step unsupported by its own parser. Pinned
exactly (no `^`) so every package compiles with one compiler version.

### D3. Workspace packages are consumed from `dist`, not from `src`

`@ubmp/shared` and `@ubmp/domain` expose `dist/index.js` through their `exports`
map and are built with `tsc`. Pointing `exports` at `src` would work for Vite but
not for `node dist/index.js` in the server, and aliasing per tool would mean four
places to keep in step.

Consequence: `typecheck`, `test` and `dev` at the root run `build:packages`
first. That is why the root scripts are composed rather than plain `pnpm -r`.

### D4. Relative imports carry a `.js` extension

Node applications use `module: "NodeNext"`, which requires real ESM specifiers.
The web app uses `moduleResolution: "Bundler"`, where the extension is harmless.
Writing `.js` everywhere keeps one rule instead of two.

### D5. `exactOptionalPropertyTypes` is on

It is stricter than `strict: true` alone and catches `{ hint: undefined }` being
passed where the field should be absent. The cost is that optional fields must be
spread conditionally (`...(x === undefined ? {} : { x })`), which the error and
health code does.

### D6. Health returns 200 when a dependency is down

`GET /api/health` answers `200` with `status: "degraded"` rather than a 5xx. The
process _is_ answering; the body names the dependency that is not. A non-2xx
would make the web app's error path fire for a database blip and hide the detail.

### D7. Later-phase environment variables are declared but not validated yet

`.env.example` lists every variable the finished platform needs, including
provider credentials, so the full surface is visible from the start (Q13).
`apps/server/src/config.ts` validates only the variables the current phase reads.
A fresh clone therefore starts with no secrets at all; each phase moves its
variables into the schema as it begins to use them.

### D8. The worker's loop is a non-overlapping ticker from the start

`apps/worker/src/ticker.ts` schedules the next tick only after the previous one
settles, and contains a thrown tick. P0's tick only logs a heartbeat, but P4
claims leased `scheduled_jobs` in that same loop, where an overlapping tick could
escalate one lead twice (F3.8, Q5). Building the shape now means the concurrency
property is tested before any business rule depends on it.

### D9. One root ESLint flat config rather than one per package

Type-aware linting uses `projectService: true`, which finds each package's
`tsconfig.json` on its own. Per-package configs would duplicate the rule set four
times.

### D10. Docker is not installed on the current machine

`docker-compose.yml` is written and committed as `CLAUDE.md` requires, but
`docker compose up` could not be run here.

The stack was verified against a real MongoDB anyway: the `mongod` binary that
`mongodb-memory-server` caches was started by hand as a single-node replica set
`rs0` on port 27017, which is exactly what the compose file provisions, and the
API, worker and web app were run against it using the `MONGODB_URI` from
`.env.example` unchanged. Confirmed in that run:

- API connects and `GET /api/health` reports `database: "up"`
- worker connects and its heartbeat ticks
- the web dev server proxies `/api/health` through to the API
- stopping `mongod` flips health to `degraded` / `database: "down"` while still
  answering 200, and restarting it returns to `ok` with no API restart
- the replica-set configuration survives a `mongod` restart on the same dbpath

What remains unverified is only the compose file itself: the image tag, the port
mapping and the healthcheck that self-initiates the set. Tests never need it —
`apps/server/src/db/mongoose.test.ts` boots its own `mongod`.

### D11. `problem-statement.md` was extracted without pandoc

`pandoc` is not installed here. `docs/problem-statement.md` was produced by
reading `word/document.xml` out of the `.docx` with a Node script, preserving
headings and list markers. The `.docx` remains the original and the authority;
the Markdown is a convenience copy. Table cells appear as consecutive lines
rather than Markdown tables, which is why requirement IDs and their text sit on
separate lines.

### D12. `claude.md` renamed to `CLAUDE.md`

Claude Code reads `CLAUDE.md`. macOS resolved the lowercase name because its
filesystem is case-insensitive, but the committed name would not resolve on a
Linux checkout. The empty "Repository layout" heading in it was filled in with
the tree this phase created; no rule was changed.

---

## P1 — Domain core

### D13. The round-robin cursor is an input and an output, never module state

`assignLead` takes the cursor and returns the next one. A module-level variable
would be shared across workspaces in one process, would reset on restart, and
would make a decision impossible to reproduce in a test. As a value it is
persisted on the workspace, is auditable, and makes every decision replayable
from its inputs alone.

### D14. Round-robin scans the whole candidate list, not the eligible subset

The scan starts after the cursor's position in the full candidate list and wraps
once. Filtering to eligible employees first and then rotating would shift
everyone's position whenever someone went Busy, so an employee who stepped away
for one round would come back at the wrong place in the queue. Scanning the full
list keeps each employee's slot, and a cursor naming someone now ineligible
still advances to the next person rather than restarting.

### D15. A refusal to assign names one of five distinct causes

`no_candidates`, `all_excluded`, `none_available`, `all_at_capacity` and
`limit_below_one`. F3.7 requires the recovery queue to show a reason per item,
and these call for different action: "everyone is at their limit" is a staffing
or configuration problem, "everyone is offline" is a rota problem, and
`limit_below_one` is a misconfigured rule that should not be reported as a
staffing failure. The cursor is returned unchanged on refusal so a failed
attempt does not consume anyone's turn.

### D16. An escalated window starts at the previous deadline, not at `now`

This is what makes escalation skip-free. If the worker is down for three
windows, computing the new window from `now` would collapse the missed levels
into one jump and lose the intermediate steps, so the designated backup would
never have been given their turn. Starting from the previous deadline means each
call advances exactly one level and the whole chain is walked in order, however
late the worker is.

It also gives idempotency for free (F3.8): `nextEscalation` is a pure function,
so two timers firing on the same stored state both compute level n+1. One wins
the conditional write in P4; the other recomputes the same step and is a no-op.

### D17. No sixth state for "escalated through every level"

At the last configured level `nextEscalation` returns `null` and the lead stays
`escalated` and unacknowledged. The prompt names five states and a terminal
`exhausted` would be a sixth, with no transition out of it. The recovery queue
is what surfaces these leads, which is what F3.7 is for, and
`recoveryQueueMembership` flags such a lead on both the "beyond its window" and
"escalated repeatedly" grounds.

### D18. Settled states are returned by identity from every transition

`acknowledge`, `reassignManually` and `reassignForAbsence` return the state
unchanged when it is already settled. A late Acknowledge click after a manager
reassigned the lead therefore cannot take ownership back, and absence handling
leaves an already acknowledged lead with its accountable owner, which is the
"treatment of already acknowledged leads" F3.6 asks to be defined.

### D19. `escalationCount` counts automatic escalations only

Section 7 defines escalation as an automatic reassignment from an expired
window, and says manual reassignments are counted separately. A manual or
absence reassignment settles the state and leaves the count alone, so the
dashboard's "escalations in the last 24 hours" cannot be inflated by a manager
tidying up.

### D20. A settled lead is never in the recovery queue

Read literally, "has escalated two or more times" would keep a lead in the queue
after it was finally acknowledged. The queue exists to surface leads still at
risk, so acknowledgement, manual reassignment and absence reassignment all take
a lead out of it; the escalation history stays visible in the activity log and
the audit trail. A lead reassigned away gets a fresh assignment state that is
judged on its own.

### D21. Money is integer minor units, and every total is per currency

Amounts are cents, pence or paisa as integers: floating-point currency drifts
once enough rows are summed, and these totals are compared against Stripe's
records. Every function that adds money takes a `currency` and ignores records
in any other, so a USD payment can never be added to a EUR one. I2.1 stores both
an amount and a currency, which makes a single untagged total wrong. Display
scaling is the web app's job.

### D22. `timeToFirstResponse` measures from the _first_ assignment

Section 7 defines "assigned time" as the moment the system _last_ assigned the
lead, but "time to first response" as the time from the lead's _first_
assignment. Those are different fields, so leads carry `firstAssignedAt`
separately. Measuring from the last assignment would mean a lead that escalated
three times reported only the final holder's response time, making a badly
handled lead look fast.

A negative interval, which can only come from contradictory timestamps, is
excluded rather than returned, so one bad record cannot pull an average below
zero. Unacknowledged leads are excluded from the average rather than counted as
zero, and `sampleSize` and `excluded` come back alongside it so the figure can be
explained when drilled into (F5.3).

### D23. Collected revenue requires webhook confirmation, not a status

A payment counts only when `confirmedByWebhook` is true. A `paid` status set
optimistically by the interface is not revenue until the provider says so
(I2.2, I2.6). `refunded` payments count toward gross with the refund subtracted,
so a full refund nets zero and a partial refund leaves the remainder. The result
returns `gross`, `refunded` and `net` rather than one number, so the dashboard
figure can be reconciled against Stripe.

### D24. Projected revenue returns its two halves as well as the total

Section 7 defines it as the value of open opportunities _and_ of payment requests
not yet paid. An open opportunity that also has a pending payment request
therefore contributes to both halves. Rather than silently de-duplicating, which
would contradict the definition, the function returns `openOpportunities` and
`unpaidRequests` separately so a reader comparing it with collected revenue can
see the overlap (Q12). Only `pending` counts as "not yet paid": `expired` and
`failed` will not arrive, and `refunded` was already paid.

### D25. Metrics never apply permission masking

`openPipelineValue` returns real values. Whether a user may see them is a
permission question answered on the server before the metric is called (F1.4). A
metric that returned zero for an unpermitted user would make the same figure
differ between screens, which Q12 forbids; the masking happens in the response
layer instead.

### D26. `byStage` is ordered by stage id, not by pipeline position

The domain has no notion of a stage's display position, so sorting by id gives a
deterministic result from the same input in any order. The caller reorders by
the pipeline's configured stage positions for display.

### D27. Audit event types live in the domain

The server writes them, the worker writes some of them, and the web app's audit
viewer filters by them (F4.2). One list means a filter cannot drift from what is
recorded. Values are the stored strings in `subject.verb` form, so the viewer can
group by subject; an existing value is never renamed because it is persisted
data. There is deliberately no `audit.*` event, because nothing may edit or
delete an audit entry (F4.3) — a test asserts that.

---

## P2 — Accounts, workspaces, roles and audit

### D28. Sign-up uses a transaction, not compensating logic

It creates a user, a workspace, the workspace's default permission sets and an
Owner membership. Those documents are meaningless apart: a half-finished sign-up
leaves either an account belonging to no workspace or a workspace with no Owner,
and nothing in the platform could repair either. MongoDB already runs as a
replica set, so transactions are available; the tests use `MongoMemoryReplSet`
for the same reason rather than the standalone server P0 used.

Mongoose 9 requires `ordered: true` for a multi-document `create` inside a
session, which is what we want anyway: the seed lands whole or not at all.

### D29. There is no session signing secret

Session tokens are 32 random bytes and the database stores only their SHA-256
digest. A keyed HMAC would add a key to manage and rotate for no gain: the token
has 256 bits of entropy, so there is nothing to guess, and a database leak yields
no usable cookie either way. `SESSION_SECRET` was therefore dropped from the
server's config rather than left unused.

### D30. Permissions are read per request, never carried in the cookie

A signed token holding permissions would be faster, but removing someone's
access would then take effect only when their token expired. Reading the
membership and its sets on each request is what makes revocation real, and is the
reason sessions are server-side at all (Q1).

### D31. Base levels carry administration; permission sets carry everything else

`ASSIGNABLE_PERMISSIONS` deliberately excludes `members.manage`,
`permissions.manage` and `workspace.manage`. If a set could grant member
management, an Owner editing a set could hand out the ability to edit sets, and
the privilege boundary would close on itself. Administration follows the level,
which only an Owner can change.

An Owner always holds every permission and cannot be reduced, including by
themselves: they pay for the workspace and must never be able to lock themselves
out of it.

### D32. The permission matrix is the Owner's alone

An Admin may move people between levels and between existing sets, but not
redefine what a set grants. Redefining a set is how an Admin would escalate
their own access, so `change_permissions` requires `owner` regardless of
`members.manage`.

### D33. A workspace cannot lose its last Owner

Even an Owner cannot demote or remove themselves when they are the only one.
F1.2 does not say this, but the alternative is a workspace nobody can
administer, which no support path could fix.

### D34. Another workspace's record answers 404, never 403

A 403 confirms the identifier exists somewhere. A malformed identifier also
answers 404, so "that is not an id" and "that id is not yours" are
indistinguishable (F1.6, Q2). `notFound` in `packages/shared` documents this, and
the tenant-isolation tests assert the code rather than only the status.

### D35. Tenant scoping is a repository factory, not a convention

`scoped(model, { workspaceId })` injects the workspace into every filter and
every insert. `findById` becomes `findOne({ _id, workspaceId })`, which is what
turns a guessed id into a 404. `create` applies the scope **last**, so a
`workspaceId` in a request body cannot redirect the write — tested. CLAUDE.md
asks for this to be impossible to forget rather than merely remembered.

### D36. Failed sign-in is one response for every cause

Unknown account, wrong password and disabled account share a status, a code and a
message, and a password is verified even when no user was found so they do not
differ by timing either. The test asserts the two responses are equal rather than
merely both 401. Sign-up still reports a duplicate email, because a sign-up form
reveals that by trying regardless.

### D37. Login rate limiting is keyed on IP and email together

Keying on IP alone lets one colleague's typo lock out a whole office; keying on
email alone lets an attacker spray from many hosts. Only failures count, so
signing in repeatedly is not punished. `ipKeyGenerator` collapses IPv6 to its
prefix, because keying on a bare IPv6 address hands an attacker with a routed
block a fresh bucket per request.

### D38. CSRF uses a synchroniser token, not a bare double-submit

Double-submit compares a cookie with a header, both controlled by the browser, so
an attacker able to set cookies on the victim's browser can satisfy it. The
expected value is held in the session document instead, so it cannot be forged
from the client side. The check applies only to cookie-authenticated
state-changing requests: sign-in has no session to protect, and webhooks are
verified by provider signature.

### D39. Memberships are created on acceptance, not on invitation

A pending invitation is not a member: it must not appear in the member list, must
not count toward Owner protection and must never receive a lead in P4. Acceptance
is claimed with a conditional update, so two clicks on one link create one
membership. Every unusable invitation gives the same message, so tokens cannot be
probed, and someone who already has an account is not asked for a password —
an invitation is not a password reset.

### D40. The Opportunity model arrives in P2, minimally

F1.4 requires opportunity _value_ to be masked in lists, on detail pages and in
exports, which cannot be demonstrated without a record that has a value. P2
therefore owns a minimal Opportunity with `name`, `value`, `currency`, `stageId`
and `stageOutcome`. `stageOutcome` is present from the start because the
open-pipeline-value metric excludes won and lost, and adding it later would mean
rewriting documents. P3 makes it a real CRM object.

### D41. Playwright does not start the servers

The smoke flow needs a MongoDB replica set, which belongs to the developer's
environment rather than to a test runner. `playwright.config.ts` therefore has no
`webServer`: run `pnpm db:up` and `pnpm dev`, then
`pnpm --filter @ubmp/web e2e`. Starting a database from a test config would
make the suite depend on Docker and fail confusingly where it is absent.

### D42. Repeated controls get a unique accessible name

The Team page renders one Level select per member. All of them labelled "Level"
announces identically to a screen reader and is ambiguous to a test, so each
carries `aria-label="Level for <email>"` while the visible text stays short
(Q8). The Playwright failure that surfaced this was a real accessibility defect,
not a test-only problem.
