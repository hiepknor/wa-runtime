# OpenWA webhook registration reconciliation — staging, 2026-08-14

## Scope

- Runtime implementation: `ccf01d0`.
- Design decision: `e9b4f04` ([ADR 006](../adr/006-runtime-owned-openwa-webhook-registration.md)).
- Runtime endpoint: `https://wa-runtime-staging.onio.cc`.
- OpenWA release: `0.16.0`.
- One allowlisted session was exercised without recording its identifier, callback registration ID
  or payload data.
- Live sends remained disabled.

## Disabled rollout gate

The immutable image was deployed before adding the new settings. With
`OPENWA_WEBHOOK_RECONCILIATION_ENABLED` unset, the initial scheduler tick made zero OpenWA webhook
list or mutation calls. The existing registration remained one active callback, and API, worker and
scheduler became healthy with zero restarts.

## Enabled reconciliation

The reviewed external HTTPS callback and five-minute interval were then configured, and only the
scheduler was recreated. The first two reconciliation passes both reported:

| Metric | Tick 1 | Tick 2 |
| --- | ---: | ---: |
| Sessions | 1 | 1 |
| Failed | 0 | 0 |
| Created | 0 | 0 |
| Updated | 1 | 1 |
| Deleted | 0 | 0 |

This proves that an existing managed callback is retained and refreshed rather than duplicated. At
the end of the observation window OpenWA reported exactly one active managed registration with the
nine reviewed Runtime events and retry count three.

Refreshing the callback signing secret did not interrupt delivery. During the rollout window, 912
`message.received` webhook events reached Runtime and all 912 reached `PROCESSED`; no retry/dead
state, scheduler error, process restart or readiness degradation was observed.

## Verification

- `npm run check`: 25 unit files and 73 tests passed; typecheck and production build passed.
- `npm run test:integration`: 13 files and 91 tests passed.
- `npm run contract:check`: passed with no Runtime OpenAPI diff.
- `git diff --check`: passed.
- Unit coverage proves disabled behavior, missing-state creation, deterministic same-URL duplicate
  cleanup, unrelated-URL isolation, secret/event refresh and per-session failure isolation without
  logging session IDs or URLs.

## Deferred destructive smoke

The allowlisted session belongs to the active OpenWA production deployment and was receiving live
inbound traffic. The rollout therefore did not delete its only callback merely to demonstrate
missing-state repair, and did not manufacture a duplicate callback. Those transitions are covered
by isolated tests but still require a controlled maintenance window before production approval.

An OpenWA restart with the retained registration should also be observed. Runtime currently relies
on the documented single-scheduler invariant; multiple scheduler replicas remain out of scope until
distributed reconciliation ownership is designed.

## Gate

Disabled rollout, steady-state update, inbound continuity and non-duplication: **PASS**.

Missing-state repair against a real OpenWA instance and restart persistence: **PENDING CONTROLLED
WINDOW**.
