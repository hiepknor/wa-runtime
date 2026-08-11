# Automation Runtime

Durable control plane between **WA Studio** and the existing **OpenWA Gateway**. The Runtime owns
scheduling, idempotency, queueing and delivery-state reconciliation. WA Studio must never call
OpenWA directly or store its API key.

## Current milestone

The first vertical slice is implemented:

```text
POST message job -> PostgreSQL -> scheduler -> Redis -> worker
                                              -> OpenWA (live mode only)
OpenWA webhook -> HMAC verification -> PostgreSQL -> Redis -> delivery state
```

Live delivery is protected by two independent controls:

1. each message job defaults to `dryRun: true`;
2. the process refuses every live job unless `ALLOW_LIVE_SENDS=true`.
3. `OPENWA_ALLOWED_SESSION_IDS` rejects jobs targeting any session outside this deployment's allowlist.

Keep both protections in place while developing against a real WhatsApp session.

## Prerequisites

- Docker with Compose
- Node.js 22+ only when running processes outside Docker

## Run locally

The checked-in `.env.example` documents all settings. A local ignored `.env` is created during
bootstrap. It contains development-only secrets and must never be reused in production.

```bash
docker compose up --build -d
docker compose ps
curl http://localhost:3100/api/v1/health/ready
```

Swagger is available locally at <http://localhost:3100/api/v1/docs>. Protected API routes require:

```http
X-Runtime-Key: local-runtime-key-change-before-production-2026
```

Create a safe dry-run job:

```bash
curl -X POST http://localhost:3100/api/v1/message-jobs \
  -H 'Content-Type: application/json' \
  -H 'X-Runtime-Key: local-runtime-key-change-before-production-2026' \
  -H 'Idempotency-Key: local-test-001' \
  -d '{
    "sessionId": "35b45e89-3647-45bd-b756-3df53523f431",
    "recipientId": "120363000000000000@g.us",
    "text": "Dry-run only",
    "dryRun": true
  }'
```

Repeating the exact request with the same `Idempotency-Key` returns the original job instead of
creating a duplicate.

## OpenWA contract

The pinned upstream contract is stored at:

```text
contracts/openwa/0.15.0/openapi.json
```

When OpenWA is upgraded, add a new directory rather than overwriting the old snapshot, review the
OpenAPI diff, and run adapter integration tests before changing `OPENWA_RELEASE_TAG`.

## Webhook registration

Runtime receives OpenWA events at:

```text
POST /api/v1/webhooks/openwa
```

OpenWA must register that URL with the same secret as `OPENWA_WEBHOOK_SECRET`. The handler validates
`X-OpenWA-Signature` over the exact raw request body and deduplicates by OpenWA's idempotency key.
For local-to-VPS testing, expose only this route through a temporary HTTPS tunnel.

The included development proxy deliberately exposes only the webhook route:

```bash
npm run dev:webhook-proxy
cloudflared tunnel --url http://127.0.0.1:3101
```

## Useful commands

```bash
npm run check
docker compose logs -f api worker scheduler
docker compose down
```

Do not use `docker compose down -v` unless intentionally deleting all local Runtime data.

## Environment isolation

Development and production use the same image but separate configuration and credentials. Never put
both session IDs in one deployment's allowlist.

| Environment | OpenWA session | Runtime data | Live sends |
| --- | --- | --- | --- |
| Local/development | local `dev-session` (`35b45e89-3647-45bd-b756-3df53523f431`) | local PostgreSQL and Redis | always off initially |
| Production | `prod-session` (`ae69dc9f-d8a1-474c-8981-5ac201a675a0`) | production PostgreSQL and Redis | enabled only after staging approval |

Each environment must have its own session-scoped OpenWA Operator key and webhook secret. The
production deployment must start with `ALLOW_LIVE_SENDS=false`; enabling it is a separate, audited
release step after webhook, idempotency, rate-limit and kill-switch checks pass.

## Local OpenWA development gateway

Development uses an isolated OpenWA `0.15.0` stack with its own PostgreSQL, Redis, MinIO and Docker
volumes. It never calls the VPS gateway and does not need a public tunnel.

```bash
cd infra
cp openwa-dev.env.example openwa-dev.env # first run only; replace every placeholder
docker compose --env-file openwa-dev.env -f openwa-dev.compose.yml up -d
```

Local endpoints:

- OpenWA dashboard and Swagger: <http://localhost:2785>
- MinIO API: <http://localhost:9000>
- MinIO console: <http://localhost:9001>

Automation Runtime joins `wa-dev-network` and calls `http://openwa-dev-api:2785`. OpenWA posts HMAC
webhooks directly to `http://automation-api:3100/api/v1/webhooks/openwa` on the same private network.
The VPS `prod-session` and its credentials must never appear in the local `.env`.

To stop the gateway without deleting data:

```bash
docker compose --env-file openwa-dev.env -f openwa-dev.compose.yml down
```

Do not add `-v` unless intentionally deleting the local WhatsApp session and all dev gateway data.
