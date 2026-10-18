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
docker compose up -d         # 3. MongoDB replica set  (alias: pnpm db:up)
pnpm seed                    # 4. demo data
pnpm check                   # 5. lint, format, typecheck, tests
pnpm dev                     # 6. web + API + worker
```

Then open <http://localhost:5173>. Steps 4 and 5 are optional for P0.

### Expected output

**Step 3**, `docker compose up -d`:

```
[+] Running 2/2
 ✔ Volume "nascon-webdev-hackathon_mongo-data"  Created
 ✔ Container ubmp-mongo                         Started
```

The replica set needs no separate init command. The container's healthcheck
runs `rs.initiate()` on first boot and is idempotent afterwards, so the set
becomes `PRIMARY` on its own within a few seconds. Confirm with:

```bash
docker compose ps          # mongo should read (healthy), not (health: starting)
```

If you would rather initiate it by hand, the equivalent is:

```bash
docker compose exec mongo mongosh --quiet --eval \
  "rs.initiate({ _id: 'rs0', members: [{ _id: 0, host: 'localhost:27017' }] })"
```

**Step 6**, `pnpm dev` — three processes interleave their output:

```
@ubmp/server dev$ {"level":30,...,"database":"ubmp","msg":"database connected"}
@ubmp/server dev$ {"level":30,...,"port":4000,"env":"development","msg":"server listening"}
@ubmp/worker dev$ {"level":30,...,"name":"ubmp-worker","msg":"worker connected"}
@ubmp/worker dev$ {"level":30,...,"tick":1,"databaseReadyState":1,"msg":"worker heartbeat"}
@ubmp/web    dev$   ➜  Local:   http://localhost:5173/
```

The worker then logs one `worker heartbeat` line every 10 seconds.

The page at <http://localhost:5173> shows an **API status** card reading
“● All systems operational”, with **Database: ● Connected**. Checking the API
directly gives the same thing:

```console
$ curl -s http://localhost:4000/api/health
{"status":"ok","service":"ubmp-server","version":"0.0.0","environment":"development",
 "uptimeSeconds":21,"timestamp":"2026-10-18T07:20:46.985Z","dependencies":{"database":"up"}}
```

If MongoDB is not running, the card reads “◐ Running with a degraded
dependency” with **Database: ○ Not connected**, and the endpoint still answers
`200` with `"status":"degraded"`. That is deliberate — see
[decisions D6](docs/decisions.md).

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
| `pnpm seed`      | Load demo data into the development database   |
| `pnpm db:up`     | Start MongoDB (`docker compose up -d`)         |
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
