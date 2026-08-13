# ADR 002: Rename Automation Runtime to WA Runtime

- Status: Accepted
- Date: 2026-08-12
- Amended: 2026-08-13 — establish a fully normalized target namespace and bounded compatibility exit
- Completed: 2026-08-13 — compatibility exit criteria accepted; legacy runtime identifiers removed
- Owners: WA Runtime maintainers

## Context

The product boundary is now intentionally:

```text
WA Studio -> WA Runtime -> OpenWA
```

`Automation Runtime` described the implementation but obscured its place in this product stack.
`WA Runtime` names the durable control plane paired with WA Studio while keeping OpenWA isolated as
the WhatsApp gateway integration.

A repository rename touches identifiers with different compatibility properties. Display names,
package metadata, image names, health metadata and log labels are safe to change together. Database
names, Docker volumes, Redis keys and public API paths may be referenced by running processes or
deployment automation and cannot all be replaced atomically without risking state loss or a rolling
deployment outage. That operational risk requires an explicit migration, not permanent legacy
naming. The target state is a clean `wa-runtime` namespace for every identifier owned by this
repository.

## Decision

The product and repository are named **WA Runtime** and `wa-runtime` respectively.

The architecture boundary is:

- WA Studio owns desktop presentation and operator interaction;
- WA Runtime owns the stable API, authorization, durable intent, scheduling, retry, policy and read
  models;
- OpenWA owns WhatsApp sessions and direct gateway communication.

This rename does not change API semantics. `/api/v1`, DTO names, database tables and applied SQL
migrations remain stable. The OpenAPI title and examples may use the new product name; that metadata
change must still be regenerated and synchronized to WA Studio.

## Identifier migration

| Identifier | Decision |
| --- | --- |
| Product, npm package, health service and structured-log service | Rename to `WA Runtime` or `wa-runtime`. |
| Container image | Publish as `wa-runtime`; Compose accepts `WA_RUNTIME_IMAGE` and defaults to `wa-runtime:local`. |
| API paths, DTOs and `contracts/runtime` directory | Keep stable. |
| PostgreSQL database and role | New installations use `wa_runtime` and a `wa_runtime` role. Existing installations migrate through a separately backed-up maintenance procedure. Tables and already-applied migration files remain unchanged. |
| Docker Compose project and network names | Use `wa-runtime`; migrate existing installations in a backed-up maintenance window. |
| Persistent volumes | Compose uses logical names `postgres-data` and `redis-data`, producing `wa-runtime_postgres-data` and `wa-runtime_redis-data`. Existing data is copied or explicitly reattached during a backed-up maintenance window; never rely on an implicit empty-volume replacement. |
| Runtime PostgreSQL and Redis hostnames | Use the private aliases `wa-runtime-postgres` and `wa-runtime-redis`; generic aliases can collide with OpenWA services on the shared gateway network. |
| Docker network alias | Use `wa-runtime-api`; no legacy alias remains. |
| Redis heartbeat and scheduler telemetry | Use `wa-runtime:*`; no legacy write or read fallback remains. |
| BullMQ queue names and stable job IDs | Keep unchanged so queued transport work survives rolling deployment. |
| Filesystem deployment and backup paths | Use `/opt/wa-runtime` and `/var/backups/wa-runtime` for new installations; migrate existing paths operationally rather than from application code. |

## Compatibility window and exit criteria

Compatibility existed to support a controlled transition and is not the steady state. Removal was
approved after:

1. every deployed API, scheduler and worker uses the `wa-runtime` namespace;
2. WA Studio and every operational probe use `wa-runtime-api` or the public Runtime origin;
3. no legacy Redis key or network-alias access is observed for one complete release window; and
4. rollback no longer targets a release that requires the legacy identifiers.

The PostgreSQL database/role and persistent-volume migration occurred in a maintenance window
because those identifiers own durable state. Readiness, data-count reconciliation, application
smoke tests and backup verification passed before the legacy volumes were explicitly removed. The
logical PostgreSQL backup remains retained outside Docker storage.

Public API paths, DTO names, BullMQ queue names, stable job IDs and already-applied SQL migration
files are protocol/history identifiers rather than product branding. They remain stable unless a
separate versioned migration is approved.

## Rollout

1. Merge and publish WA Runtime source and regenerated OpenAPI metadata.
2. Synchronize the Runtime OpenAPI snapshot and generated client in WA Studio.
3. Build immutable images under the `wa-runtime` name.
4. Make new-install defaults consistently use `wa_runtime`, `wa-runtime_postgres-data` and
   `wa-runtime_redis-data`.
5. For an existing installation, take a logical PostgreSQL backup, record row-count baselines, stop
   the old Compose project, and migrate its database/role and persistent volumes using the reviewed
   runbook before starting any service against the target storage.
6. Deploy API, scheduler and workers together.
7. Verify readiness, queue rediscovery, database row counts and application-level smoke tests.
8. Retain and verify the logical backup according to the documented retention policy.
9. Rename the Git repository and deployment directory, then update remotes and automation to use
    `wa-runtime` exclusively.

## Consequences

Operational dashboards, log queries and deployment automation use `wa-runtime`. Runtime processes
write only the new Redis namespace and expose only the new network alias. Business data is not
duplicated and public routes do not change. Existing installations require a separately reviewed
storage migration; new installations start directly with clean WA Runtime names.
