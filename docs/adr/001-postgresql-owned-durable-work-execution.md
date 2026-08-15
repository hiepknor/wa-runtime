# ADR 001: PostgreSQL-owned durable work execution

- Status: Accepted — implementation in progress
- Date: 2026-08-12
- Owners: WA Runtime maintainers

## Context

WA Runtime persists business intent in PostgreSQL and uses BullMQ as recoverable transport.
The API and scheduler can therefore republish work after Redis loss. This boundary is sound, but at
the time of this decision the implementation divided execution ownership and retry policy between
PostgreSQL and BullMQ:

- PostgreSQL stores work status, attempt counts and some processing leases;
- BullMQ may independently retry gateway sync and campaign preparation jobs;
- a database lease identifies expiry but not the worker attempt that owns the row;
- a stale gateway-sync attempt can still mutate the group read model after recovery;
- the Redis outbound-session lock is not a durable business-state boundary;
- a terminal BullMQ job can outlive a failed durable-state transition and block a stable job ID.

These gaps made queue loss recoverable but did not fully fence concurrent or stale workers. They also
allowed public state to temporarily disagree with queue intent, for example a sync run reported as
`FAILED` while BullMQ was waiting to retry it. Phase 1 has since removed BullMQ business retries and
added token-owned database attempts for the retryable workloads listed below.

Live message sending has an additional constraint: the reviewed OpenWA endpoint does not accept a
Runtime idempotency token. Exactly-once delivery is therefore impossible across a transport failure
after the upstream request begins.

## Decision

PostgreSQL will be the sole authority for durable work state, retry timing, retry exhaustion and
execution ownership. BullMQ will be a wake-up transport only.

The implementation must enforce these invariants:

1. Only the attempt holding the current database lease token may renew, complete or fail that
   attempt.
2. Only PostgreSQL decides whether and when durable work is retried.
3. BullMQ delivery may be lost, duplicated or delayed without changing business correctness.
4. A stale gateway-sync attempt cannot mutate session, group or member state after a newer sync
   epoch begins.
5. A live send is never automatically retried after the upstream request may have started; an
   ambiguous outcome remains `UNKNOWN`.

This is a protocol shared by the feature repositories, not a new generic work-item table. Domain
tables remain the source of truth for their own lifecycle.

## Durable attempt protocol

Retryable work stores fields equivalent to:

```text
status
attempt_count
next_attempt_at
lease_token
lease_expires_at
last_error
```

A worker atomically claims due work and receives a fresh random `lease_token`. Lease renewal and
every terminal or retry transition include the work identity, running state and token in the SQL
predicate. A zero-row update means the attempt has lost ownership and must stop mutating durable
state.

On a retryable failure, the owning worker returns the row to its dispatchable state with a bounded
database backoff. When the attempt budget is exhausted, it moves to its domain terminal state:

| Work | Dispatchable | Running | Exhausted |
| --- | --- | --- | --- |
| Webhook normalization | `PENDING` or `RETRY` | `PROCESSING` | `DEAD` |
| Gateway synchronization | `PENDING` | `RUNNING` | `FAILED` |
| Campaign preparation | `PREPARING` and due | leased preparation attempt | `FAILED` |
| Capability refresh | invalidated and due | leased refresh attempt | `REFRESH_FAILED` |

The public gateway-sync status enum remains unchanged. A retryable sync returns to `PENDING` and is
made dispatchable by internal `next_attempt_at`; no public `RETRY` value is introduced.

BullMQ jobs for retryable idempotent durable work use one transport attempt and remove terminal
jobs:

```text
attempts: 1
removeOnComplete: true
removeOnFail: true
```

Stable job IDs prevent duplicate publication while a job exists. They are not leases, retry records
or permanent idempotency keys.

## Gateway synchronization fencing

Gateway synchronization additionally uses a monotonic epoch per session. Claiming a sync attempt:

1. locks the sync run and the session fence row;
2. verifies that no other run for the session is currently `RUNNING`;
3. increments the session epoch;
4. stores the epoch and lease token on the run;
5. moves the run to `RUNNING`.

A database invariant permits at most one `RUNNING` sync run per session. Every full-sync transaction
that writes sessions, group summaries, group details or members verifies the expected epoch while
holding a shared lock on the session fence. A newer claim takes an exclusive lock to advance the
epoch, after which the old attempt cannot write again.

The group read model remains incrementally published. Each group/member replacement is atomic, but
the Runtime does not promise that every group in a session comes from one atomic upstream snapshot.
Per-record `syncedAt` and `detailsSyncedAt` continue to describe freshness. A staging-copy and atomic
snapshot swap are deferred until a product requirement needs session-wide snapshot isolation.

## Live message semantics and session serialization

Live sends keep their existing fail-closed state machine:

```text
SCHEDULED -> QUEUED -> PROCESSING -> ACCEPTED | FAILED | UNKNOWN
```

- A proven failure before the OpenWA request starts may become `FAILED`.
- A definitive OpenWA HTTP result becomes `ACCEPTED` or `FAILED` as appropriate.
- A transport failure after the request starts, or an expired processing lease, becomes `UNKNOWN`.
- `UNKNOWN` is never automatically returned to `SCHEDULED`.

