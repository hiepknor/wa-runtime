# ADR 003: Durable incremental group reconciliation

- Status: Accepted
- Date: 2026-08-13

## Context

The OpenWA 0.16.0 Baileys group-list endpoint calls WhatsApp's
`groupFetchAllParticipating()` before applying HTTP pagination. WA Runtime then calls the group-detail
endpoint once per group to persist the authoritative member collection and send-capability inputs.

The staging baseline for `prod-session` was 574 groups and 267,660 synchronized members. A full run
took 598 seconds and OpenWA logged approximately 140 `rate-overlimit` failures while Runtime retried
the HTTP 500 responses used by OpenWA to surface the underlying WhatsApp 429. Although group details
were committed incrementally, the parent `sync_runs` counters remained zero until the run completed.

The previous run-sized retry boundary repeated discovery after one group failed, provided no durable
per-group retry state, and made a healthy long-running synchronization appear stuck to WA Studio.

## Decision

WA Runtime owns group reconciliation as durable PostgreSQL work:

1. A sync run first discovers the authoritative group-summary snapshot and publishes it immediately.
2. Discovery creates one durable reconciliation item for every group selected by the requested mode.
3. `FULL` selects every active discovered group. `INCREMENTAL` selects new, invalidated, changed, or
   stale groups.
4. Each item has its own attempts, next-attempt timestamp, lease token, error and terminal outcome.
5. PostgreSQL owns retry, fencing, progress and per-session request pacing. BullMQ remains a
   rediscoverable dispatch transport.
6. Only one active run exists per session. A repeated request returns that run.
7. Group-detail reads are paced per session and are not retried inside the OpenWA HTTP adapter. A
   retryable response becomes one durable item retry with cooldown instead of an immediate request
   burst.
8. Parent progress is updated as items finish. A failed item does not replay completed siblings.
9. Full-sync writes remain fenced by the session sync epoch. Item writes additionally require the
   current item lease.
10. Gateway group events invalidate the affected group and are reconciled by targeted durable work;
    periodic incremental and operator-triggered full runs remain the missed-event safety net.
11. Discovery records the latest observed summary fingerprint, but only a successfully fenced
    detail reconciliation advances the reconciled fingerprint. A failed item therefore remains
    eligible for the next incremental run.
12. Item leases are renewed while upstream reads and database writes are in progress. A worker that
    loses ownership stops finalizing the item and lets PostgreSQL recovery choose the next owner.
13. A destructive snapshot reduction must be observed consistently before it can deactivate
    existing groups. A first suspicious snapshot delays the durable discovery run without mutating
    the group read model.
14. A duplicate request with the same mode returns the active run. A request with a different mode
    conflicts instead of silently changing or discarding operator intent.
15. Retryability and upstream rate pressure are separate decisions. Only rate-pressure failures
    extend the shared session cooldown.

The public request is additive. Omitting a request body preserves the existing `FULL` behavior;
new clients may explicitly request `INCREMENTAL`. Existing sync-run fields remain and new discovery,
phase, scheduling and failure counters are additive.

Initial operational defaults are 40 group-detail requests per minute per session, one request at a
time, a 24-hour stale threshold and five item attempts. These are configurable and must be tuned from
staging evidence, not increased by adding worker concurrency.

The initial destructive-snapshot guard applies when a session previously had at least 20 groups and
the new count falls below 25 percent of that baseline. Two identical suspicious snapshots are
required before publication. These thresholds are configurable and operate independently per
session.

## Consequences

- Group summaries become visible before member reconciliation finishes.
- Runtime can resume after Redis loss or process restart without repeating completed groups.
- A full run may take longer under deliberate pacing, but it stops amplifying WhatsApp overload.
- Progress becomes meaningful while a run is active.
- Progress distinguishes pending, running and retrying items and exposes only aggregate pacing
  state; item and group identities remain internal.
- Additive tables and columns remain readable by the previous binary, but the one-active-run index
  changes duplicate-request behavior; application rollback therefore requires quiescing sync
  requests or a forward fix rather than assuming unrestricted binary rollback.
- OpenWA still performs one expensive full group-list query during discovery. Removing that cost or
  reusing its returned full metadata requires a separately reviewed OpenWA release.

## Rejected alternatives

- Reducing OpenWA HTTP page size: pagination occurs after the upstream full fetch and may repeat it.
- Increasing worker concurrency: raises the WhatsApp metadata request burst.
- Increasing in-memory HTTP retries: loses retry state on restart and amplifies rate limiting.
- Using the OpenWA chat list as group discovery: it is a partial activity cache, not authoritative
  membership.
- Relying only on webhooks: delivery can be missed and event payloads are not always a full member
  snapshot.

## Rollout gates

1. Contract and migrations are additive and generated artifacts match source.
2. Integration tests prove duplicate-run suppression, item fencing, retry recovery, progress,
   session isolation and no replay of completed groups.
3. Tests prove a failed changed-summary item remains dirty, long work renews its lease, and one
   suspicious snapshot cannot deactivate an established dataset.
4. Staging demonstrates bounded group-detail request rate, continuously increasing progress and no
   sustained `rate-overlimit` burst.
5. A second unchanged incremental staging run schedules approximately zero items after fingerprint
   warm-up.
6. WA Studio adopts explicit Reload, Incremental Sync and confirmed Full Sync semantics before the
   no-body compatibility default is reconsidered in a future API version.
