# Failure model

PostgreSQL owns durable intent and business state. BullMQ is a transport optimization: deleting or
restarting Redis may delay work, but every non-terminal durable row must remain discoverable by the
scheduler.

## Implementation status

[ADR 001](adr/001-postgresql-owned-durable-work-execution.md) accepts PostgreSQL-owned retry and
attempt fencing as the target model. Database-owned retry and lease-token fencing are implemented
for webhook processing, gateway synchronization, campaign preparation and capability refresh.
Session-scoped sync epochs now fence full-sync domain writes, and PostgreSQL session leases serialize
outbound sends. Production remains restricted to one scheduler and one worker until the
multi-process staging gate passes.

## Processing guarantees

Idempotent work such as webhook normalization, synchronization, capability refresh and campaign
preparation is processed at least once. In the accepted target model, repositories use unique
constraints, revision checks and token-owned database leases so replay is safe. A stale attempt is
not allowed to renew, complete, fail or mutate guarded domain data.

Message delivery cannot be exactly once because the pinned OpenWA send endpoint does not accept a
Runtime request identifier. A live job is therefore attempted once. If the worker loses its lease
after entering `PROCESSING`, the Runtime records `UNKNOWN` and never schedules an automatic resend.
An operator must resolve that ambiguity or create a new intent.

The implementation serializes outbound work with a token-owned PostgreSQL lease per session. A
waiting worker refreshes its message processing lease, and only the current session-lease owner may
start the OpenWA request or release the lease. Lease loss cannot make an unproven OpenWA result safe
to retry, so post-request transport failures still become `UNKNOWN`.

## Retry and ownership

PostgreSQL is the only retry authority in the accepted model. BullMQ jobs use one transport attempt;
processors persist bounded backoff or terminal exhaustion before the job is removed. A durable
attempt claim returns a random lease token. Renewal and state transitions require both running state
and the current token. A zero-row update means lost ownership, not successful completion or retry
exhaustion.

Gateway synchronization also uses a monotonically increasing epoch per session. At most one run per
session may be `RUNNING`, and every full-sync write verifies its epoch. Group data is incrementally
published; a failed run can leave records with different synchronization timestamps, but an older
attempt cannot write after a newer epoch begins.

## Durable dispatch

The scheduler rediscovers work from these PostgreSQL rows:

| Work | Dispatchable state | Expired lease behavior |
| --- | --- | --- |
| Webhook | `PENDING`, `RETRY` | Return to `RETRY`; eventually `DEAD` after bounded attempts. |
| Message job | Due `SCHEDULED` | `QUEUED` returns to `SCHEDULED`; `PROCESSING` becomes `UNKNOWN`. |
| Gateway sync | Due `PENDING` | Owning attempt returns to delayed `PENDING`; exhaustion becomes `FAILED`. |
| Campaign preparation | Due `PREPARING` | Owning attempt backs off durably; exhaustion becomes `FAILED`. |
| Campaign delivery | `PENDING` in a running run | Materialized from the durable delivery row. |

Queue job IDs are hashes of durable identities. They prevent concurrent duplicate publication but
are not leases, retry records or permanent idempotency keys; terminal truth remains in PostgreSQL.

## Failure isolation

The scheduler isolates failures between message, webhook, gateway and campaign ticks. The accepted
runner model gives each tick an interval, timeout, no-overlap guard and failure backoff. Feature
processors through repositories—not Bull event listeners or executable entrypoints—own state
transitions and side effects.

## Authorization invariant

Every public object access resolves to a session and checks the deployment session scope. Signed
webhooks for sessions outside `OPENWA_ALLOWED_SESSION_IDS` are rejected. Live low-level sends must
target an active synchronized group whose capability is currently `ALLOWED`; the worker repeats the
check immediately before calling OpenWA.

## Idempotency

Message idempotency is scoped. The Runtime stores a canonical request hash with each key. Repeating
the same scope, key and request returns the existing job; reusing the key for a different request is
a conflict. Campaign message jobs use a run-specific scope so client keys cannot collide with
campaign delivery keys. Terminal records are removed by configured retention, so idempotency is
guaranteed only while the original record remains within that retention window.
