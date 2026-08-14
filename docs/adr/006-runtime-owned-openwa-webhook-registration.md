# ADR 006: Runtime-owned OpenWA webhook registration

- Status: Accepted
- Date: 2026-08-14
- Builds on: ADR 001 and ADR 004

## Context

WA Runtime consumes signed OpenWA webhooks for delivery state, session restrictions, targeted group
reconciliation and observed-contact enrichment. The callback registration currently lives only in
OpenWA and is created manually. During the observed-contacts staging rollout, both deployments were
healthy while the allowlisted OpenWA session had no callback registrations. Inbound messages were
therefore invisible to Runtime until an operator recreated the callback.

Webhook delivery is not authoritative and periodic discovery still repairs missed group events, but
the absence of a callback silently disables every event-driven path. Readiness cannot treat one
transient OpenWA control-plane failure as an API outage, and a health probe must not mutate upstream
state. Runtime needs a bounded, observable reconciliation owner instead.

## Decision

1. WA Runtime owns one configured OpenWA callback URL for every allowlisted session. It manages only
   registrations whose normalized URL exactly equals that configured URL and never changes callbacks
   for another URL.
2. Reconciliation runs as an isolated scheduler tick, not in readiness and not on the member/message
   request path. It is disabled by default and requires an explicit callback URL.
3. The desired event set is code-owned and contains only events Runtime currently normalizes:
   message received/sent/ack/failed, session status/restriction and group join/leave/update.
4. Each pass lists registrations per allowlisted session. If none targets the managed URL, Runtime
   creates one. Otherwise it deterministically keeps the lowest webhook ID, updates it with the
   desired URL, event set, active state, retry count and current signing secret, then removes only
   duplicate registrations for the same managed URL.
5. Updating the retained registration every pass is intentional. OpenWA does not return the signing
   secret, so comparison cannot detect a stale secret after rotation. The idempotent control-plane
   write makes Runtime authoritative without persisting a secret fingerprint.
6. Sessions are reconciled sequentially and failures are isolated. Logs contain aggregate counts and
   error classes, never session IDs, webhook IDs, callback URLs, secrets or payloads.
7. The current deployment contract permits exactly one scheduler. This is the reconciliation-owner
   fence for the initial rollout. Multiple scheduler replicas remain unsupported until a separately
   reviewed distributed lease is added; callback delivery idempotency is not a substitute for
   control-plane fencing.
8. OpenWA destination policy is authoritative. Staging and production use the externally reachable
   TLS Runtime callback URL; Runtime does not weaken upstream SSRF policy to allow Docker-internal
   names.
9. Failure to reconcile is operational degradation, not a reason to fail API readiness or stop
   unrelated scheduler ticks. The isolated tick reports failure/backoff while the previous upstream
   registration, if any, remains active.

## Consequences

- OpenWA recreation, re-pairing and signing-secret rotation converge without manual callback setup.
- A missing callback is repaired on scheduler start or the next configured interval.
- Reconciliation adds at most one list and one bounded mutation per allowlisted session per pass,
  plus deletion of same-URL duplicates.
- Runtime intentionally owns destructive cleanup only inside the exact configured callback URL
  boundary. Other OpenWA consumers are unaffected.
- A bad callback URL or insufficient OpenWA key permission produces repeated, observable scheduler
  degradation until configuration is fixed.
- Runtime public API and OpenAPI contracts do not change.

## Rollout

1. Deploy adapter, reconciler and scheduler wiring with reconciliation disabled.
2. Configure the existing staging HTTPS callback URL and keep the current manual registration.
3. Enable reconciliation and verify the first tick updates rather than duplicates the registration.
4. Delete the managed staging registration through the OpenWA operator API and verify one tick
   recreates exactly one callback; restore testing must use a controlled window.
5. Send a controlled inbound message and require processed delivery with no retry/dead transition.
6. Observe at least one interval and an OpenWA restart before production enablement.

## Acceptance gates

- Disabled mode performs no OpenWA calls.
- Missing state creates exactly one desired registration.
- Existing state is updated with the current secret and exact event set without duplication.
- Same-URL duplicates converge to one deterministic registration; unrelated URLs remain untouched.
- One session failure does not prevent another allowlisted session from converging.
- Logs and metrics contain no session, URL, webhook ID, secret or payload.
- API readiness remains read-only and independent of reconciliation success.
- Existing webhook processing, group sync, contact enrichment and OpenWA adapter tests continue to
  pass.
