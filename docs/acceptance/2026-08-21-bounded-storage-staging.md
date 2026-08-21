# Bounded Runtime storage — staging, 2026-08-21

## Scope

- Runtime release and immutable image: `a134c10` / `wa-runtime:a134c10`.
- Previous rollback release: `b671ee6`.
- Staging origin: `https://wa-runtime-staging.onio.cc`.
- OpenWA remained pinned to release `0.22.0`.
- Live sends remained disabled.
- Migration `041_runtime_storage_ownership.sql` was applied.
- Runtime event compaction and seven-day inbox retention were enabled in phase 1. Processed raw
  webhook compaction was enabled in phase 2 after the first smoke window passed.

## Capacity recovery and backup

The root filesystem started at 95 percent utilization with about 3 GB free. The largest avoidable
consumer was a 5.8 GB abandoned, unmounted temporary OpenWA export. A separate current OpenWA
compressed backup already existed, and no process held the temporary directory open, so the exact
temporary export was removed. Obsolete Docker images and build cache were also removed without
touching running images or named volumes.

Before the Runtime migration, a 4.7 GB PostgreSQL custom-format backup was streamed off the VPS to:

`/Users/hiepknor/Backups/wa-runtime/runtime-pre-a134c10-20260821T043000Z.dump`

- SHA-256: `280bd1a6eb1c844232aecfb152844e2727878fa148653adb0886bb36edc8a708`.
- File mode: `0600`.
- The checksum and PostgreSQL 17 `pg_restore --list` catalog check passed.

Cleanup temporarily recovered about 13 GB free. After building the release and creating the 362 MB
inbox retention index, the 59 GB root filesystem had 11 GB free and was 81 percent utilized. Only
the current and previous Runtime images are retained. The guest partition already occupies the
whole attached 60 GB disk, so additional capacity must be allocated at the cloud-volume layer.

## Deployment

API, worker and scheduler were stopped while PostgreSQL and Redis remained available. Migration 041
completed successfully, and the maintenance window was about 20 seconds. Release symlinks now
resolve to:

- `current -> /opt/wa-runtime/releases/a134c10`;
- `previous -> /opt/wa-runtime/releases/b671ee6`.

API, worker and scheduler are healthy on `wa-runtime:a134c10`. PostgreSQL and Redis are healthy,
external readiness reports `ready`, OpenWA reports `0.22.0`, and live sends are still disabled.

## Storage and durability evidence

Phase 1 enabled compact `message.received` ledger payloads while retaining full raw webhook payloads.
It produced 638 version-2 ledger events with an average payload size of 287 bytes before phase 2.

The phase-2 worker started at `2026-08-21T05:03:48.905971425Z`. In the following smoke window:

| Check | Evidence | Result |
| --- | --- | --- |
| Processed raw compaction | 2,003 of 2,003 processed webhooks had compact receipts; average payload 336 bytes | PASS |
| Runtime ledger compaction | 2,071 `message.received` v2 events; average payload 286 bytes | PASS |
| Contact intent durability | Recent batches completed every claimed intent with zero retry, dead or lost-ownership results | PASS |
| Contact intent latency | Snapshot held 3 pending and 59 processing rows; oldest active intent was 9 seconds | PASS |
| Retention ownership | Only 2,816 inbox and 2,818 raw webhook rows were beyond their seven-day cutoffs; no Runtime event was beyond 30 days | PASS |
| Schema | Migration 041 recorded; retention index valid and ready; contact intent table present | PASS |
| Process health | Zero API, worker or scheduler error-level logs in the initial 15-minute window | PASS |
| Readiness | HTTPS readiness `ready`; PostgreSQL, Redis, worker and scheduler healthy | PASS |

Retries and dead-letter rows continue to retain their full raw payload. Only a successfully processed
webhook is replaced by a compact receipt. Contact observation is no longer a best-effort side effect:
its durable intent is committed atomically with the normalized projections and processed webhook
state, then consumed by the scheduler.

At the observation snapshot, the database was 19 GB. The largest relations remained historical
data accumulated before this release: about 6,342 MB for `webhook_events`, 5,175 MB for
`inbound_messages`, 4,744 MB for `runtime_events`, and 1,916 MB for `contact_observations`.
Compaction and retention bound new logical growth; they intentionally do not rewrite or vacuum-full
historical tables during the rollout.

## Seven-day observation automation

