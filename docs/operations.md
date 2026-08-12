# Operations

## Production principles

- Pin both WA Runtime and OpenWA to reviewed release tags.
- Use `prod-session` only in production and allowlist only its UUID.
- Keep PostgreSQL and Redis on private networks; expose only the Runtime API through TLS.
- Give the Runtime a session-scoped OpenWA operator key with only required permissions.
- Start every new production deployment with `ALLOW_LIVE_SENDS=false`.
- Treat PostgreSQL as irreplaceable business state; Redis queues are recoverable transport.

Development and production must not share credentials, databases, Redis instances, webhook secrets,
session IDs or Docker volumes.

Set `WA_RUNTIME_DB_PASSWORD` to an independently generated staging/production secret and use the
same URL-encoded credential in `DATABASE_URL`. The Compose defaults are development-only.

## Container topology

Production needs these Runtime services:

The temporary replication limits below implement the rollout guard from
[ADR 001](adr/001-postgresql-owned-durable-work-execution.md).

| Service | Replication guidance |
| --- | --- |
| PostgreSQL | One primary with tested backups. |
| Redis | One persistent private instance using `noeviction`. |
| migrate | One-shot before application processes start. |
| API | One initially; scale only with shared rate/auth policy. |
| scheduler | Exactly one until ADR 001 database-owned retries and fencing pass staging. |
| worker | Exactly one until the implemented PostgreSQL leases pass staging multi-process tests. |

OpenWA is a separate Gateway deployment with its own PostgreSQL, Redis, storage and release
lifecycle. Do not merge the two databases or Redis instances merely because both products use the
same technologies.

## Release deployment

A production release should follow this order:

1. create and push an immutable Runtime release tag;
2. verify the OpenAPI diff and migration files in that tag;
3. take and verify a PostgreSQL backup;
4. pull/checkout the exact Runtime tag on the VPS;
5. build/pull the tagged image;
6. run the one-shot migration and stop if it fails;
7. start API, worker and scheduler with live sends still disabled;
8. verify liveness, readiness, Swagger policy and logs;
9. run a production-session sync and a small `DRY_RUN`;
10. enable live sends only through a separate approved configuration release.

Do not deploy from an uncommitted working tree or a floating branch such as `main`.

## Health and observability

Public probes:

```text
GET /api/v1/health/live
GET /api/v1/health/ready
```

Readiness checks PostgreSQL, Redis and fresh worker/scheduler heartbeats, then reports the live-send
interlock, pinned OpenWA release and number of allowlisted sessions. It does not prove that OpenWA
is currently paired; session sendability is visible through the session API and campaign preflight.

All processes emit correlated JSON logs. The deployment has no trace store, metrics database,
dashboard or alert engine. See [Observability](observability.md) for log fields and manual diagnosis.

Useful container checks:

```bash
docker compose ps
docker compose logs --since=15m api worker scheduler migrate
docker compose exec -T postgres pg_isready -U automation -d automation_runtime
docker compose exec -T redis redis-cli ping
docker compose exec -T redis redis-cli --scan --pattern 'wa-runtime:scheduler-tick:*'
```

Regularly inspect repeated worker failures, runs stuck in `PREPARING`, unexpected `UNKNOWN`
deliveries, dead or increasingly old webhook events, expired processing leases, session
restrictions, capability refresh failures, database storage pressure and Redis `noeviction` write
failures.

After [ADR 001](adr/001-postgresql-owned-durable-work-execution.md) is implemented, also alert on
lost-ownership transitions, exhausted durable retry budgets, sync epoch rejections, expired
outbound-session leases and scheduler lag. These events must not include message text, member search
values, phone numbers or secrets.

Page on repeated `scheduler.tick.failed` or any `scheduler.tick.timed_out`. A timed-out tick remains
non-overlapping until its underlying operation settles; do not restart a second scheduler as a
workaround. Compare its Redis `lastStartedAt`, `lastSuccessAt`, `lastFailureAt`, `nextRunAt` and
`consecutiveFailures` fields, then inspect PostgreSQL/Redis latency for that tick's dependency.

Treat `OpenWAResponseValidationError` as an integration compatibility incident. Its log message
contains only the operation and issue count; do not add raw response payloads while diagnosing it.
Repeated group-pagination validation failures require checking the pinned OpenWA release and its
pagination behavior before retrying full synchronization.

## Outbound pacing and retention

`OUTBOUND_MIN_DELAY_MS` and `OUTBOUND_MAX_DELAY_MS` apply inside a token-owned PostgreSQL
per-session lease. Multiple worker replicas must remain disabled until the staging concurrency gate
for [ADR 001](adr/001-postgresql-owned-durable-work-execution.md) passes. For a
500-group campaign on one session, messages are intentionally serialized; adding workers helps other
sessions and non-send queues but does not increase that session's send rate. Keep the maximum at or
below 60 seconds so the session and message processing leases remain bounded.

