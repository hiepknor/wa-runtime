# Durable execution local acceptance — 2026-08-12

## Scope

This run verified ADR 001 phases 1–3 in the Docker Compose environment after rebuilding the Runtime
images and applying migrations 011–013. It used one allowlisted development session and local
PostgreSQL, Redis and OpenWA services. This is not a production or independently operated staging
approval.

Safety conditions:

- `ALLOW_LIVE_SENDS=false` remained active;
- readiness reported `liveSendsEnabled=false`;
- one API, scheduler and worker replica were deployed;
- the live-path load test used fake OpenWA only.

## Deployment evidence

| Check | Result |
| --- | --- |
| `docker compose up --build -d` | API, scheduler, worker, PostgreSQL and Redis healthy. |
| Migration 011 | Applied PostgreSQL-owned retries and attempt leases. |
| Migration 012 | Applied session sync epochs and one-running-sync invariant. |
| Migration 013 | Applied PostgreSQL outbound-session leases. |
| Readiness | HTTP 200; PostgreSQL, Redis, worker and scheduler ready. |
| Runtime process logs | No error or fatal entries after deployment. |

## Functional evidence

| Scenario | Result |
| --- | --- |
| Full Gateway sync | Run `dd4d7463-5ecf-443e-9b18-52023f13c721` completed; 8 groups and 16 members synchronized. |
| Post-hardening compatibility sync | Run `851e447f-f873-4bf2-a32e-0c3713785806` completed against pinned OpenWA; 8 groups and 16 members passed runtime validation. |
| Group detail contract | Response did not contain embedded `members`. |
| Member page contract | `limit=1` returned one record with a filtered-dataset `meta.total` of 2. |
| Unit suite | 15 files and 44 tests passed. |
| Integration suite | 11 files and 44 tests passed. |
| Sync epoch | Concurrent same-session claims produced one running run; superseded writes were rejected. |
| PostgreSQL session lease | Independent database connections serialized one session and allowed different sessions concurrently. |
| Lease takeover | Stale renew and release operations were rejected after expiry takeover. |
| Live-path isolation | 500 fake-OpenWA sends produced 500 accepted jobs, no duplicates and maximum concurrency 1 for one session. |
| OpenAPI contract | Regeneration produced no committed contract diff. |
| OpenWA boundary | Malformed payloads, duplicate participants, repeated group pages and oversized pages were rejected without exposing payload data. |
| Bulk synchronization | A 1,000-summary page used one upsert; a 3,000-member group persisted successfully with one member insert statement. |
| Scheduler isolation | Independent tick tests covered success, overlap rejection, timeout fencing, exponential backoff, cross-tick progress, telemetry failure and graceful shutdown. |
| Scheduler telemetry | Five Redis state keys were present after redeploy; every tick reported `running=false`, `timedOut=false`, zero consecutive failures and a recent success. |

## Gate status

Local implementation verification is **PASS**. The production rollout gate remains **PENDING**
until the same lease and recovery scenarios pass on coordinated staging with separate worker
processes, production-like database latency and live sends still disabled.
