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
   - normalized runtime events and their inbox/delivery projections:
     `RUNTIME_EVENT_RETENTION_DAYS`;
   - raw OpenWA webhook envelopes: `RUNTIME_RAW_WEBHOOK_RETENTION_DAYS`.
6. Each retention tick drains multiple batches in independent transactions, bounded by both a batch
   count and wall-clock budget. A saturated run is reported as `capacityExhausted`; active work is
   never a candidate.
7. Table partitioning is not introduced in this change. It becomes the next storage migration when
   delete throughput, vacuum cost or projected disk headroom fails the operational thresholds below.
8. Contact observations are not compacted by generic retention. They are provenance inputs to
   versioned resolution. A later Contacts-specific compactor must first preserve winning observation
   references and prove time-cutoff reconstruction equivalence.

## Operational thresholds

- Alert when retention reports `capacityExhausted` on two consecutive ticks.
- Alert on disk utilization at 70%, escalate at 80%, and stop optional ingestion/remediate at 90%.
- Compare daily inserted and deleted rows for raw webhooks, runtime events and inbound messages.
  Deletion capacity after a cutoff becomes active must exceed the corresponding ingest rate.
- Introduce time partitioning before sustained cleanup consumes 25% of the retention tick budget or
  vacuum cannot maintain reusable space with at least 30 days of projected disk headroom.

## Consequences

- Runtime favors duplicate-send prevention over claiming a failure it cannot prove.
- Session projections no longer regress under delayed webhook delivery or an older OpenWA snapshot.
- Raw payload exposure and disk cost are lower than normalized business-history retention.
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
