# WA Runtime storage namespace migration

Use this runbook to migrate an existing installation from legacy PostgreSQL and Docker volume
identifiers to the clean namespace defined by [ADR 002](../adr/002-rename-to-wa-runtime.md). This is
a maintenance operation: do not run it while API, scheduler or worker processes are active.

## Target state

| Resource | Target |
| --- | --- |
| PostgreSQL database | `wa_runtime` |
| PostgreSQL role | `wa_runtime` |
| PostgreSQL volume | `wa-runtime_postgres-data` |
| Redis volume | `wa-runtime_redis-data` |

The commands below deliberately use explicit resource names. Adapt credentials and backup paths to
the installation without printing secrets into logs or shell history.

## Preconditions

1. Pin the exact WA Runtime release and record the current image digest and Compose configuration.
2. Disable live sends and stop external webhook delivery or route it to a maintenance response.
3. Verify there is enough disk space for a logical PostgreSQL dump and a second set of volumes.
4. Record counts for every business table and the latest `schema_migrations` entry.
5. Create a PostgreSQL custom-format dump and verify that `pg_restore --list` can read it.
6. Record the current PostgreSQL and Redis volume names from `docker inspect`; do not infer them.

## Migration

1. Stop `api`, `scheduler` and every `worker`. Allow no new writes after the baseline is recorded.
2. Stop the remaining old Compose services after the PostgreSQL dump completes.
3. Start a clean PostgreSQL service backed by `wa-runtime_postgres-data`, with database and role
   `wa_runtime`.
4. Restore the verified logical dump into `wa_runtime`, then run the pinned Runtime migration job.
5. Start a clean Redis service backed by `wa-runtime_redis-data`. Redis is recoverable transport;
   allow the scheduler and workers to republish durable pending work from PostgreSQL instead of
   copying stale process heartbeats or scheduler telemetry.
6. Set `WA_RUNTIME_DB_NAME`, `WA_RUNTIME_DB_USER` and `DATABASE_URL` to `wa_runtime`. The Compose
   file always uses the target volumes; source-volume attachment must be handled outside the target
   configuration during the maintenance procedure.
7. Start one scheduler, one worker and the API. Scale workers only after readiness is stable.

## Verification

The migration passes only when all of the following are recorded:

- PostgreSQL and Redis are ready and mounted from the two target volumes;
- every baseline table count reconciles, with any expected migration delta explained;
- the latest migration version matches the pinned release;
- API readiness, session listing, group detail, member pagination/search and capability refresh pass;
- pending durable work is rediscovered without duplicate live sends;
- no container label, active mount, database connection or operational probe uses a legacy name;
- a restore test of the retained logical dump succeeds in an isolated database.

Keep the source volumes stopped and unmodified until backup verification, data reconciliation and
application smoke tests pass. They may then be explicitly removed when the operator accepts the
logical backup as the rollback artifact.

## Rollback

If verification fails, stop the target stack before any additional writes occur, restore the prior
environment and explicitly attach the recorded source volumes outside the target Compose
configuration, then start the pinned previous release. Record any target-side writes before deciding
whether they must be reconciled back into the source database.
Never point two PostgreSQL instances at the same data volume.
