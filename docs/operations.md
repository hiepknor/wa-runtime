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
docker compose exec -T postgres pg_isready -U wa_runtime -d wa_runtime
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

Installations use the `wa_runtime` PostgreSQL database and role together with the
`wa-runtime_postgres-data` and `wa-runtime_redis-data` volumes. A previously named installation must
take a logical PostgreSQL backup, record row-count baselines, stop the old project, and follow the
reviewed [storage namespace migration runbook](runbooks/storage-namespace-migration.md). The active
Compose configuration has no legacy-volume override.

Use `wa-runtime-postgres` and `wa-runtime-redis` in container connection URLs. Runtime processes also
join the OpenWA gateway network, where generic `postgres` and `redis` DNS names may resolve to the
gateway's dependencies instead of WA Runtime storage.

The minimum Runtime backup is a PostgreSQL logical dump plus the exact application release tag and
environment inventory. Never put secrets into the backup filename or command output.

Example logical backup:

```bash
umask 077
docker compose exec -T postgres \
  pg_dump -U wa_runtime -d wa_runtime -Fc \
  > /var/backups/wa-runtime/runtime-$(date -u +%Y%m%dT%H%M%SZ).dump
```

For an installation still on older database identifiers, substitute its current database and role
in the source backup command. PostgreSQL database/role creation runs only when the data directory is
empty, so existing storage requires the explicit migration procedure.

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

## Group reconciliation

`POST /api/v1/sessions/{id}/sync` accepts an optional mode. Omission remains `FULL` for API v1
compatibility; operator clients should send `INCREMENTAL` for routine synchronization and reserve
`FULL` for bootstrap or deliberate reconciliation of every active group.

Discovery publishes group summaries first. The run then remains `RUNNING` in phase `RECONCILING`
while PostgreSQL-owned `gateway_sync_items` update `groupsSynced`, `groupsFailed`, `groupsSkipped`
and `membersSynced`. `membersSynced` means members observed in successfully reconciled snapshots,
not rows changed. A duplicate request with the same mode returns the active run; a different mode
returns HTTP 409 rather than silently changing operator intent.

Group-detail calls share a session-scoped pacing lease with targeted capability refreshes. Initial
defaults are 40 calls per minute, five durable attempts and a 24-hour incremental freshness window.
Tune `GATEWAY_SYNC_GROUPS_PER_MINUTE` only from staging evidence. A sustained OpenWA 5xx sequence can
represent an underlying WhatsApp `rate-overlimit`; increasing worker concurrency or adapter retries
amplifies it.

An established session also guards destructive discovery changes. With the default configuration,
a snapshot below 25 percent of a baseline of at least 20 groups must be observed identically twice
before Runtime marks missing groups inactive. The first observation leaves the read model unchanged
and retries discovery durably. Only 429, upstream 5xx and network failures extend the shared session
cooldown; validation and persistence errors retain independent item retry semantics.

OpenWA group events now create one durable targeted intent per `(session, group)`. The default
three-second debounce coalesces bursts and a ten-second maximum wait prevents continuous activity
from postponing reconciliation indefinitely. PostgreSQL `NOTIFY` wakes the gateway dispatcher, but
the notification contains no identity and is not durable work; the configurable ten-second scan is
the recovery fallback. A listener reconnect performs an immediate catch-up scan.

Adaptive pacing is disabled by default. When `GATEWAY_SYNC_ADAPTIVE_PACING=true`, an explicit 429
halves the persisted effective per-session rate down to
`GATEWAY_SYNC_MIN_GROUPS_PER_MINUTE`; every configured successful-read streak restores one request
per minute up to `GATEWAY_SYNC_GROUPS_PER_MINUTE`. Disable the flag to immediately use the fixed
configured maximum without deleting pacing state.

Useful database inspection queries:

```sql
SELECT id, sync_type, status, phase, groups_discovered, groups_scheduled,
       groups_synced, groups_failed, groups_skipped, members_synced, error
FROM sync_runs ORDER BY requested_at DESC LIMIT 10;

SELECT status, count(*) FROM gateway_sync_items
WHERE sync_run_id = '<run-id>' GROUP BY status ORDER BY status;

SELECT session_id, next_request_at, consecutive_failures, cooldown_until,
       effective_requests_per_minute, success_streak, last_rate_pressure_at,
       active_lease_expires_at
FROM gateway_sync_rate_limits;

SELECT status, count(*), sum(coalesced_count) AS coalesced_events,
       min(now() - first_requested_at) AS oldest_age
FROM gateway_group_reconciliation_intents GROUP BY status ORDER BY status;
```

After a worker crash, the scheduler returns expired items to `RETRY` and clears expired pacing
leases. Do not manually change item status while a valid item or pacing lease exists. A terminal
failed item makes the parent run `FAILED` without discarding successful sibling results; a group
that disappears during reconciliation is `SKIPPED` and does not fail the parent.

## Rollback

Application rollback means returning to a previous immutable Runtime tag. Database rollback is not
automatically safe: migrations are forward-only and an older binary may not understand new schema
or enum values. Before every release, classify migrations as backward-compatible or require a
restore/forward-fix plan.

Migrations implementing ADR 001 and ADR 003 are additive but change execution semantics. ADR 003's
one-active-sync index can reject duplicate sync inserts from an older binary, so quiesce sync
requests during rollback and prefer a forward fix. Deploy with live sends disabled, verify
stale-attempt fencing and retry exhaustion in staging, then load test the PostgreSQL leases before
enabling multiple workers or live sends.

Prefer a forward corrective release for additive migrations. Restore a database backup only after
explicitly accepting that post-backup campaign and delivery state will be lost.
