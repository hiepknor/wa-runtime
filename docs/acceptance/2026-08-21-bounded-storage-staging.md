# Bounded Runtime storage — staging, 2026-08-21

## Scope

- Initial bounded-storage release and immutable image: `a134c10` / `wa-runtime:a134c10`.
- Current optimized release and immutable image: `6f03b5a` / `wa-runtime:6f03b5a`.
- Current rollback release: `f5eeae0`.
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

## Initial bounded-storage deployment

API, worker and scheduler were stopped while PostgreSQL and Redis remained available. Migration 041
completed successfully, and the maintenance window was about 20 seconds. Release symlinks now
resolved at that cutover to:

- `current -> /opt/wa-runtime/releases/a134c10`;
- `previous -> /opt/wa-runtime/releases/b671ee6`.

API, worker and scheduler were healthy on `wa-runtime:a134c10`. PostgreSQL and Redis were healthy,
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
- After migrations 043 and 044, 26 integration files with 216 tests passed, including the guard-index
  and table-option assertions.
- Architecture checks, type checking and production build passed.
- The local worktree was clean and `main` matched `origin/main` before deployment.

## Gate

Implementation, migration and initial staging rollout: **PASS**.

Long-term capacity: **PENDING**. The recovered 11 GB is an adequate emergency operating margin for
the rollout but does not satisfy the 30-day free-space target under the pre-change growth rate.
Expand the cloud volume, then observe seven days of post-change growth before deciding whether table
partitioning or a cursor-store redesign is justified. Do not use `VACUUM FULL` as routine capacity
management because it needs table locks and temporary disk headroom that this VPS does not have.

The host identifies as Tencent Cloud CVM `ins-jas6o3cy` in `ap-singapore-2`. Its 60 GiB `/dev/vda`
is fully occupied by the ext4 root partition `/dev/vda2`. Neither the operator workstation nor the
instance has a Tencent Cloud credential or attached CAM role, so increasing the billable system disk
to 150 GiB remains a cloud-account action. Guest tools `growpart` and `resize2fs` are already present;
after the provider reports the larger block device, expand the partition and filesystem, then start
a fresh seven-day gate.

The versioned gate evaluator from revision `384132e` is installed under
`/opt/wa-runtime/tools/storage-acceptance/384132e`, with `current` resolving to that immutable path.
It was exercised against the live observer files and correctly returned `PENDING` (exit 2): the
current observation window was 0.139 days, the filesystem was 58.94 GiB, no retention tick was
capacity-exhausted, p95 cleanup duration was 26.101 seconds, the oldest Contact intent was 11 seconds,
and all three active seven-day families showed burst delete rates above average ingest. Its
preliminary conservative growth estimate left only 3.7 days of headroom on the unexpanded disk; this
short window is evidence for expansion urgency, not the final seven-day capacity result.

The guest is already prepared for a guarded online extension: it has a GPT partition table,
`/dev/vda2` is the final partition, `/` is read-write ext4, `growpart` and `resize2fs` are installed,
and cloud-init includes both `growpart` and `resizefs`. The operational guard performs no mutation
until the provider block device is at least 150 GiB and an operator confirms a verified snapshot.
Revision `98afc77` is installed root-owned with mode `0755` at
`/opt/wa-runtime/scripts/runtime-root-filesystem-expand.sh`; its SHA-256 is
`09974d8d8ed0c2d3cc0d44cc70f914ea9dcca31ba2b7f5668dd5bb9e4f63c4fa`. A live check against the
current 60 GiB disk returned the expected `PENDING` exit 2 without mutation.

A daily systemd acceptance timer atomically refreshes the root-only latest JSON report. `PENDING` is
an accepted service result during collection, while a gate `FAIL` deliberately fails the oneshot so
the existing systemd monitoring surface can alert without losing the diagnostic report.
Revision `5d379ff` is installed and enabled as `wa-runtime-storage-acceptance.timer`. Its first
oneshot completed successfully with evaluator status `PENDING`; the report is root-owned mode `0600`
at `/opt/wa-runtime/shared/runtime-storage-acceptance.json`. The timer is scheduled daily with a
ten-minute randomized delay after 00:20 UTC. Installed SHA-256 values are
`994d4c4d794a78e195cff8df029ee545e6435f9f962e536d086a88438fe7c33b` for the monitor,
`812d440b900ecc26fbf2cef4eb83b4bdbfd5187b9020e034cb5d31d5df10ecda` for the service and
`c36c8c70ed8bacc1957b5ac301a0d2c97111ef5dae40bfb246afd64f98eb1bc7` for the timer.

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

## OpenWA message-retention stabilization

A follow-up attribution audit found that OpenWA PostgreSQL was the largest remaining live consumer:
about 14.1 GB under `/srv/openwa/postgres`, with the `messages` relation accounting for about
13.6 GB and 2.8 million rows. OpenWA `0.22.0` has no native message-retention setting, so retention
was implemented strictly in the host operations layer. The OpenWA application source, release tag
and immutable image were not changed.

Before deleting message history, a fresh PostgreSQL 17 custom-format backup was streamed off-host
to `/Users/hiepknor/Backups/openwa/openwa-pre-messages-retention-20260821T090816Z.dump`. The file is
1,728,872,724 bytes with mode `0600`; SHA-256
`a74f16a3c3dc015b9ff9194858bbea5d01fec55a306355115a268370c2720a97` and a full
`pg_restore --list` catalog check with 82 entries both passed.

