# Architecture

## Purpose and boundary

Automation Runtime is the control plane for group automation. It converts client intent into
durable, observable work while isolating every consumer from OpenWA details.

```text
Desktop / Mobile / Web / integrations
    -> Runtime contract -> Automation Runtime -> OpenWA adapter -> OpenWA Gateway
```

The boundary is intentional:

- Client applications own presentation and platform-specific interaction. WA Studio is the first
  client, not a privileged or hard-coded dependency.
- Automation Runtime owns campaigns, scheduling, idempotency, policy, queues and delivery state.
- OpenWA owns the WhatsApp connection and low-level send/read operations.
- WhatsApp remains the external authority for account, group and message-delivery facts.

Clients must not receive `OPENWA_API_KEY`, call OpenWA endpoints or depend on upstream response
shapes. Contacts are not part of the current product boundary; they can be added later without
changing the group contract.

The current `X-Runtime-Key` mechanism is suitable for development and trusted internal consumers.
It must never be embedded in publicly distributed mobile binaries or browser JavaScript. Before
those clients are introduced, add an identity/access layer (or trusted backend-for-frontend) that
issues short-lived user tokens and enforces tenant, role and action scopes. This authentication
evolution must not change the campaign domain contract.

## Runtime processes

The same image runs three long-lived processes and one one-shot migration process.

| Process | Responsibility | Durable state mutation |
| --- | --- | --- |
| `api` | HTTP API, validation, authentication, webhook ingress | PostgreSQL and queue enqueue |
| `scheduler` | Claims due work, recovers stale queue state, activates and reconciles runs | PostgreSQL and BullMQ |
| `worker` | Processes sends, syncs, campaign preparation and webhooks | PostgreSQL through repositories |
| `migrate` | Applies ordered SQL migrations once | `schema_migrations` and schema |

The API can restart without losing campaign work. The scheduler reconstructs pending work from
PostgreSQL, and BullMQ job IDs make re-enqueueing safe.

## Infrastructure responsibilities

### PostgreSQL

PostgreSQL is the source of truth. It stores:

- message jobs and attempts;
- raw webhook envelopes and normalized runtime events;
- gateway sessions, groups, members and inbound group messages;
- sync runs and group capabilities;
- campaigns, target selections, immutable run snapshots and per-group deliveries.

Business state is committed before queue work is published. If Redis is unavailable after a commit,
the scheduler retries publication from the durable row.

### Redis and BullMQ

Redis is transport and short-lived cache, not the business source of truth. Four queues exist:

- `message-send`;
- `webhook-ingress`;
- `gateway-sync`;
- `campaign`.

Redis also caches OpenWA session sendability for preflight for 10 seconds. Session-status and
session-restriction webhooks invalidate that cache. Redis is configured with AOF and
`maxmemory-policy=noeviction`, but losing the queue does not erase durable campaign state.

### OpenWA adapter

`src/openwa/openwa.client.ts` is the anti-corruption layer. Upstream OpenWA payloads stop there and
are mapped into Runtime-owned types. A full sync verifies OpenWA's live release against
`OPENWA_RELEASE_TAG` and fails closed on a mismatch.

## Main flows

### Gateway synchronization

```text
Client -> POST session sync -> sync_runs(PENDING)
    -> scheduler -> gateway-sync queue -> worker -> OpenWA
    -> gateway_sessions/groups/group_members -> sync_runs(COMPLETED|FAILED)
```

Full sync is asynchronous so hundreds of groups do not hold an HTTP request open. Group details are
used to calculate current send capability.

### OpenWA events

```text
OpenWA -> HMAC webhook -> webhook_events -> webhook-ingress queue
    -> normalized runtime_events
    -> inbound_messages / message_events / gateway state
```

The ingress verifies `X-OpenWA-Signature` over the exact raw body and deduplicates by upstream
idempotency key. The normalized event is versioned independently from OpenWA's event payload.

### Campaign execution

```text
campaign + selected groups
    -> preflight
    -> campaign_run(PREPARING) + immutable target/payload snapshot
    -> campaign worker creates deliveries
    -> scheduler materializes a bounded number of message_jobs
    -> message worker (dry-run or OpenWA)
    -> scheduler reconciles delivery progress and finalizes the run
```

At most five message jobs per running campaign are buffered in `SCHEDULED`, `QUEUED` or
`PROCESSING`. This bounds queue pressure while preserving PostgreSQL as the complete work list.

## Contract ownership

```text
Reviewed OpenWA snapshot
    -> OpenWA adapter
    -> Runtime domain/repositories
    -> Runtime DTOs
    -> generated Runtime OpenAPI
    -> generated clients for each supported platform
```

`src/contracts` is the human-maintained public contract source. The generated
`contracts/runtime/v1/openapi.json` is committed for review but must not be edited manually.
Database rows, BullMQ payloads and raw webhook bodies are internal and may change without exposing
those shapes to consumers.

## Consistency and failure model

- API idempotency prevents duplicate message jobs and campaign runs.
- Campaign payloads and targets are snapshotted at run creation, so later draft edits cannot change
  an existing run.
- A live delivery rechecks the group's capability revision before materialization.
- A live worker checks durable session sendability immediately before its OpenWA call.
- HTTP 403/404 group-send failures invalidate the affected capability for targeted refresh.
- `UNKNOWN` means the worker cannot prove whether a non-HTTP failure sent the message; it is never
  silently retried as a new send.
- Already processing or accepted work cannot be recalled by cancel. Pending and queued work is
  cancelled durably.

This design prefers visible partial failure over hidden duplication.
