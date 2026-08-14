# Observed contacts — staging, 2026-08-14

## Scope

- Runtime release: `35453e0` (`2bea05d..35453e0`).
- Runtime endpoint: `https://wa-runtime-staging.onio.cc`.
- OpenWA release: `0.16.0`.
- One allowlisted production Gateway session was exercised without recording its identifier or PII.
- Live sends remained disabled.
- Migrations `018_observed_contacts.sql` through `020_contact_snapshot_leases.sql` were applied.

## Backup and schema rollout

A PostgreSQL custom-format backup was created before migration, its catalog was read with the
PostgreSQL 17 `pg_restore`, and its SHA-256 checksum passed. The backup remains outside the release
directory with mode `0600`.

Before contact ingestion was enabled:

- all 535,494 existing member rows across the database linked to a same-session contact;
- the selected session subsequently reported a 100 percent link ratio throughout the run;
- database size increased from 278 MB to 457 MB for the additive schema and identity backfill;
- no member name was synthesized during backfill.

API, worker and scheduler all became healthy on `wa-runtime:35453e0` with zero restarts before any
contact producer was enabled.

## Snapshot and full-sync result

Only `CONTACT_SNAPSHOT_SYNC_ENABLED` was enabled for the first full sync. The contact snapshot:

- observed 250 bounded OpenWA contact records;
- completed in 2.320 seconds;
- reported zero identity merges, conflicts or failures;
- released its PostgreSQL lease and scheduled its next attempt normally.

The full group sync then completed in 878.097 seconds:

| Metric | Result |
| --- | ---: |
| Groups discovered | 574 |
| Groups completed | 574 |
| Groups failed | 0 |
| Groups skipped | 0 |
| Members observed | 267,584 |

This is effectively unchanged from the previous 878.466-second fixed-rate staging baseline. At the
terminal snapshot:

- 267,584 of 267,584 selected-session member rows remained linked;
- 13,719 member rows had a display name (about 5.13 percent);
- 4,061 names materialized from `OPENWA_CONTACT_NAME`;
- 9,658 names materialized from `OPENWA_PUSH_NAME`;
- 76 of 205,899 LID member rows had a display name;
- database size was 462 MB;
- worker memory was 64.5 MiB after completion.

The low LID name coverage confirms ADR 005's upstream-observation limit. Runtime did not infer a
phone number from a LID or invent a fallback name.

## Member API smoke

A group with 1,803 synchronized members was tested without emitting member identifiers or names:

- two adjacent 25-row pages had zero overlap;
- a repeated first page was byte-order stable;
- API ordering matched the database's deterministic ordering exactly;
- an offset beyond the filtered total returned an empty page and retained `meta.total=1803`;
- a server-side display-name search returned the expected single match;
- the 25-row response payload was 3,245 bytes.

This preserved database-side search, count, ordering and pagination after name materialization.

## Message enrichment and webhook finding

The first inbound-message attempt did not reach Runtime because the current OpenWA session had zero
registered webhooks. Runtime does not currently reconcile webhook registration automatically. An
active HTTPS callback was registered with the reviewed message, session and group event set; the
internal Docker callback was correctly rejected by OpenWA's destination policy.

After enabling `CONTACT_MESSAGE_ENRICHMENT_ENABLED` and restoring the callback:

- 131 of 131 observed `message.received` events reached `PROCESSED`;
- zero events entered `RETRY` or `DEAD`;
- 128 events carried a usable push name;
- 10 contact-name identities were observed or refreshed;
- 689 repeated group-member rows were materialized from those identities;
- zero higher-precedence names were replaced by push names;
- zero raw contact objects were copied into normalized `runtime_events`;
- zero contact-observer failures or worker restarts occurred.

## Periodic refresh and remaining observation

`CONTACT_PERIODIC_SYNC_ENABLED=true` is deployed with a 24-hour interval. At enablement, generation
remained `1`, no lease was held and the next attempt was approximately 23.6 hours away, so the
scheduler did not duplicate the successful full-triggered snapshot.

The first naturally due periodic snapshot remains an observation gate. Confirm that it increments
the generation once, retains lease ownership, completes without overlap and schedules the following
attempt before using this rollout evidence for production approval.

## Storage note

The VPS reached 96 percent disk utilization during build and WAL-heavy backfill. One unused OpenWA
image and obsolete Runtime images were removed while retaining `wa-runtime:35453e0`, rollback image
`wa-runtime:a807497`, and the active tagged OpenWA `0.16.0` image. Free space recovered to 4.9 GB
(92 percent used). This is sufficient for staging observation but remains an operational warning;
production rollout needs a disk-capacity threshold and image-retention policy.

## Gate

Snapshot ingestion, full sync, member reads and message enrichment: **PASS**.

First periodic execution and sustained disk/coverage observation: **PENDING**.

