# ADR 012: Conservative outbound outcomes, event-time ownership and bounded storage

- Status: Accepted
- Date: 2026-08-16
- Applies to: outbound messages, session webhook projections and operational data retention

## Context

WA Runtime cannot provide exactly-once delivery because OpenWA does not accept a Runtime-owned
idempotency token for a send. An HTTP response can also be lost after OpenWA or WhatsApp accepted a
message. Treating every OpenWA HTTP error as a proven failure makes an operator retry capable of
sending the same message twice.

Session webhooks are durable and retryable, but delivery and processing order is not event order.
Using `GREATEST(gateway_updated_at, occurred_at)` while updating status or restriction
unconditionally allows an older event to regress the projected session state.

Finally, one bounded delete batch per hour cannot keep pace with the measured staging event rate.
Raw webhook envelopes, normalized events and terminal operational/idempotency records also have
different audit value and do not need one shared lifetime.

## Decision

1. Once an outbound POST starts, only an explicit HTTP 4xx response other than 408 is a definitive
   rejection. HTTP 408, HTTP 5xx, transport failures and invalid success responses are ambiguous and
   become `UNKNOWN`. Work that fails before dispatch starts remains `FAILED`.
2. `UNKNOWN` is terminal for automatic processing. It requires operator reconciliation; Runtime
   never automatically retries it.
3. Session status and restriction have independent observation timestamps. A webhook may update its
   projection only when its `occurredAt` is strictly newer. For equal timestamps the first accepted
   observation owns the value; event replay remains idempotent through `runtime_events.event_id`.
4. A session snapshot from OpenWA obeys the same field-level observation fences. It may refresh
   other session metadata without regressing a newer status or restriction observation.
5. Retention uses separate lifetimes:
   - terminal operational/idempotency records: `RUNTIME_RETENTION_DAYS`;
   - normalized runtime events and delivery projections: `RUNTIME_EVENT_RETENTION_DAYS`;
   - inbox message bodies: `RUNTIME_INBOX_RETENTION_DAYS`, defaulting to the event lifetime when
     omitted for backward compatibility;
   - raw OpenWA webhook envelopes: `RUNTIME_RAW_WEBHOOK_RETENTION_DAYS`.
6. Each retention tick drains multiple batches in independent transactions, bounded by both a batch
   count and wall-clock budget. A saturated run is reported as `capacityExhausted`; active work is
   never a candidate.
7. Table partitioning is not introduced in this change. It becomes the next storage migration when
   delete throughput, vacuum cost or projected disk headroom fails the operational thresholds below.
8. Snapshot-backed Contact observations follow snapshot-generation ownership. Message push-name
   observations are compacted only when older than their dedicated retention, a newer observation
   for the same session-scoped identity exists, and no resolution/projection work for that session is
   active. The newest observation is retained indefinitely; snapshot/contact-name provenance is not
   handled by generic retention.
9. `inbound_messages.body` is the sole durable owner of an accepted inbound message body. The
   `message.received` runtime ledger stores a versioned compact payload with identifiers, body byte
   length and SHA-256, but not the body itself. Existing rows are not rewritten.
10. Webhook processing has one fenced database commit point: the normalized event and its core
    projections, outbound status reconciliation, any durable Contact observation intent, and the
    terminal webhook state commit or roll back together. A duplicate normalized event does not skip
    the remaining idempotent reconciliation steps.
11. A successfully processed raw webhook payload is replaced in that same terminal update by a
    compact receipt when the rollout flag is enabled. `PENDING`, `PROCESSING`, `RETRY` and `DEAD`
    rows retain the complete envelope so recovery and operator diagnosis do not depend on an
    already-compacted payload.
12. `webhook_events`, `runtime_events` and `inbound_messages` use table-local five-percent vacuum and
    two-percent analyze scale factors, each with a 10,000-row floor. Compact updates and retention
    deletes must not wait for PostgreSQL's cluster-wide 20-percent default. Global autovacuum cost,
    worker and timing settings remain unchanged until staging evidence proves they are insufficient.

## Operational thresholds

- Alert when retention reports `capacityExhausted` on two consecutive ticks.
- Alert on disk utilization at 70%, escalate at 80%, and stop optional ingestion/remediate at 90%.
- Compare daily inserted and deleted rows for raw webhooks, runtime events and inbound messages.
  Deletion capacity after a cutoff becomes active must exceed the corresponding ingest rate.
- Introduce time partitioning before sustained cleanup consumes 25% of the retention tick budget or
  vacuum cannot maintain reusable space with at least 30 days of projected disk headroom.
- Review the table-local autovacuum thresholds if vacuum runs create sustained I/O pressure or dead
  tuples remain materially above their configured trigger; do not disable autovacuum to suppress
  the symptom.

## Consequences

- Runtime favors duplicate-send prevention over claiming a failure it cannot prove.
- Session projections no longer regress under delayed webhook delivery or an older OpenWA snapshot.
- Raw payload exposure and disk cost are lower than normalized business-history retention.
- Message bodies have one durable owner; the ledger retains integrity metadata but cannot rebuild an
  expired inbox body by design.
- Cleanup can catch up after a cutoff without one long-running transaction, while still producing
  WAL and vacuum work that operators must monitor.
- Event/inbox history beyond its configured lifetime is intentionally unavailable. Backups have an
  independent policy.

## Required verification

- HTTP 403/404 after dispatch remain `FAILED`; HTTP 408/5xx and transport loss become `UNKNOWN`;
- no ambiguous outcome is automatically rescheduled;
- older and equal-timestamp session events cannot overwrite an accepted newer/first observation;
- an older session snapshot cannot regress webhook-owned status or restriction;
- retention drains more than one batch, stops at its bounds and never deletes active rows;
- raw, normalized and operational cutoffs are tested independently;
- staging records deletion throughput, tick duration, `capacityExhausted` and disk headroom before
  changing production retention values.
- migration verification confirms the three high-churn tables retain their reviewed table-local
  autovacuum options.
