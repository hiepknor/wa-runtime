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
| `scheduler` | Claims due work, recovers stale queue state, activates/reconciles runs and cleans terminal history | PostgreSQL and BullMQ |
| `worker` | Processes sends, syncs, campaign preparation and webhooks | PostgreSQL through repositories |
| `migrate` | Applies ordered SQL migrations once | `schema_migrations` and schema |

The API can restart without losing campaign work. The scheduler reconstructs pending work from
PostgreSQL, and BullMQ job IDs make re-enqueueing safe.

The accepted target execution model is defined by
[ADR 001](adr/001-postgresql-owned-durable-work-execution.md). Its implementation is in progress.
Database-owned retry, lease-token fencing, session sync epochs and PostgreSQL outbound-session
leases are implemented. Production remains restricted to one scheduler and one worker until the
multi-process staging gate passes.

## Infrastructure responsibilities

### PostgreSQL

PostgreSQL is the source of truth. It stores:

- message jobs and attempts;
- raw webhook envelopes and normalized runtime events;
- gateway sessions, groups, members and inbound group messages;
- sync runs and group capabilities;
- campaigns, target selections, immutable run snapshots and per-group deliveries.

Business state is committed before queue work is published. If Redis is unavailable after a commit,
the scheduler retries publication from the durable row. Webhooks, message jobs and sync runs use
leases so crashed work is recovered according to its side-effect semantics.

Under the accepted execution model, PostgreSQL also owns retry timing, retry exhaustion and attempt
ownership. Retryable attempts receive database lease tokens, and a stale token cannot renew,
complete or fail its durable attempt. Capability-refresh writes are also token-guarded. Full-sync
group/member writes are protected by a session-scoped epoch and database ownership checks. BullMQ
does not own business retries.

### Redis and BullMQ

Redis is transport and short-lived cache, not the business source of truth. Four queues exist:

- `message-send`;
- `webhook-ingress`;
- `gateway-sync`;
- `campaign`.

Redis also caches OpenWA session sendability for preflight for 10 seconds. Session-status and
session-restriction webhooks invalidate that cache. Redis is configured with AOF and
`maxmemory-policy=noeviction`. A token-owned PostgreSQL session lease serializes outbound sends, so
Redis remains transport and cache rather than a correctness boundary. Losing Redis does not erase
durable campaign state, but outbound processing pauses until transport is restored.

The scheduler removes terminal operational history older than `RUNTIME_RETENTION_DAYS` in bounded,
indexed batches. Active rows are never retention candidates. Campaign run graphs are removed before
their message jobs, and normalized event children are removed with their parent event. Retention
therefore also defines how long old idempotency keys remain reusable-proof records.

### OpenWA adapter

`src/integrations/openwa/openwa.client.ts` is the anti-corruption layer. Upstream OpenWA payloads
stop there and are mapped into Runtime-owned types. A full sync verifies OpenWA's live release against
`OPENWA_RELEASE_TAG` and fails closed on a mismatch.

Successful OpenWA JSON is runtime-validated before it crosses this boundary. Session, group,
participant, webhook, health and send responses reject malformed shapes without logging raw
payloads. Group pagination accepts at most 100 pages of 1,000 records and rejects oversized pages or
duplicate group IDs. Summary pages and member collections use one bulk statement per transaction
while the sync epoch fence remains held.

## Source layout and dependency direction

```text
src/
  app.module.ts          Nest composition root
  app/                   Worker and scheduler composition roots
  entrypoints/           API, scheduler and worker bootstraps
  contracts/             public request/response DTOs
  core/                  auth, config, database, queue, observability and OpenAPI setup
  integrations/openwa/   upstream anti-corruption adapter
  modules/               campaigns, gateway, health, inbox, messages, webhooks and orchestration
```

Dependencies flow inward from entrypoints and the composition root:

```text
entrypoints -> app.module -> modules -> core / integrations
                         +-> contracts
```

`core` never imports a feature module. OpenWA integration never imports client-facing DTOs or
feature controllers. Feature-to-feature dependencies use exported Nest providers; currently
Campaigns and Webhooks depend on Gateway, while Campaigns also depends on Messages. Public DTOs stay
centralized so all supported clients generate from one contract rather than module-internal types.

Every process writes JSON logs. The API creates or preserves a bounded `X-Request-ID`; BullMQ
workers create correlation context from durable and queue IDs. These identifiers are the supported
way to correlate HTTP, scheduler, worker and OpenWA activity across process logs.

## Main flows

### Gateway synchronization

```text
Client -> POST session sync -> sync_runs(PENDING)
    -> scheduler -> gateway-sync queue -> worker -> OpenWA
    -> gateway_sessions/groups/group_members -> sync_runs(COMPLETED|FAILED)
```

Full sync is asynchronous so hundreds of groups do not hold an HTTP request open. Group details are
used to calculate current send capability. The read model is incrementally published: each group
and member replacement is atomic, but a session-wide sync is not an atomic snapshot. A monotonic
session epoch prevents a recovered or superseded attempt from overwriting a newer attempt.

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
- A live worker acquires the per-session send lease, refreshes its processing lease, waits the
  configured random delay and holds PostgreSQL session ownership through the OpenWA response.
- HTTP 403/404 group-send failures invalidate the affected capability for targeted refresh.
- `UNKNOWN` means the worker cannot prove whether a non-HTTP failure sent the message; it is never
  silently retried as a new send.
- Already processing or accepted work cannot be recalled by cancel. Pending and queued work is
  cancelled durably.

This design prefers visible partial failure over hidden duplication.

The exact retry, lease and ambiguous-delivery rules are documented in
[Failure model](failure-model.md).
