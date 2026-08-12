# Multi-process local acceptance — 2026-08-12

## Scope

This run exercised Runtime `e700dbc..0ee62fb` in the local Docker Compose environment with one API,
one scheduler, two independent worker containers, PostgreSQL, Redis and the pinned development
OpenWA service. It extends the earlier single-worker local evidence with process concurrency and
fault recovery. It is not an approval for production or an independently operated staging
environment.

Safety conditions:

- `ALLOW_LIVE_SENDS=false` remained active and readiness reported `liveSendsEnabled=false`;
- all outbound acceptance work used `DRY_RUN`;
- no member values, session IDs, API keys or lease tokens are recorded in this document;
- the group-member API smoke fixture was temporary and removed after the run.

## Multi-process and recovery evidence

| Scenario | Result |
| --- | --- |
| Runtime topology | API, scheduler, PostgreSQL and Redis were healthy; worker replicas 1 and 2 were separate healthy containers. |
| Concurrent same-session sync | Runs `fa406e16-5a44-4ce3-a8e6-98d97fee4ab9` and `6850cfe1-4acd-4fec-a8b6-d2cbb4b50616` completed with epochs 3 and 4, one attempt each, and 8 groups/16 members each. |
| One-running-sync invariant | PostgreSQL partial unique index `idx_sync_runs_one_running_per_session` remained present and enforced the session-scoped running-run invariant. |
| Worker crash and recovery | Run `bb755fb7-085d-41e0-b56c-0a8532419c63` was claimed, its worker was killed, and the other worker reclaimed it as attempt 2 after fault-injected lease expiry. It completed with 8 groups/16 members. |
| Stale-owner fencing | An update using the pre-crash lease token affected zero rows after takeover. The token itself was not logged. |
| Redis unavailable at intent creation | Message job `d51b2e83-5326-4be3-a172-d884d768919b` was durably created in PostgreSQL as `SCHEDULED`, `dry_run=true`, attempt 0 while Redis was stopped. |
| Redis restart and rediscovery | The same job became `DRY_RUN_COMPLETED`, attempt 1 after Redis restarted, without API resubmission. |
| Two-worker dry-run load | 500 targets completed in 104,354 ms (4.79/s); 500 deliveries, 500 distinct message jobs and 500 attempts were recorded with zero duplicate attempts. |
| Bounded dispatch buffer | The 500-target load observed at most five message jobs in `SCHEDULED`, `QUEUED` or `PROCESSING`, matching the configured invariant. |
| Scheduler recovery telemetry | Message, webhook, gateway, campaign and retention ticks all reported a recent success, `consecutiveFailures=0` and `timedOut=false` after Redis recovery. |

The worker-crash test expired the claimed lease explicitly in PostgreSQL instead of waiting for the
full two-minute TTL. This verifies takeover and stale-owner fencing, but staging should also observe
natural lease expiry under production-like timing.

## Group-member contract smoke evidence

A temporary 16-member synchronized group exercised the Runtime HTTP API. It included super-admin,
admin and ordinary members, three duplicate display names and a null display name.

| Scenario | Result |
| --- | --- |
| Metadata detail | Group detail was 492 bytes and did not contain `members`. |
| Four-page traversal | Four pages at `limit=5` returned all 16 unique records with no duplicate or omission on an unchanged snapshot. |
| Stable ordering | API order matched the documented SQL order for super-admin, admin, normalized display name and participant-ID tie-breaker. |
| Server-side search | Display name, phone number and participant ID queries each found synchronized records. |
| Empty semantics | Whitespace query was unfiltered; an unmatched query and an empty member dataset returned HTTP 200 with empty data and correct totals. |
| Data-change pagination | Offset 15 returned one row before the fixture shrank, then a valid empty page with filtered total 4. |
| Isolation | A missing group and a group request under a non-allowlisted session both returned HTTP 404. |
| Capability refresh | Refresh returned HTTP 202; group detail remained metadata-only and members remained available only through the paged endpoint. |

The WA Studio page-clamp and browser request-count behavior cannot be proven from the Runtime-only
local smoke. Those checks remain part of the coordinated staging gate.

## Commands

- `docker compose up -d --scale worker=2 worker`
- authenticated Runtime API calls for sync, message-job and group-member scenarios
- PostgreSQL state and lease-fencing assertions through `psql`
- `docker compose stop redis` followed by `docker compose start redis`
- `LOAD_TEST_TARGET_COUNT=500 npm run load-test:dry-run` with host PostgreSQL, Redis and API URLs
- Redis scheduler-tick state inspection for all five isolated ticks
- `docker compose ps` and `/api/v1/health/ready`
- `npm run check` — typecheck and build passed; 15 unit files and 44 tests passed
- `npm run test:integration` — 11 integration files and 44 tests passed
- `npm run contract:check` with the local service URLs — regeneration passed with no OpenAPI diff;
  SHA-256 remained `753f08cb6e7068b8d1c3715142337e8d89db154c9c5b97c92cc20556843b45df`

## Gate status

Local multi-process implementation verification is **PASS**. The coordinated group-member staging
gate and production rollout gate remain **PENDING**. Before changing either gate to PASS:

1. deploy immutable Runtime and WA Studio revisions together on the actual staging environment;
2. repeat the documented group-member browser smoke, including page clamping and request counts;
3. repeat worker recovery using natural lease expiry and production-like latency;
4. retain `ALLOW_LIVE_SENDS=false` unless a separately approved live-send canary is scheduled.
