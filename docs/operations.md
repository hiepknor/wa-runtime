# Operations

## Production principles

- Pin both Automation Runtime and OpenWA to reviewed release tags.
- Use `prod-session` only in production and allowlist only its UUID.
- Keep PostgreSQL and Redis on private networks; expose only the Runtime API through TLS.
- Give the Runtime a session-scoped OpenWA operator key with only required permissions.
- Start every new production deployment with `ALLOW_LIVE_SENDS=false`.
- Treat PostgreSQL as irreplaceable business state; Redis queues are recoverable transport.

Development and production must not share credentials, databases, Redis instances, webhook secrets,
session IDs or Docker volumes.

## Container topology

Production needs these Runtime services:

| Service | Replication guidance |
| --- | --- |
| PostgreSQL | One primary with tested backups. |
| Redis | One persistent private instance using `noeviction`. |
| migrate | One-shot before application processes start. |
| API | One initially; scale only with shared rate/auth policy. |
| scheduler | One initially to keep dispatch behavior simple. |
| worker | One initially because outbound concurrency is deliberately 1. |

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

Readiness checks PostgreSQL and reports the live-send interlock, pinned OpenWA release and number of
allowlisted sessions. It does not prove that OpenWA is currently paired; session sendability is
visible through the session API and campaign preflight.

Useful container checks:

```bash
docker compose ps
docker compose logs --since=15m api worker scheduler migrate
docker compose exec -T postgres pg_isready -U automation -d automation_runtime
docker compose exec -T redis redis-cli ping
```

Alert on repeated worker failures, runs stuck in `PREPARING`, unexpected `UNKNOWN` deliveries,
session restrictions, increasing capability refresh failures, database storage pressure and Redis
`noeviction` write failures.

## Backup and restore

Store backup scripts and archives outside the OpenWA project. A suitable separation is:

```text
/opt/automation-runtime/              deployment
/opt/automation-runtime/scripts/      Runtime maintenance scripts
/var/backups/automation-runtime/      backup archives
```

The minimum Runtime backup is a PostgreSQL logical dump plus the exact application release tag and
environment inventory. Never put secrets into the backup filename or command output.

Example logical backup:

```bash
umask 077
docker compose exec -T postgres \
  pg_dump -U automation -d automation_runtime -Fc \
  > /var/backups/automation-runtime/runtime-$(date -u +%Y%m%dT%H%M%SZ).dump
```

Test restoration periodically into an isolated database. A restore replaces or merges durable
business data and must be performed during a declared maintenance window with API, scheduler and
worker stopped. Document and rehearse the exact restore command for the chosen PostgreSQL hosting
model before production launch.

Redis AOF is useful for short outages but is not a substitute for PostgreSQL backup. After Redis
loss, start Redis, then scheduler and worker; durable pending rows will be enqueued again.

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

Prefer a forward corrective release for additive migrations. Restore a database backup only after
explicitly accepting that post-backup campaign and delivery state will be lost.
