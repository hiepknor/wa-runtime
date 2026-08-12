# Automation Runtime

Durable automation service between **client applications** and the existing **OpenWA Gateway**.
WA Studio is the first client, but the Runtime contract is client-neutral and can also serve future
mobile apps, web dashboards and trusted integrations. No client calls OpenWA directly or receives an
OpenWA operator key.

Milestone 3 is complete. The Runtime currently provides:

- a durable OpenWA read model for sessions, groups and group messages;
- group send-capability evaluation and targeted refresh;
- campaign drafts, group targets and versioned preflight checks;
- durable campaign runs, per-group deliveries, progress and recovery after restart;
- pause, resume and cancel controls;
- PostgreSQL-backed state, Redis/BullMQ queues and HMAC-verified OpenWA webhooks;
- Redis-coordinated per-session outbound pacing and bounded PostgreSQL retention;
- correlated, redacted JSON logs across API, scheduler and worker.

Live delivery is disabled by default and requires both a `LIVE` run and
`ALLOW_LIVE_SENDS=true`. Develop against `dev-session` with this switch kept off.

## Architecture

```text
Client applications (Desktop / Mobile / Web / integrations)
    |
    | Runtime API v1 + X-Runtime-Key
    v
Automation Runtime API ---- PostgreSQL (source of truth)
           |                       ^
           v                       |
       Redis/BullMQ --> scheduler/worker --> OpenWA Gateway
                                              |
                                              | signed webhooks
                                              v
                                      Runtime webhook ingress
```

The API, scheduler and worker are separate processes using the same image. Redis transports work;
PostgreSQL owns durable business state. See [Architecture](docs/architecture.md) for component and
data-flow details.

## Quick start with Docker

Prerequisites: Docker with Compose. Node.js 22+ is needed only for running checks or processes
outside Docker. Start OpenWA from its own repository first so the shared `wa-dev-network` and
`openwa-dev-api` service exist; see [Development](docs/development.md).

```bash
cp .env.example .env
```

Replace every placeholder in `.env`, then start the stack:

```bash
docker compose up --build -d
docker compose ps
curl http://localhost:3100/api/v1/health/ready
```

Local endpoints:

- Runtime API: <http://localhost:3100/api/v1>
- Swagger UI: <http://localhost:3100/api/v1/docs>
- Liveness: <http://localhost:3100/api/v1/health/live>
- Readiness: <http://localhost:3100/api/v1/health/ready>

Protected endpoints require:

```http
X-Runtime-Key: <RUNTIME_API_KEY>
```

The default Compose network expects `DATABASE_URL` to use host `postgres`, `REDIS_URL` to use host
`redis`, and the local OpenWA stack to be reachable as `openwa-dev-api`. Host-side commands instead
use `localhost:5433` and `localhost:6380`; see [Development](docs/development.md).

## Safe first run

The recommended first end-to-end flow for any management client is:

1. synchronize `dev-session`;
2. inspect groups and their send capabilities;
3. create a campaign and replace its group targets;
4. run preflight with `DRY_RUN`;
5. create a durable dry-run and watch progress until `COMPLETED`;
6. exercise pause, resume and cancel before considering live delivery.

The exact lifecycle and state meanings are documented in
[Campaign lifecycle](docs/campaign-lifecycle.md). The complete machine-readable contract is
[contracts/runtime/v1/openapi.json](contracts/runtime/v1/openapi.json).

## Documentation

- [Architecture](docs/architecture.md) — boundaries, components, data ownership and flows.
- [Campaign lifecycle](docs/campaign-lifecycle.md) — capabilities, preflight, runs and deliveries.
- [Development](docs/development.md) — local OpenWA, configuration, tests and contract generation.
- [Operations](docs/operations.md) — production safety, deploy, recovery, backup and upgrade.
- [Failure model](docs/failure-model.md) — durable dispatch, leases, retry and ambiguous delivery semantics.
- [Observability](docs/observability.md) — JSON logs, correlation IDs, health checks and manual diagnosis.
- [Latest local acceptance](docs/acceptance/2026-08-11-local.md) — sync, dry-run and Redis recovery evidence.
- [API contract](docs/api-contract.md) — authentication, idempotency, endpoint groups and versioning.

## Common commands

```bash
npm run check
npm run test:integration

set -a
source .env
set +a
npm run contract:check

docker compose logs -f api worker scheduler
docker compose down
```

Do not use `docker compose down -v` unless intentionally deleting all local Runtime data. Never
commit `.env`, OpenWA keys, webhook secrets, paired session credentials or production database
exports.
