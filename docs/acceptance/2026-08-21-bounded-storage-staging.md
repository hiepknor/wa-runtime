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

## Automated verification

- `npm run check:all` passed on `a134c10`.
- 42 unit files with 136 tests passed.
- 26 integration files with 214 tests passed.
- Architecture checks, type checking and production build passed.
- The local worktree was clean and `main` matched `origin/main` before deployment.

## Gate

Implementation, migration and initial staging rollout: **PASS**.

Long-term capacity: **PENDING**. The recovered 11 GB is an adequate emergency operating margin for
the rollout but does not satisfy the 30-day free-space target under the pre-change growth rate.
Expand the cloud volume, then observe seven days of post-change growth before deciding whether table
partitioning or a cursor-store redesign is justified. Do not use `VACUUM FULL` as routine capacity
management because it needs table locks and temporary disk headroom that this VPS does not have.
