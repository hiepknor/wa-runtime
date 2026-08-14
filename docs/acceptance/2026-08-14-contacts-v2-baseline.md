# Contacts v2 pre-implementation baseline — 2026-08-14

This record captures the aggregate staging state before ADR 007 implementation. Queries selected the
session owning the latest `contact_sync_state` row and emitted no session ID, group ID, participant ID,
phone number or contact name.

Runtime image: `wa-runtime:ccf01d0`.

## Member and contact coverage

| Metric | Result |
| --- | ---: |
| Synchronized member rows | 267,581 |
| Member rows linked to the ADR 005 contact model | 267,581 (100%) |
| Member rows with a non-empty display name | 21,193 (7.92%) |
| LID member rows | 205,865 |
| Named LID rows | 76 (0.04%) |
| Phone-JID member rows | 61,716 |
| Named phone-JID rows | 21,117 (34.22%) |
| LID rows whose legacy `phone_number` equals the LID user-part | 205,865 (100%) |
| Distinct contacts referenced by members | 24,171 |
| Contact rows | 24,532 |
| Contact identifiers | 25,689 |
| Contact-name evidence rows | 450 |

Materialized member names by source:

| Source | Member rows |
| --- | ---: |
| `OPENWA_CONTACT_NAME` | 4,061 |
| `OPENWA_PUSH_NAME` | 17,132 |
| No name source | 246,388 |

The difference between 450 name-evidence rows and 21,193 named member rows is expected: one observed
contact can occur in many synchronized groups. It also quantifies the synchronous fan-out that ADR
007 will replace with coalesced projection work.

## Snapshot state

| Metric | Result |
| --- | ---: |
| Current generation | 1 |
| Last successful upstream records | 250 |
| Attempt count | 0 |
| Active lease | no |
| Last error | none |
| Time until the next periodic attempt | about 22.3 hours |

The naturally due generation-2 periodic execution remains a separate rollout gate; this baseline did
not force it early.

## Member API latency

The largest group in the selected session contained 1,933 synchronized members. Five consecutive
unfiltered 25-row page reads completed in 6.3–7.1 ms and returned 3,247 bytes. A literal search with no
match completed in 12.9 ms and returned 52 bytes.

These measurements confirm the current request path is healthy for the observed group sizes. They do
not justify a new member search or ordering index before the v2 projection query and a larger benchmark
produce query-plan evidence.

## Resource baseline

| Component | Memory at sample |
| --- | ---: |
| API | 58.13 MiB |
| Worker | 50.82 MiB |
| Scheduler | 53.95 MiB |
| PostgreSQL container | 237.1 MiB |

- PostgreSQL database size: 593,778,355 bytes (about 566 MiB).
- Server filesystem: 15 GiB used of 59 GiB; 43 GiB available (26% used).
- The preceding full group sync completed 574/574 groups in 878.097 seconds with zero failed or
  skipped groups, as recorded in the ADR 005 staging acceptance report.

## Initial release thresholds

Before enabling each v2 stage authoritatively:

- member-to-identity linkage must remain 100%;
- LID user-parts materialized as resolved phones must remain zero;
- full-sync duration must not regress by more than 10% without an explained upstream variance;
- member page p95 for the current largest staging group must remain below 50 ms;
- projection lag target is p95 below 30 seconds once the durable materializer is enabled;
- webhook processing must remain independent of projection failure;
- database growth, WAL and dead tuples must be measured after backfill and after at least one natural
  periodic snapshot before production approval.

All later acceptance records must compare against this file and continue to report only aggregate,
non-PII measurements.