Terminal rows are retained for `RUNTIME_RETENTION_DAYS` (90 by default). The scheduler runs cleanup
every `RUNTIME_RETENTION_INTERVAL_MS` and deletes at most `RUNTIME_RETENTION_BATCH_SIZE` rows from
each data family per pass. Seven days is the enforced minimum. Choose the period from audit,
incident-response and storage requirements; it is also the effective historical idempotency window.
Backups remain governed by their own retention policy and are not deleted by this job.

## Backup and restore

Store backup scripts and archives outside the OpenWA project. A suitable separation is:

```text
/opt/wa-runtime/              deployment
/opt/wa-runtime/scripts/      Runtime maintenance scripts
/var/backups/wa-runtime/      backup archives
```

Existing installations may retain the legacy `automation_runtime` PostgreSQL database. Before
changing an existing Compose project to `wa-runtime`, take a logical PostgreSQL backup, stop the old
project, and copy or explicitly reattach its PostgreSQL and Redis volumes. Keep the source volumes
until the new stack passes readiness and application-level smoke tests.

The minimum Runtime backup is a PostgreSQL logical dump plus the exact application release tag and
environment inventory. Never put secrets into the backup filename or command output.

Example logical backup:

```bash
umask 077
docker compose exec -T postgres \
  pg_dump -U automation -d automation_runtime -Fc \
  > /var/backups/wa-runtime/runtime-$(date -u +%Y%m%dT%H%M%SZ).dump
```

Test restoration periodically into an isolated database. A restore replaces or merges durable
business data and must be performed during a declared maintenance window with API, scheduler and
worker stopped. Document and rehearse the exact restore command for the chosen PostgreSQL hosting
model before production launch.

Redis AOF is useful for short outages but is not a substitute for PostgreSQL backup. After Redis
loss, start Redis, then scheduler and worker; durable pending rows will be enqueued again.
Webhook retries, pending syncs, campaign preparation and scheduled message jobs are rediscovered
from PostgreSQL. A live message left in `PROCESSING` past its lease becomes `UNKNOWN` and is never
resent automatically.

## Restart and recovery

A normal restart is safe:

```bash
docker compose restart api worker scheduler
```

After restart:

1. confirm readiness;
2. confirm scheduler and worker are running;
3. inspect non-terminal campaign runs;
4. verify `PREPARING` runs advance and stale queued jobs recover;
5. do not manually duplicate a run to make it move.

Before ADR 001 is fully implemented, do not start a second scheduler or worker as a recovery
shortcut. Restart the single process and let PostgreSQL-backed discovery republish the durable rows.

Pause a run before planned intervention when possible. Cancel stops only pending/queued work; it
cannot recall a message already processing or accepted by OpenWA.

## Live-send enablement

Live sending requires all of the following:

- reviewed and paired production session;
- production UUID as the only allowlisted session;
- valid current group capability;
- preflight without blocking checks;
- tested webhook acknowledgements and delivery reconciliation;
- acceptable outbound delay configuration;
- explicit `ALLOW_LIVE_SENDS=true` deployment approval;
- a tested kill switch that can restore the value to `false` and restart worker/scheduler.

Begin with a campaign containing a very small controlled set of groups. Never use the 500-group
session as the first live validation.

## Session restrictions and group permission changes

`session.restriction` webhooks are persisted on the session and invalidate the short Redis cache. A
live run encountering an unsendable session pauses new materialization with
`SESSION_NOT_SENDABLE`. Resolve the OpenWA/session condition, refresh state, then resume so preflight
runs again.

Group metadata events invalidate only the affected group. A send returning HTTP 403 marks capability
unknown with `GATEWAY_PERMISSION_DENIED`; HTTP 404 uses `GROUP_CHANGED`. Let targeted refresh resolve
the group before resuming live work.

## OpenWA upgrade

OpenWA is pinned by `OPENWA_RELEASE_TAG`, and its reviewed Swagger snapshot lives under
`contracts/openwa/<tag>/openapi.json`.

The currently reviewed release is OpenWA `0.16.0`. A deployment using another release must update
and review the pinned snapshot and adapter tests before changing `OPENWA_RELEASE_TAG`.

For an upgrade:

1. add the new upstream snapshot without overwriting the old one;
2. diff relevant sessions, groups, send and webhook schemas;
3. update only the OpenWA adapter when upstream shapes changed;
4. run unit, adapter, dry-run and restart-recovery tests;
5. deploy OpenWA to a non-production session first;
6. release a compatible Runtime tag;
7. change `OPENWA_RELEASE_TAG` only in that reviewed release.

If the live Gateway reports another version, full sync fails closed. Do not bypass the check during
an upgrade.

## Rollback

Application rollback means returning to a previous immutable Runtime tag. Database rollback is not
automatically safe: migrations are forward-only and an older binary may not understand new schema
or enum values. Before every release, classify migrations as backward-compatible or require a
restore/forward-fix plan.

Migrations implementing ADR 001 are additive but change execution semantics. Deploy them with live
sends disabled, verify stale-attempt fencing and retry exhaustion in staging, then load test the
PostgreSQL outbound-session lease before enabling multiple workers or live sends.

Prefer a forward corrective release for additive migrations. Restore a database backup only after
explicitly accepting that post-backup campaign and delivery state will be lost.
