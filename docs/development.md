# Development

## Prerequisites

- Docker Desktop or Docker Engine with Compose;
- Node.js 22+ and npm for host-side checks;
- a paired local OpenWA `dev-session`;
- no production credentials on the development machine.

The local Runtime and OpenWA stacks share the external Docker network `wa-dev-network` while using
separate PostgreSQL, Redis and volumes.

## Repository layout

| Path | Contents |
| --- | --- |
| `src/entrypoints` | Thin API, scheduler and worker process bootstraps. |
| `src/modules` | Business features grouped by Nest module. |
| `src/contracts` | Public DTO source used to generate OpenAPI. |
| `src/core` | Shared auth, config, database, queue and OpenAPI infrastructure. |
| `src/integrations` | Third-party adapters; currently OpenWA. |
| `scripts` | Migration, contract-generation and development proxy executables. |
| `migrations` | Ordered, forward-only PostgreSQL migrations. |
| `contracts` | Committed generated Runtime and pinned upstream OpenWA specifications. |
| `test/unit` | Unit tests for policy, idempotency, processing and normalization boundaries. |
| `test/integration` | PostgreSQL, Redis, fake-OpenWA, recovery and HTTP authorization tests. |
| `test/support` | Isolated Docker harness, database reset helpers and fake upstream server. |

Run `codegraph sync` after moving symbols or files. Use `codegraph explore` before text search when
locating implementations or evaluating blast radius.

## Start local OpenWA

OpenWA is an independent Gateway and owns its own Compose files, PostgreSQL, Redis, MinIO, session
storage and environment configuration. Start the development Gateway from the OpenWA repository,
not from this repository. Its deployment must provide:

- Docker network `wa-dev-network`;
- service alias `openwa-dev-api` on that network;
- API port `2785` inside the network;
- Baileys engine and the pinned release expected by `OPENWA_RELEASE_TAG`;
- a session-scoped operator key and matching webhook secret for this Runtime.

Local OpenWA endpoints:

- dashboard and Swagger: <http://localhost:2785>;
- MinIO API: <http://localhost:9000>;
- MinIO console: <http://localhost:9001>.

Pair only the development session. The VPS `prod-session`, its API key and its session files must
not be copied into this environment. OpenWA infrastructure changes and upgrades belong in the
OpenWA repository; WA Runtime stores only its reviewed upstream contract snapshot and
adapter.

## Configure and start the Runtime

Return to the repository root and create the ignored environment file:

```bash
cp .env.example .env
```

Required choices:

- generate independent values of at least 32 characters for `RUNTIME_API_KEY` and
  `OPENWA_WEBHOOK_SECRET`;
- set `OPENWA_API_KEY` to a session-scoped local OpenWA operator key;
- set `OPENWA_ALLOWED_SESSION_IDS` to the UUID of `dev-session` only;
- keep `ALLOW_LIVE_SENDS=false`;
- keep `OPENWA_RELEASE_TAG` equal to the reviewed local OpenWA image tag.

The current reviewed Gateway release is OpenWA `0.22.0`; its upstream contract snapshot is stored
under `contracts/openwa/0.22.0`.

The checked-in Compose file consumes `.env` inside containers. Runtime storage resolves through the
private aliases `wa-runtime-postgres` and `wa-runtime-redis`; OpenWA resolves as `openwa-dev-api` on
the shared development network. New installations create the `wa_runtime` database and the
`wa-runtime_postgres-data` and `wa-runtime_redis-data` volumes.

```bash
docker compose up --build -d
docker compose ps
docker compose logs --tail=100 migrate api worker scheduler
```

Migration files are applied in filename order under a PostgreSQL advisory lock and recorded in
`schema_migrations` with a SHA-256 checksum. Legacy records receive their checksum on the first run
of the hardened migrator; subsequent content drift or removal of an applied `.sql` file fails
closed. Never edit, rename or delete a migration that has already been applied; add the next numbered
migration.

