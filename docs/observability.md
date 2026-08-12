# Logs and health checks

## Runtime logs

API, scheduler and worker write newline-delimited JSON to stdout/stderr. The deployment intentionally
has no telemetry collector, trace store, metrics database, dashboard or alert engine.

Each API response includes `X-Request-ID`; a caller's value is preserved only when it contains
1–100 letters, digits, dots, underscores or hyphens. Worker log context can include `bullJobId`,
`messageJobId`, `webhookIdempotencyKey`, `syncRunId`, `campaignRunId`, `sessionId` and `groupId`.
Use these identifiers to correlate work across processes.

Structured fields named like credentials, tokens, secrets, message text, bodies, payloads or phone
numbers are redacted. Application code must still avoid placing sensitive values directly in log
message strings.

Every completed HTTP request emits `http.request.completed`. Scheduler recovery actions, queue
publication failures, worker job failures and OpenWA request failures emit structured events without
message contents or credentials.

Useful commands:

```bash
docker compose logs --since=15m api worker scheduler
docker compose logs -f api worker scheduler
```

Set `LOG_LEVEL` to `verbose`, `debug`, `log`, `warn`, `error` or `fatal`. Production defaults to
`log`; other environments default to `debug`.

## Health checks

```text
GET /api/v1/health/live
GET /api/v1/health/ready
```

Liveness proves that the API process can answer. Readiness checks PostgreSQL, Redis and fresh TTL
heartbeats from worker and scheduler, then reports the live-send interlock, pinned OpenWA release
and allowlisted-session count. It does not prove that OpenWA is currently paired.

## Manual diagnosis

There is no automatic warning for webhook `DEAD`, delivery `UNKNOWN`, queue failures or growing
backlog. Inspect JSON logs and durable PostgreSQL state during operation. Never automatically retry
an `UNKNOWN` live delivery; follow [Failure model](failure-model.md).