The existing indexed operations job was activated with a three-day retention window, 5,000-row
batches, a 120-second run budget, two-second lock timeout, 15-second statement timeout and a 3 GiB
free-space guard. It uses an exclusive host lock plus `FOR UPDATE SKIP LOCKED`, and each batch is a
separate transaction. Two isolated catch-up runs deleted 725,000 and 930,180 expired rows. Each run
was followed by PostgreSQL autovacuum before proceeding, avoiding overlapping bulk deletion and
vacuum work. The first timer-triggered steady-state run then deleted 3,906 newly expired rows in one
second and left zero rows behind its fixed cutoff. The next calendar-triggered run deleted 753 rows
in one second, again left zero rows behind its fixed cutoff and scheduled the following tick normally.

`openwa-messages-retention.timer` is enabled, active and scheduled every five minutes with up to 30
seconds randomized delay. The job is bounded by systemd to 180 seconds and retains a `DRY_RUN`
switch in its root-only environment file. After catch-up, about 1.17 million messages remained in
the rolling three-day window. Autovacuum reduced the main-table dead-tuple estimate to 16 and
completed the large-object cleanup without an error. Runtime readiness remained HTTP 200 and the
OpenWA API remained healthy throughout.

Regular vacuum deliberately preserves the allocated PostgreSQL relation pages for reuse; it does
not promise an immediate reduction in root-filesystem usage. The root filesystem therefore remained
at 81 percent with about 12.1 GB available after the temporary WAL high-water subsided. This stops
the dominant unbounded logical growth but does not replace the required 150 GiB cloud-volume
expansion. `VACUUM FULL` remains prohibited on this host because it would need an unsafe table lock
and temporary copy space. A forced post-retention Runtime observer sample and daily gate execution
both succeeded at `2026-08-21T09:41:43Z`; the gate correctly remained `PENDING` on the 58.94 GiB
filesystem with only 0.184 days of evidence.

## Contact-resolution completion optimization

The next daily contact resolution completed its durable data correctly but the scheduler reported a
five-minute timeout. It resolved 62,389 identities into 42,989 clusters, including 38,800 linked
identities and zero conflicts. A read-only phase profile showed that graph construction took 1.551
seconds and projection diffing took 1.968 seconds; neither was the scaling bottleneck.

A rollback-only staging reproduction isolated the completion-metrics CTE. Cluster insertion took
3.071 seconds, assignment insertion 3.545 seconds and name projection 5.156 seconds, while the old
metrics query alone took 337.446 seconds. It joined the newly inserted persistent cluster and
assignment rows before PostgreSQL had statistics for the run, producing a CPU-bound nested-loop
plan. Revision `3a03c3e` now computes the same four metrics from the already materialized temporary
component and conflict tables. On the same 62,389-identity dataset, the replacement took 351 ms and
returned the exact production result, an approximately 961-fold reduction for that phase.

The same revision records one real completion instant with `clock_timestamp()`. Projection enqueue
now uses one `statement_timestamp()` per statement so its evidence cutoff is guaranteed to include a
resolution completed earlier in the same long transaction. This preserves snapshot fencing while
removing the prior zero-duration observability error. All 19 projection integration tests and all
five resolution integration tests passed after this coupling was corrected.

## Seven-day message-observation retention

The first exact seven-day candidate probe exposed two missing query-path indexes rather than a need
for a large new index on the 2.4-million-row observation table. Migration 043, revision `f5eeae0`,
added partial indexes for active projection work by session and protected cluster-name observations
by observation ID. Each index occupied 188,416 bytes on staging. The exact 5,000-row production
candidate query improved from a 30-second statement timeout to 5.621 seconds. Migration 043 applied
online in 4.48 seconds; its checksum is
`631da3d700dc14e30aeb8cef797a6530a87d3f699b9b613afa107d2e79b62b6e`.

`CONTACT_MESSAGE_OBSERVATION_RETENTION_DAYS=7` was then enabled on the scheduler. The first live tick
deleted 83,475 redundant contact observations and 479 other retained rows in 17 batches and 59.735
seconds. A post-restart tick deleted another 2,898 contact observations plus 5,888 inbox/raw rows in
one batch and 6.713 seconds. Both reported `capacityExhausted=false`; readiness remained healthy.
Cleanup still preserves the newest message-derived push name per identity, all generation-scoped
snapshot evidence, observations referenced by resolved clusters, and every session with active
resolution or projection work.

Because this makes `contact_observations` a high-churn retained table, migration 044, revision
`6f03b5a`, applied the same reviewed 10,000-row floor, five-percent vacuum scale factor and
two-percent analyze scale factor used by the other retained owners. It changed table metadata only,
applied in 2.30 seconds and has checksum
`ccec14f1726c4e3b60b7a1b1cfd8b33b7c96f01a82be7cf792e84d09b08c7696`.

The final Runtime containers are healthy on `wa-runtime:6f03b5a`; `wa-runtime:f5eeae0` is the retained
rollback image and release. Intermediate Runtime images and an exited successful migration
container were removed, and the final build-cache prune reclaimed 366.5 MB. The final observer
sample recorded 47,824,629,760 bytes used, 12,764,569,600 bytes available and 79-percent root
filesystem utilization. OpenWA remained on `0.22.0`, live sends remained disabled, there were no
post-cutover error-level Runtime logs, and the hourly observer remains active.