## Host-side npm commands

When Node runs on the host rather than in Docker, override container DNS names after loading `.env`:

```bash
set -a
source .env
set +a

export DATABASE_URL=postgresql://wa_runtime:wa_runtime@localhost:5433/wa_runtime
export REDIS_URL=redis://localhost:6380
export OPENWA_BASE_URL=http://localhost:2785
```

Then use:

```bash
npm ci
npm run clean
npm run architecture:check
npm run typecheck
npm test
npm run build
npm run check
npm run test:integration
npm run check:all
npm run contract:check
```

`npm test` runs only the fast unit suite. `npm run test:integration` builds the production artifact,
starts temporary PostgreSQL 17 and Redis 8 containers on random loopback ports, applies every
migration and runs against an in-process fake OpenWA server. Docker must be running; the harness
removes its containers during teardown and never connects to the development database, Redis or
paired OpenWA session.

The development entry points are available when individual host processes are useful:

```bash
npm run dev:api
npm run dev:worker
npm run dev:scheduler
```

Only one scheduler may run against a database. A second scheduler exits because it cannot acquire
the PostgreSQL leadership lock. Do not run host and Docker workers simultaneously unless the test
explicitly targets multi-process concurrency.

Pull requests and pushes to `main` run `check:all`, regenerate and verify the committed Runtime
contract, and reject whitespace errors. The integration gate requires Docker because it provisions
isolated PostgreSQL and Redis containers.

### Repeatable 500-target dry-run load test

The load test refuses to run when live sends are enabled, creates uniquely prefixed synthetic groups,
verifies campaign delivery invariants and removes its test data afterward. Against the Compose stack:

```bash
docker compose run --rm \
  -e LOAD_TEST_API_URL=http://api:3100/api/v1 \
  api node dist/scripts/load-test-dry-run.js
```

Set `LOAD_TEST_TARGET_COUNT`, `LOAD_TEST_TIMEOUT_MS` or `LOAD_TEST_POLL_MS` only when testing another
profile. Worker and scheduler may be restarted while the command is running to exercise recovery.

## Contract workflow

Public DTOs live under `src/contracts`. After a DTO or controller change:

```bash
npm run contract:generate
git diff -- contracts/runtime/v1/openapi.json
npm run contract:check
```

Commit the DTO/controller change and generated OpenAPI file together. Never hand-edit the generated
JSON. A reviewer should inspect semantic changes to paths, required fields, enums and response
schemas rather than accepting a large generated diff blindly.

## Safe development scenario

Use Swagger or an API client with `X-Runtime-Key` to perform this sequence:

1. `POST /sessions/{sessionId}/sync` and poll its sync run;
2. list groups and refresh any unknown capability;
3. create a campaign and select a small set of test groups;
4. call preflight with `DRY_RUN`;
5. create a dry-run with a unique `Idempotency-Key`;
6. inspect run progress and delivery rows;
7. repeat the same key to verify idempotency;
8. test scheduled pause/resume and cancel.

Dry-run message jobs finish as `DRY_RUN_COMPLETED` before the OpenWA send call and therefore cannot
send a WhatsApp message.

## Webhook development

Within Docker, OpenWA posts directly to:

```text
http://wa-runtime-api:3100/api/v1/webhooks/openwa
```

Both services must use the same webhook secret. If a temporary public callback is needed, expose
only the webhook proxy route:

```bash
npm run dev:webhook-proxy
cloudflared tunnel --url http://127.0.0.1:3101
```

Never expose PostgreSQL, Redis, MinIO or the Runtime API through that tunnel.

## Reset and shutdown

Stop services while keeping data:

```bash
docker compose down
```

Deleting volumes permanently removes local Runtime PostgreSQL and Redis data:

```bash
docker compose down -v
```

Use the second command only for an intentional clean-room reset. OpenWA uses a different Compose
project and different volumes; reset it separately only when the paired development session may be
destroyed.