Outbound serialization uses a token-owned PostgreSQL session lease.
Acquisition and renewal use short queries; no database connection or transaction is held across the
configured delay or the OpenWA request. A worker waiting for the session lease continues to renew
its message processing lease. It verifies session-lease ownership immediately before the upstream
request and releases the lease with a token-checked update.

Redis transports message jobs but does not cache session sendability or own the serialization
guarantee. Preflight and live-send policy use the PostgreSQL session projection.

## Scheduler model

The scheduler discovers due rows and publishes wake-up jobs. It does not own work attempts. Feature
processors, through repositories, claim attempts and persist retry or terminal state.

Each scheduler tick has an independent interval, timeout, no-overlap guard and bounded exponential
failure backoff. Independent ticks run concurrently; the same tick cannot overlap itself. A timeout
is an alert boundary, not unsafe cancellation: the no-overlap guard remains held until the underlying
database or queue operation settles.

## OpenWA boundary

The OpenWA adapter will validate upstream JSON at runtime. Pagination must be bounded and detect a
page that repeats or makes no progress. The release-tag check remains an additional compatibility
guard, not a substitute for response validation.

## Alternatives considered

### Keep BullMQ retries and add database tokens

Rejected. Tokens would fence writes, but retry timing and exhaustion would still be split between
Redis and PostgreSQL, and public durable state could still disagree with BullMQ backoff.

### Increase lease durations

Rejected. A longer TTL reduces how often a race occurs but cannot prevent a stale worker from
writing after recovery.

### Use Redis Redlock for all execution ownership

Rejected. PostgreSQL already owns the durable business state. Moving correctness to Redis would
retain two authorities and make Redis loss part of the correctness boundary.

### Hold PostgreSQL advisory locks across OpenWA calls

Rejected. Random pacing and upstream requests can occupy a lock for tens of seconds. Holding pool
connections for that duration does not scale with the current per-process pool size.

### Add a transactional outbox

Rejected for now. Dispatchable domain rows already provide state-based rediscovery after queue
publication failure. A second outbox would duplicate durable intent without resolving attempt
ownership.

### Remove BullMQ

Rejected for now. BullMQ remains useful for worker wake-up, concurrency and operational separation
once its role is limited to transport.

### Stage and atomically swap the complete gateway read model

Deferred. It provides session-wide snapshot isolation but duplicates large member datasets and
adds publication and cleanup complexity. Epoch fencing supplies the required stale-write safety at
lower cost while preserving explicitly incremental publication.

## Consequences

Positive consequences:

- Redis loss delays work but cannot decide business retries or ownership;
- stale workers are rejected by SQL predicates rather than timing assumptions;
- multi-worker operation can be supported after the new concurrency tests pass;
- retry state is visible and queryable in one durable system;
- live-send ambiguity remains explicit rather than risking duplicate delivery.

Costs and trade-offs:

- additive migrations are required for lease tokens, retry timing, sync fences and outbound session
  leases;
- repository APIs must carry claim tokens and report lost ownership;
- gateway writes acquire a short shared lock on the per-session fence row;
- outbound-session lease renewal adds short PostgreSQL queries during live processing;
- operational dashboards and alerts must distinguish retryable, exhausted and lost-ownership events.

## Migration and rollout

Implementation is split into reviewable phases:

1. **Implemented:** add database-owned retries and lease-token fencing for webhook, gateway sync,
   campaign preparation and capability refresh;
2. **Implemented:** add session-scoped sync epochs, enforce one running sync per session and fence
   all full-sync domain writes;
3. **Implemented:** add PostgreSQL outbound-session leases, verify independent database connections
   serialize one session, load test 500 sends and remove the Redis outbound lock;
4. **Implemented:** bulk group/member synchronization, validate OpenWA response schemas and bound
   group pagination with duplicate/progress detection;
5. **Implemented:** isolate scheduler tick timing and publish structured timeout, failure, overlap
   and last-success telemetry for operational alerts.

Until the implemented phases pass staging multi-process tests, production must run one scheduler and
one worker. Live sends remain disabled during the migration and staging validation.

The public Runtime contract is not intentionally changed. Every implementation phase must run
contract generation and prove that the committed OpenAPI artifact is unchanged. Any actual contract
delta requires a new coordinated WA Studio review and release record.

## Required verification

At minimum, automated tests must cover:

- a stale webhook attempt cannot complete or fail a newer attempt;
- a stale sync attempt cannot update its run or write groups/members after an epoch advance;
- two sync requests for the same session cannot both become `RUNNING`;
- Redis loss during database backoff does not lose retryable work;
- campaign preparation reaches a bounded terminal failure without relying on a Bull event listener;
- session-lease loss before an upstream send prevents the send;
- an ambiguous post-request failure remains `UNKNOWN` and is not retried;
- multiple worker replicas serialize one session while allowing different sessions to progress;
- repeated or malformed OpenWA pagination fails within a bounded number of requests;
- generated OpenAPI is unchanged.
