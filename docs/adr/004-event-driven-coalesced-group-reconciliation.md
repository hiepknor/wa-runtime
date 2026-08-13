# ADR 004: Event-driven and coalesced group reconciliation

- Status: Accepted
- Date: 2026-08-13
- Builds on: ADR 001 and ADR 003

## Context

ADR 003 makes full and incremental group reconciliation durable, paced and recoverable. It still
uses periodic PostgreSQL scans to wake the Redis transport, and a burst of OpenWA group events can
invalidate the same group repeatedly before Runtime reads its latest authoritative detail. Fixed
per-session pacing also leaves throughput unused when upstream is healthy and reacts too slowly to
explicit rate pressure.

The optimization target is the number of authoritative `getGroup` reads, not queue throughput.
OpenWA webhooks can be delayed, duplicated or absent, so they cannot replace periodic discovery or
be treated as authoritative group snapshots.

## Decision

1. PostgreSQL remains the durable source of truth. Redis/BullMQ remains a disposable transport.
2. Targeted work is stored separately from `gateway_sync_items`, because those items are owned by a
   particular `sync_run`. At most one logical intent exists for each `(session_id, group_id)`.
3. An intent has monotonically increasing requested and completed revisions. An event arriving
   while revision N is running advances the requested revision; completing N returns the intent to
   pending instead of losing the newer event.
4. Group events are persisted, invalidate the read model and upsert their targeted intent in one
   PostgreSQL transaction. Duplicate webhook event IDs do not advance the intent revision.
5. Event bursts are debounced, with a bounded maximum wait. Reasons are coalesced without retaining
   webhook payloads in the intent.
6. Targeted reconciliation uses the same OpenWA read, session pacing, retry classification,
   capability evaluation, member fingerprinting and fenced write path as sync-run and capability
   reconciliation.
7. PostgreSQL `NOTIFY` is only a fast wake-up hint. Workers always query durable rows, polling is
   retained as the recovery fallback, and reconnect performs an immediate catch-up scan.
8. Notifications contain only a fixed work kind, never session, group, member or search data.
9. Per-session pacing state stays durable in PostgreSQL. Adaptive pacing is additive-increase and
   multiplicative-decrease, bounded by configured minimum and maximum rates, and protected by a
   kill switch that restores fixed-rate behavior.
10. A 429 reduces the effective rate. Network and upstream 5xx failures may create cooldown but do
    not reduce the rate as aggressively. Validation, ordinary 4xx and persistence failures do not
    create upstream cooldown.
11. Webhook-targeted reconciliation is the fast path, incremental discovery is the missed-event
    repair path, and full sync remains onboarding/operator/incident work.

Targeted intents reference a session but not a group row: a valid group event may arrive before the
first discovery has created that group. Session allowlisting is still enforced before upstream
reads, and a 404 follows the existing non-destructive missing-group behavior until an authoritative
discovery snapshot confirms removal.

## Consequences

- Event bursts converge to one authoritative read in the common case.
- Webhook-to-fresh latency no longer depends on the polling interval while PostgreSQL notifications
  are available.
- Losing Redis, a notification or a listener connection does not lose durable work.
- Runtime owns additional PostgreSQL state and a long-lived listener connection.
- Full/incremental and targeted work can coexist without sharing lifecycle rows, but their execution
  policy must remain shared to prevent semantic drift.
- PostgreSQL notification queue depth and dispatcher scan load become operational signals.

## Rollout

1. Emit baseline reconciliation source, duration, queue-age, coalescing and rate-pressure signals.
2. Create and populate durable intents without dispatching them; compare against observed webhooks.
3. Enable targeted dispatch for an allowlisted staging session.
4. Enable notification wake-up while retaining the polling fallback.
5. Enable adaptive pacing behind `GATEWAY_SYNC_ADAPTIVE_PACING` after 24–72 hours of fixed-rate
   staging evidence.
6. Expand session scope only after restart, Redis-loss, listener-loss, burst and 429 smoke tests.

Each behavior has an independent configuration switch or can be disabled by stopping its producer;
the durable rows remain safe for a forward fix. Applied migrations are not rolled back in place.

## Acceptance gates

- Twenty identical group events inside the debounce window cause one common-case `getGroup` read.
- An event arriving during a running intent schedules a subsequent revision.
- Duplicate webhook delivery does not advance an intent.
- Notify-to-dispatch p95 is below one second when idle, while listener loss still dispatches through
  polling.
- Worker or Redis restart does not lose or duplicate logical completion.
- A throttled session does not block another session.
- Sustained 429 bursts stop, and the effective rate survives process restarts.
- Incremental discovery continues to repair missed webhook events.
- Logs and notifications contain no raw group or member identity beyond existing correlation policy.

