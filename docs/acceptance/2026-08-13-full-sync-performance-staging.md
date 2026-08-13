# Full sync performance — staging, 2026-08-13

## Scope

- Runtime endpoint: `https://wa-runtime-staging.onio.cc`.
- OpenWA release: `0.16.0`.
- One allowlisted session with 574 synchronized groups and approximately 535,000 member rows.
- Live sends remained disabled.
- The fixed per-session limit remained 40 group reads per minute; adaptive pacing remained disabled.

## Finding 1: notification wake-up missed the pacing deadline

Before `59d2120`, a successful item emitted PostgreSQL `NOTIFY` while the session's
`next_request_at` was still in the future. The dispatcher rejected that item and had no due-time
timer, so work resumed only on the 10-second polling fallback.

Observed before the fix:

- mean OpenWA plus persistence duration: 0.503 seconds;
- p95 item duration: 0.564 seconds;
- mean completion gap: 10.014 seconds;
- effective throughput: approximately 6 groups per minute.

`59d2120` makes the repository return the durable availability timestamp and publishes the next
BullMQ item with a matching delay. PostgreSQL remains authoritative and the claim path still
enforces one in-flight group read per session.

Observed after the fix over 524 items in the first run:

- mean completion gap: 1.510 seconds;
- p95 completion gap: 1.621 seconds;
- maximum completion gap: 2.003 seconds;
- p95 item duration: 0.654 seconds;
- no warning, error, retry, skip, 429 or lost-ownership event.

## Finding 2: changed fingerprints caused full member replacement

The first run also populated missing member fingerprints for 422 groups. A second full run showed
that some OpenWA member snapshots legitimately changed. The old persistence path deleted and
reinserted every member in such a group, even if only one member field had changed.

`02af80d` retains the fingerprint fast path and, when a fingerprint changes, performs a
differential `INSERT ... ON CONFLICT DO UPDATE ... WHERE ... IS DISTINCT FROM` followed by deletion
of participant IDs missing from the authoritative snapshot.

Within the same second full run:

| Window | Groups | Inserts | Deletes | Insert/delete rows per group |
| --- | ---: | ---: | ---: | ---: |
| Before differential write | 220 | 143,251 | 142,668 | approximately 651 |
| After differential write | 354 | 2,688 | 2,689 | approximately 7.6 |

This reduced member write amplification by approximately 86 times for the observed workload. From
the differential deployment to completion, database size increased by approximately 172 KB.

## Terminal steady-state result

- Run ID: `6765eeca-a014-4bcb-a883-6bbf4cb5c2da`.
- Result: 574 completed, zero failed, zero skipped, 267,659 members observed.
- Duration: 878.466 seconds (14 minutes 38 seconds), including one rolling restart.
- Effective throughput: approximately 39.2 groups per minute.
- Completion gap: mean 1.515 seconds, p50 1.510 seconds, p95 1.621 seconds.
- Item duration: mean 0.436 seconds, p95 0.637 seconds.
- Runtime processes were healthy on immutable image `wa-runtime:02af80d` after completion.
- End-state memory: API 50.84 MiB, worker 51.27 MiB, scheduler 50.43 MiB,
  PostgreSQL 172.1 MiB and Redis 14.34 MiB.

## Remaining decision

The active bottleneck is now the intentional 40-group-per-minute session limit, not CPU, memory,
PostgreSQL or OpenWA response time. Do not raise the limit from this single clean run. First observe
fixed-rate staging for 24–72 hours, including real webhook traffic and any 429/cooldown events, then
decide whether to enable the existing adaptive-pacing feature or change the configured ceiling.