Operational revision `2410fb9` installed an hourly, low-priority systemd observer without rebuilding
or restarting the Runtime application image. `wa-runtime-storage-observation.timer` is enabled and
active. Its first sandboxed service execution completed with exit status zero and recorded a
35-field aggregate sample at `2026-08-21T05:17:02Z`.

The observation file is root-owned with mode `0600` at
`/opt/wa-runtime/shared/runtime-storage-observations.tsv`. It contains filesystem/database sizes,
PostgreSQL table-statistics counters and aggregate Contact intent state only. It does not select
message bodies, webhook payloads, identities or names. The initial statistics exposed approximately
498,272 dead tuples in `webhook_events`, consistent with inserting a recoverable full envelope and
then compacting it on success. Autovacuum had already completed once; the seven-day series will show
whether it maintains reusable space or whether ADR 012's partition trigger is reached.

## High-churn autovacuum rollout

The initial observer evidence showed that `webhook_events` reached 19.55 percent dead tuples before
PostgreSQL's cluster-wide 20-percent default initiated cleanup. Operational revisions `51d0116` and
`64ff9d2` added migration `042_high_churn_autovacuum.sql`, its integration assertion and fail-fast
lock/statement timeouts. The migration changes table metadata only; it does not rewrite a table or
index and does not alter cluster-wide autovacuum resource controls.

Migration 042 applied online in 2.568 seconds without restarting API, worker or scheduler. The
recorded checksum is `99ec6f7b05c61330e8892c0c235ec6607ef722ec2251d60200df87e3d7088336`.
All three high-churn tables report the reviewed 10,000-row floor, five-percent vacuum scale factor
and two-percent analyze scale factor.

Because the existing 508,069 dead webhook tuples already exceeded the new trigger, PostgreSQL began
autovacuum immediately. The first backlog cleanup completed in about 87 seconds, increased
`autovacuum_count` from one to two and reduced the estimate to 1,544 dead tuples. Ten HTTPS readiness
samples taken during that first, largest cleanup ranged from 145 to 279 ms with no failures. I/O wait
returned to 2–6 percent after completion. A post-vacuum aggregate sample was appended to the hourly
series; subsequent lower-trigger runs remain part of the seven-day gate.

## Automated verification

- `npm run check:all` passed on `a134c10`.
- 42 unit files with 136 tests passed.
- On application revision `a134c10`, 26 integration files with 214 tests passed.
- After migration 042, 26 integration files with 215 tests passed, including the table-option
  assertion.
- Architecture checks, type checking and production build passed.
- The local worktree was clean and `main` matched `origin/main` before deployment.

## Gate

Implementation, migration and initial staging rollout: **PASS**.

Long-term capacity: **PENDING**. The recovered 11 GB is an adequate emergency operating margin for
the rollout but does not satisfy the 30-day free-space target under the pre-change growth rate.
Expand the cloud volume, then observe seven days of post-change growth before deciding whether table
partitioning or a cursor-store redesign is justified. Do not use `VACUUM FULL` as routine capacity
management because it needs table locks and temporary disk headroom that this VPS does not have.

## Follow-up host cleanup

A second read-only audit found no duplicate PostgreSQL indexes and confirmed Docker log rotation was
already bounded for both Runtime and OpenWA. The remaining large consumers were live PostgreSQL data,
not disposable logs or images. A conservative cleanup was performed without touching live or
dangling database volumes:

- the current 1.6 GB OpenWA backup set was streamed off-host to
  `/Users/hiepknor/Backups/openwa/openwa-backup-20260821-031815` with mode `0600`; all four manifest
  checksums and all four compressed tar catalogs passed before the on-host copies were removed;
- five unmounted, unopened restore-test directories dated 2026-08-10/11 and carrying
  `RESTORE-VERIFIED` markers were removed; they can be regenerated from the verified backup;
- 355.5 MB of unused Docker build cache, 109 MB of apt cache, 48 MB of archived journal data and the
  unused `alpine:3.20` and `hello-world:latest` images were removed;
- `wa-runtime:a134c10`, rollback image `wa-runtime:b671ee6`, all running service images and every
  Docker volume were retained. Four unreferenced legacy automation volumes totaling about 420 MB
  remain until their business ownership is explicitly retired.

Filesystem usage fell from 50,036,023,296 to 47,787,724,800 bytes, reclaiming 2,248,298,496 bytes
(about 2.09 GiB). The root filesystem moved from 83 to 79 percent with about 12.8 GB available, and
the post-cleanup readiness and storage-observer execution both passed. This extends the staging
observation runway but still does not satisfy the 30-day capacity gate or remove the cloud-volume
expansion requirement.
