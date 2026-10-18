# CLAUDE.md: project rules for Claude Code

## Project

Unified Business Management Platform (hackathon). The full requirements are in
`docs/problem-statement.docx`. Requirement IDs (F1.1, I2.4, Q5 and so on) are
the source of truth. Every feature you build must map to one or more IDs.

## Stack (do not change without asking)

- Monorepo: pnpm workspaces + Turborepo (optional, only if it stays simple)
- Language: TypeScript everywhere, `strict: true`
- Backend: Node.js 20+, Express, Mongoose (MongoDB), Zod for validation
- Frontend: React 18+, Vite, React Router, TanStack Query, Tailwind CSS
- Realtime: Socket.IO (server and client)
- Tests: Vitest (unit and API via supertest + mongodb-memory-server), Playwright (one smoke flow per major module)
- Lint and format: ESLint (flat config) + Prettier

## Repository layout

```
apps/
  server/   Express API. src/http (routes, middleware), src/services, src/repositories,
            src/integrations/<provider>/, src/db, src/config.ts
  web/      React SPA. src/app (providers, routes), src/pages, src/features/<area>/,
            src/lib (api client), src/test (helpers)
  worker/   Background process. src/ticker.ts (non-overlapping loop), src/config.ts
packages/
  config/   Shared TypeScript compiler presets, extended by every package
  domain/   Pure business rules: assignment, escalation, metric definitions.
            No database driver, no HTTP framework, no provider SDK.
  shared/   Contracts both sides of the wire need: error vocabulary, pagination,
            env helpers, API response schemas
docs/       problem-statement.docx (authority), architecture.md, decisions.md,
            requirements-matrix.md, demo-script.md
scripts/    Repository tooling
```

Dependency direction is one-way: `web`, `server` and `worker` may import
`domain` and `shared`; neither package may import an app; `domain` imports
nothing. Each package has `tsconfig.json` (typecheck, includes tests) and
`tsconfig.build.json` (emit, excludes tests).

## Architecture rules

- Server layering: routes -> controllers -> services (use cases) -> repositories (Mongoose).
  Controllers never touch Mongoose. Services never read `req`/`res`.
- Integrations live in `apps/server/src/integrations/<provider>/` behind an interface
  (e.g. `MessagingProvider`, `PaymentProvider`, `CalendarProvider`, `NotificationProvider`).
  Business code depends on the interface, not on Twilio/Stripe/Google directly.
- Every Mongo query on tenant data MUST include `workspaceId`. Build repositories so this
  is impossible to forget (e.g. a `scoped(workspaceId)` repository factory).
- `workspaceId` always comes from the authenticated session, never only from the URL or body.
- Permissions are checked on the server in middleware AND in services for sensitive actions.
- Every important mutation writes an audit entry (F4.1) in the same logical operation.
- Audit entries are append-only: no update or delete routes, no `findOneAndUpdate` on them.
- Concurrency: use a `version` field and conditional updates (optimistic concurrency) for
  leads, opportunities and assignments. Use atomic `findOneAndUpdate` claims for timers.
- Timers are persisted in MongoDB (collection `scheduled_jobs`) and claimed by the worker
  with a lease (`lockedUntil`). Never rely on in-memory `setTimeout` for business timers.
- Webhooks: verify the provider signature on the RAW body before any parsing or DB write.
  Store provider event IDs with a unique index to make processing idempotent.

## Security rules (non-negotiable)

- Passwords: argon2id (or bcrypt with cost >= 12). Never store or log plaintext.
- Sessions: httpOnly, Secure (in prod), SameSite=Lax cookies with expiry and server-side
  revocation. Login rate limiting (express-rate-limit). Add CSRF protection for
  cookie-authenticated state-changing requests.
- Helmet on the server, strict CORS allow-list, body size limits, Zod validation on every input.
- Provider tokens (Google refresh tokens, bot tokens) are encrypted at rest with AES-256-GCM
  using a key from the environment. They never leave the server.
- API keys, tokens and signing secrets are never sent to the browser, never printed in full,
  never committed. Show only the last 4 characters in the UI.
- Never store or log card data (I2.8). Stripe Checkout / hosted pages only.
- CSV/imports (if any) are untrusted: limit size, validate every row, escape output.

## Quality rules

- Every list endpoint is paginated (cursor or page + limit). Default limit 25, max 100.
- Every mutation returns a clear error code and message. Frontend shows loading, success
  and error states for every action (Q10).
- Every screen works at 360px width, 768px and 1280px with no horizontal scroll (Q7).
- Keyboard navigable, labeled form fields, visible focus, color never the only signal (Q8).
- Timers, thresholds and windows are configurable per workspace (e.g. acknowledgement
  window in seconds for demos).

## Environment and secrets

- Configuration is loaded and validated with Zod in `apps/server/src/config.ts`.
- Commit `.env.example` with every variable and a comment. NEVER commit `.env*` files with values.
- MongoDB runs via `docker-compose.yml` (replica set `rs0` enabled so transactions work if needed).
- Provide `pnpm seed` to create demo workspaces, users, contacts, pipelines and sample leads.

## Git and delivery rules (IMPORTANT)

- Work in small, logical commits. Use Conventional Commits, for example
  `feat(crm): add custom field definitions` or `fix(auth): reject expired sessions`.
- Commit messages contain ONLY the subject and body you write. NO `Co-Authored-By` lines,
  NO "Generated with Claude" lines, NO AI attribution of any kind in commits or PR descriptions.
- Before every push, check the message: `git log -1 --format=%B | grep -iE "co-authored|claude|generated"`
  must print nothing. If it does, amend the message and try again.
- A module is pushed only when it is green: `pnpm lint`, `pnpm typecheck`, `pnpm test` all pass.
- Push module by module (see the module list in the master prompt), not in one big push at the end.
- Never force-push. Never rewrite pushed history.

## Definition of done (for every phase)

1. Code builds (`pnpm build`), typechecks, lints and tests pass.
2. New behaviour is covered by tests that match the requirement IDs.
3. Relevant docs are updated (README section, `.env.example`, `docs/architecture.md` if structure changed).
4. You ran the feature yourself (dev servers up, seed data loaded) and checked the flow works.
5. You reported which requirement IDs are done and which are partial, with the reason.
