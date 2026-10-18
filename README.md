# Unified Business Management Platform

One connected platform where a service company manages its customers and sales
pipeline, guarantees that every inbound lead is acted on, and talks to customers,
collects payments and books appointments through real external services, with
every action traceable.

Requirements live in [`docs/problem-statement.docx`](docs/problem-statement.docx)
(plain-text copy: [`docs/problem-statement.md`](docs/problem-statement.md)).
Requirement IDs (`F1.1` … `I5.8`, `Q1` … `Q14`) are the acceptance criteria;
[`docs/requirements-matrix.md`](docs/requirements-matrix.md) tracks each one.

**Current state: P2 complete.** Sign up, sign in, workspaces, configurable
roles and permissions, field-level masking and an append-only audit log all work
end to end. The CRM itself starts at P3.

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

Then open <http://localhost:5173> and create a workspace. Steps 4 and 5 are optional.

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
| `pnpm e2e`       | Playwright smoke flows (needs `pnpm dev` up)   |
| `pnpm seed`      | Load demo data into the development database   |
| `pnpm db:up`     | Start MongoDB (`docker compose up -d`)         |
| `pnpm db:down`   | Stop MongoDB, keeping the data                 |
| `pnpm db:reset`  | Stop MongoDB and **delete its data**           |
| `pnpm db:logs`   | Follow the MongoDB log                         |

Run one package's script with `pnpm --filter @ubmp/<name> <script>`.

### End-to-end tests

The Playwright flows drive a real browser against a running stack, so they are
not part of `pnpm check`. Start the stack first:

```bash
pnpm db:up
pnpm dev                              # leave running
pnpm --filter @ubmp/web e2e:install   # once, downloads Chromium
pnpm e2e
```

They deliberately do not start the servers themselves: the flow needs a MongoDB
replica set, which belongs to your environment rather than to a test runner
(see [decisions D41](docs/decisions.md)).

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
uses; the server needs only `MONGODB_URI`, which already has a working default
value. There is deliberately no session secret — see
[decisions D29](docs/decisions.md).

Both Node processes validate their environment with Zod at startup
(`apps/server/src/config.ts`, `apps/worker/src/config.ts`) and stop with a
readable message naming any variable that is missing or malformed. Variable
values never appear in that message, because the environment holds signing
secrets.

### Integrations (I1 – I4)

Each workspace connects its own Twilio, Stripe and Telegram accounts on the
**Integrations** page; Google Calendar is connected by each employee under
**Settings**. Secrets are encrypted with `ENCRYPTION_KEY` (AES-256-GCM) and only
their last four characters are ever shown. Without `ENCRYPTION_KEY` the app runs
but refuses to connect anything.

1. `ENCRYPTION_KEY=$(openssl rand -base64 32)` in `.env`.
2. Expose the API over HTTPS for webhooks, e.g. `cloudflared tunnel --url http://localhost:4000`,
   and set `PUBLIC_BASE_URL` to that address. The Integrations page then shows
   the exact webhook URLs to paste into each provider.
3. **Twilio (WhatsApp sandbox):** Account SID, Auth Token and the sender
   `whatsapp:+14155238886`. In the sandbox settings set _When a message comes in_
   to the page's `inbound` URL. Phones must send the sandbox join phrase first.
4. **Stripe (test mode):** `sk_test_…` key. Add a webhook endpoint with the page's
   URL for `checkout.session.completed`, `checkout.session.expired`,
   `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`,
   `payment_intent.payment_failed` and `charge.refunded`, then paste its `whsec_…`.
   Pay with card `4242 4242 4242 4242`; refund from the Stripe dashboard.
5. **Google Calendar:** a Cloud project with the Calendar API enabled, an OAuth
   client (web) with redirect URI `GOOGLE_OAUTH_REDIRECT_URI`, and your Google
   account listed as a test user. Set the three `GOOGLE_OAUTH_*` variables.
6. **Telegram:** create a bot with @BotFather and paste its token. Each employee
   presses _Start_ on the bot, then enters their chat id under Settings
   (message @userinfobot to find it).

`pnpm seed` connects the demo workspace automatically when the Twilio, Stripe
or Telegram variables are present in `.env`.

#### Checking live credentials

Once real sandbox credentials are in `.env`, run:

```bash
pnpm check:integrations
```

It makes one read-only call per provider (Twilio account fetch, Stripe balance,
Telegram `getMe`) and prints `OK`, `FAIL` or `SKIP` with the reason, for
example `SKIP twilio: missing TWILIO_AUTH_TOKEN`. Google is checked offline: the
three `GOOGLE_OAUTH_*` variables must be set, and the shape of the consent URL
is printed. It also checks that `ENCRYPTION_KEY` decodes to 32 bytes and that
`PUBLIC_BASE_URL` is https. A Stripe live key (`sk_live_`) is refused. The exit
code is non-zero if anything fails, and secrets are never printed (at most their
last four characters).

Nothing is sent unless you ask. Add `--send-telegram <chatId>` to send one test
message from the bot, and `--twilio-to <number>` (for example `+923001234567`)
to send one test message from the Twilio sender.

### Demo accounts (`pnpm seed`)

Password for all: `demo-password-123`. Acme Solar: `owner@acme.test`,
`admin@acme.test`, `sara@acme.test`, `omar@acme.test` (acknowledgement window
30 s). Beta Clinic, a second isolated workspace: `owner@beta.test`.

**`.env` is never committed.** Only `.env.example`, which holds no values.

## Contributing

- Conventional Commits: `feat(crm): add custom field definitions`.
- Commit messages carry no AI attribution. `./scripts/verify-commit-msg.sh`
  checks the last commit and must pass before a push.
- `pnpm check` must be green before a push.
- Rules for this repository are in [`CLAUDE.md`](CLAUDE.md).

## Licence

MIT. See [`LICENSE`](LICENSE).
