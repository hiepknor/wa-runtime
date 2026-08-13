# Group-list search and filter staging acceptance — 2026-08-13

## Scope and revisions

- WA Runtime implementation revision: `4af7bfa` (feature range `e60e145..4af7bfa`).
- Immutable image: `wa-runtime:4af7bfa`.
- Staging origin: `https://wa-runtime-staging.onio.cc`.
- Live sends remained disabled throughout the rollout.
- This API change is additive; the existing WA Studio deployment did not need to change for the
  Runtime-first staging rollout.

## Storage migration

The rollout also completed the storage namespace migration required by ADR 002. API, scheduler and
worker processes were stopped before the baseline and logical backup were taken.

- Source PostgreSQL volume: `wa-runtime_automation-postgres` (retained, stopped).
- Source Redis volume: `wa-runtime_automation-redis` (retained, stopped).
- Target PostgreSQL database and role: `wa_runtime` / `wa_runtime`.
- Target volumes: `wa-runtime_postgres-data` and `wa-runtime_redis-data`.
- Logical backup: `/var/backups/wa-runtime/pre-4af7bfa-20260813T044347Z.dump`.
- Backup SHA-256: `a5f3be3e79ab966ab3a729c86597ae5ebd9ad77e8fc35206bba57f0d7eb0d0bc`.
- `pg_restore --list` passed, and an isolated restore reproduced 582 groups, 267,835 members and
  13 pre-rollout migrations.
- Post-restore migration `014_group_list_search_indexes.sql` completed in two seconds.
- Post-migration counts remained 582 groups and 267,835 members; `schema_migrations` increased from
  13 to 14 as expected.

The source volumes remain the immediate rollback artifact. They must not be removed until the
operator accepts the verified logical backup and the observation window has completed.

## Runtime verification

- API, scheduler, worker, PostgreSQL and Redis reported healthy.
- Public readiness returned `ready`, PostgreSQL/Redis/worker/scheduler true, OpenWA `0.16.0`, two
  allowlisted sessions and `liveSendsEnabled=false`.
- The active release symlink points to `releases/4af7bfa`; all Runtime processes use
  `wa-runtime:4af7bfa`.
- Active PostgreSQL and Redis mounts use only the target volume names. No running container has an
  `automation-runtime`, `automation-postgres` or `automation-redis` mount.
- `pg_trgm` and the name, group-ID and description trigram indexes are present.
- A staging `EXPLAIN (ANALYZE, BUFFERS)` over all three substring predicates completed in about
  2.2 ms on 582 rows. PostgreSQL reasonably chose a sequential scan for this small relation; the
  integration performance fixture separately demonstrated trigram plans at larger cardinality.
- The API, scheduler and worker had no error/fatal/unhandled/exception matches in their rollout log
  window.

## API smoke results

The following checks passed against `staging-session-2`:

- legacy request without new filters, custom limit/offset and filtered `meta.total`;
- exact group-ID, group-name and description search;
- trim, whitespace-only and case-insensitive search behavior;
- ALLOWED, DENIED and UNKNOWN status filters, including comma-separated OR semantics;
- CURRENT and STALE freshness filters;
- active and inactive filters;
- combined status/freshness/active predicates with AND semantics;
- stable repeated ordering and no overlap between adjacent pages;
- offset beyond total returned an empty page while preserving the filtered total;
- invalid enum and boolean values returned HTTP 400;
- missing API key returned HTTP 401;
- a non-allowlisted session and cross-session group lookup returned HTTP 404;
- group detail contained no embedded `members` property;
- member pagination and participant-ID search continued to work;
- capability refresh returned HTTP 202 and subsequently completed with a newer `checkedAt` and a
  cleared `invalidatedAt`.

The staging dataset currently contains 574 active groups for `staging-session-2`: 446 ALLOWED, 128
DENIED and no UNKNOWN records. It contains no inactive or stale records. Empty-result behavior for
UNKNOWN, inactive and stale filters passed on staging; positive fixtures for those branches remain
covered by the database integration suite.

## Status

WA Runtime group-list staging deployment and backend smoke gate: **PASS**.

Before production, WA Studio must regenerate from the deployed OpenAPI contract, implement the new
server-side controls, and pass coordinated UI smoke. Retain the stopped source volumes through the
agreed observation window, then remove them explicitly only after operator acceptance.
