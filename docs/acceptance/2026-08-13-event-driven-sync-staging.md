# Event-driven group reconciliation staging acceptance — 2026-08-13

## Scope and revisions

- ADR and implementation range: `818b779..a013d8b`.
- Final staging revision and immutable image: `a013d8b` / `wa-runtime:a013d8b`.
- Staging origin: `https://wa-runtime-staging.onio.cc`.
- Previous Runtime image: `wa-runtime:64f2581`.
- Live sends remained disabled.
- Targeted reconciliation and PostgreSQL notification wake-up are enabled.
- Adaptive pacing remains disabled pending the required fixed-rate observation window.

## Backup and migration

Before migration, readiness was `ready`, the root filesystem had 28 GB free, and PostgreSQL held
1,156 group rows and 535,495 member rows.

- Backup: `/var/backups/wa-runtime/pre-f4679b0-20260813T135037Z.dump`.
- Backup SHA-256: `282f81c913b599a7aa044e57e0e798db152bed7ee441297c5d54e2cb44f4ec2c`.
- The PostgreSQL 17 `pg_restore --list` check passed. The older host `pg_restore` cannot read custom
  archive version 1.16 and must not be used to judge or restore this artifact.
- Migrations `016_group_reconciliation_correctness.sql` and
  `017_event_driven_group_reconciliation.sql` applied successfully.
- Group and member counts remained 1,156 and 535,495 after migration.

## Staged rollout results

The release was first deployed with targeted dispatch, notification wake-up and adaptive pacing
disabled. A signed group-update smoke webhook created a durable `PENDING` intent. It remained
unclaimed for longer than the polling interval, demonstrating that the targeted-dispatch kill
switch works.

Targeted dispatch was then enabled while notification wake-up remained disabled. The shadow intent
advanced `PENDING -> RUNNING -> COMPLETED`, with one attempt and matching requested/completed
revisions. Notification wake-up was enabled only after this polling-path check passed.

| Check | Evidence | Result |
| --- | --- | --- |
| Twenty-event burst | Requested revision advanced by 20, `coalesced_count=19`, one attempt, terminal `COMPLETED` | PASS |
| Duplicate delivery | First request reported `duplicate=false`; replay reported `duplicate=true` and did not advance revision | PASS |
| Polling fallback | With notification wake-up disabled, the intent completed in about 7.2 seconds with a 10-second poll interval | PASS |
| Notification fast wake | Twenty identity-free samples ranged from 136–302 ms; nearest-rank p95 was 278 ms | PASS |
| Listener loss | Terminating only the dedicated LISTEN backend changed PID and reconnected in about 520 ms | PASS |
| Redis and worker restart | A durable webhook survived Redis/worker unavailability and converged to revision 24 in one intent attempt | PASS |
| Redis error handling | After the follow-up fix, a Redis restart produced zero `Unhandled error event` lines and only structured `redis.connection.error` warnings | PASS |
| Data and readiness | API, worker and scheduler healthy; HTTPS readiness `ready`; OpenWA `0.16.0`; live sends disabled | PASS |

The final database state had one completed targeted intent, no active pacing lease, zero consecutive
rate-pressure failures and 24 processed synthetic smoke webhooks. Synthetic webhook identifiers do
not contain session, group or member identities.

## Automated verification

- `npm run check:all`: 55 unit tests and 83 integration tests passed on the final revision.
- Runtime OpenAPI regeneration produced no diff because this change does not alter the public API.
- `git diff --check` passed.
- The local worktree was clean before deployment.

## Remaining gates

The staging gate is **PENDING**, not PASS. The following ADR 004 evidence still requires an
observation window or an additional isolated staging fixture:

- observe fixed-rate targeted reconciliation for 24–72 hours before enabling adaptive pacing;
- exercise sustained upstream 429 responses and verify persisted multiplicative decrease and
  recovery without generating avoidable load against production OpenWA;
- verify that throttling one session does not delay another session; the deployment currently has
  only one allowlisted session;
- exercise an event arriving during a genuinely running upstream read on staging. Revision fencing
  is covered by database integration tests but was not forced against the production-backed
  staging session;
- confirm routine incremental discovery repairs an intentionally missed webhook during the
  observation window.

Do not enable `GATEWAY_SYNC_ADAPTIVE_PACING` or expand production scope until these remaining gates
are recorded. Targeted dispatch and notification wake-up can be disabled independently without
removing durable intent rows.
