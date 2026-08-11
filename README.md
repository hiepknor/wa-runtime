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
    "sessionId": "primary",
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
