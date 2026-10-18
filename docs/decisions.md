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
