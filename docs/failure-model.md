# Failure model

PostgreSQL owns durable intent and business state. BullMQ is a transport optimization: deleting or
restarting Redis may delay work, but every non-terminal durable row must remain discoverable by the
scheduler.

## Processing guarantees

Idempotent work such as webhook normalization, synchronization, capability refresh and campaign
preparation is processed at least once. Repositories use unique constraints, revision checks and
leases so replay is safe.

Message delivery cannot be exactly once because the pinned OpenWA send endpoint does not accept a
Runtime request identifier. A live job is therefore attempted once. If the worker loses its lease
after entering `PROCESSING`, the Runtime records `UNKNOWN` and never schedules an automatic resend.
An operator must resolve that ambiguity or create a new intent.

Workers serialize outbound work with a token-owned Redis lock per session. A waiting worker refreshes
its PostgreSQL processing lease, and only the token owner may release the lock. Lock loss cannot make
an unproven OpenWA result safe to retry, so post-request transport failures still become `UNKNOWN`.

## Durable dispatch

The scheduler rediscovers work from these PostgreSQL rows:

| Work | Dispatchable state | Expired lease behavior |
| --- | --- | --- |
| Webhook | `PENDING`, `RETRY` | Return to `RETRY`; eventually `DEAD` after bounded attempts. |
| Message job | Due `SCHEDULED` | `QUEUED` returns to `SCHEDULED`; `PROCESSING` becomes `UNKNOWN`. |
| Gateway sync | `PENDING` | `RUNNING` returns to `PENDING`. |
| Campaign preparation | `PREPARING` | Re-enqueued with a stable BullMQ job ID. |
| Campaign delivery | `PENDING` in a running run | Materialized from the durable delivery row. |

Queue job IDs are hashes of durable identities. They prevent concurrent duplicate publication but
are not treated as permanent idempotency records; terminal truth remains in PostgreSQL.

## Failure isolation

The scheduler runs message, webhook, gateway and campaign ticks independently. Failure in one tick
is logged and does not prevent later ticks from running. BullMQ workers install error listeners, and
feature processors—not executable entrypoints—own state transitions and side effects.

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
