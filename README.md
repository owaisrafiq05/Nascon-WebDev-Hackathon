# Unified Business Management Platform

One connected platform where a service company manages its customers and sales
pipeline, guarantees that every inbound lead is acted on, and talks to customers,
collects payments and books appointments through real external services, with
every action traceable.

Requirements live in [`docs/problem-statement.docx`](docs/problem-statement.docx)
(plain-text copy: [`docs/problem-statement.md`](docs/problem-statement.md)).
Requirement IDs (`F1.1` … `I5.8`, `Q1` … `Q14`) are the acceptance criteria;
[`docs/requirements-matrix.md`](docs/requirements-matrix.md) tracks each one.

**Current state: P0, the monorepo scaffold.** The web app, API, worker and
database are wired together and the checks are green. Business features start at
P1.

## Prerequisites

| Tool    | Version | Notes                                       |
| ------- | ------- | ------------------------------------------- |
| Node.js | ≥ 20.11 | `node --version`                            |
| pnpm    | ≥ 10    | `npm install -g pnpm`                       |
| Docker  | any     | Runs MongoDB. Only needed to start the API. |

## Setup from a fresh clone

```bash
git clone <this repo> && cd Nascon-WebDev-Hackathon
pnpm install                 # 1. dependencies
cp .env.example .env         # 2. configuration (no secrets needed for P0)
pnpm db:up                   # 3. MongoDB replica set in Docker
pnpm check                   # 4. lint, format, typecheck, tests
pnpm dev                     # 5. web + API + worker
```

Then open <http://localhost:5173>. The page shows the API's health, which
includes whether the database is connected.

Six commands, and step 4 is optional.

### What `pnpm dev` starts

| Process | Port | Command on its own               |
| ------- | ---- | -------------------------------- |
| Web     | 5173 | `pnpm --filter @ubmp/web dev`    |
| API     | 4000 | `pnpm --filter @ubmp/server dev` |
| Worker  | —    | `pnpm --filter @ubmp/worker dev` |

The web dev server proxies `/api` to the API, so the browser only ever talks to
one origin and session cookies stay first-party.

`pnpm dev` builds `packages/*` first, because the apps consume them from `dist`
(see [decisions D3](docs/decisions.md)).

## Commands

| Command          | Does                                           |
| ---------------- | ---------------------------------------------- |
| `pnpm check`     | `lint` + `format:check` + `typecheck` + `test` |
| `pnpm lint`      | ESLint over the whole workspace                |
| `pnpm typecheck` | `tsc` in every package                         |
| `pnpm test`      | Vitest in every package                        |
| `pnpm build`     | Compile packages, apps and the web bundle      |
| `pnpm format`    | Prettier, writing changes                      |
| `pnpm db:up`     | Start MongoDB                                  |
| `pnpm db:down`   | Stop MongoDB, keeping the data                 |
| `pnpm db:reset`  | Stop MongoDB and **delete its data**           |
| `pnpm db:logs`   | Follow the MongoDB log                         |

Run one package's script with `pnpm --filter @ubmp/<name> <script>`.

## Layout

```
apps/
  server/   Express API: routes → controllers → services → repositories
  web/      React SPA (Vite, Tailwind, TanStack Query, React Router)
  worker/   Background process: claims scheduled jobs, runs escalation timers
packages/
  config/   Shared TypeScript compiler presets
  domain/   Pure business rules. No I/O, no framework, fully unit-tested
  shared/   Error vocabulary, pagination contract, env helpers, API schemas
docs/       Problem statement, architecture, decisions, requirements matrix
scripts/    Repository tooling
```

[`docs/architecture.md`](docs/architecture.md) explains how the processes relate
and which rules shape the code.

## Database

`docker-compose.yml` runs MongoDB 7 as a single-node replica set (`rs0`) rather
than a standalone server, so multi-document transactions and change streams
behave locally the way they would in production. The container's healthcheck
initiates the replica set on first boot; there is no separate init step.

Data persists in the `mongo-data` volume across `pnpm db:down`. Use
`pnpm db:reset` to start from empty.

Tests do not use Docker. `apps/server/src/db/mongoose.test.ts` boots a real
`mongod` through `mongodb-memory-server`, which downloads the binary on first
run and caches it.

## Configuration

Copy `.env.example` to `.env`. It documents every variable the finished platform
uses; P0 needs only `MONGODB_URI`, which already has a working default value.

Both Node processes validate their environment with Zod at startup
(`apps/server/src/config.ts`, `apps/worker/src/config.ts`) and stop with a
readable message naming any variable that is missing or malformed. Variable
values never appear in that message, because the environment holds signing
secrets.

Provider credentials are added in the phase that uses them; each phase's report
says exactly what to paste into `.env`.

**`.env` is never committed.** Only `.env.example`, which holds no values.

## Contributing

- Conventional Commits: `feat(crm): add custom field definitions`.
- Commit messages carry no AI attribution. `./scripts/verify-commit-msg.sh`
  checks the last commit and must pass before a push.
- `pnpm check` must be green before a push.
- Rules for this repository are in [`CLAUDE.md`](CLAUDE.md).

## Licence

MIT. See [`LICENSE`](LICENSE).
