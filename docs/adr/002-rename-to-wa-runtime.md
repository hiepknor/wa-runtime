# ADR 002: Rename Automation Runtime to WA Runtime

- Status: Accepted
- Date: 2026-08-12
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
deployment outage.

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
| PostgreSQL database `automation_runtime`, roles, tables and applied migrations | Keep as legacy storage identifiers; rename only through a separately backed-up database migration. |
| Docker Compose project and network names | Use `wa-runtime`; migrate existing installations in a backed-up maintenance window. |
| Existing persistent volume names | Reattach or copy them explicitly during the Compose project migration; never rely on an implicit empty-volume replacement. New installations use the `wa-runtime` prefix. |
| Runtime PostgreSQL and Redis hostnames | Use the private aliases `wa-runtime-postgres` and `wa-runtime-redis`; generic aliases can collide with OpenWA services on the shared gateway network. |
| Docker network alias | Add `wa-runtime-api`; retain `automation-api` during the compatibility window. |
| Redis heartbeat and scheduler telemetry | Dual-write `wa-runtime:*` and legacy `automation-runtime:*`; read the new key first and fall back to legacy. |
| BullMQ queue names and stable job IDs | Keep unchanged so queued transport work survives rolling deployment. |
| Filesystem deployment and backup paths | Use `/opt/wa-runtime` and `/var/backups/wa-runtime` for new installations; migrate existing paths operationally rather than from application code. |

Legacy Redis writes and the `automation-api` network alias may be removed only after every deployed
API, scheduler, worker and operational probe uses the new namespace. The legacy PostgreSQL and
database identifiers have no scheduled removal. Existing Compose storage is migrated operationally;
the source volumes are retained until backup and post-migration verification complete.

## Rollout

1. Merge and publish WA Runtime source and regenerated OpenAPI metadata.
2. Synchronize the Runtime OpenAPI snapshot and generated client in WA Studio.
3. Build immutable images under the `wa-runtime` name.
4. Back up PostgreSQL, stop the old Compose project, and copy or reattach its persistent volumes to
   the `wa-runtime` project before starting any service against them.
5. Deploy API, scheduler and workers together or roll them while dual Redis writes are active.
6. Verify readiness through both Redis namespaces, queue rediscovery and existing PostgreSQL state.
7. Retain the stopped source volumes until restore evidence and application-level smoke tests pass.
8. Rename the Git repository and deployment directory only after remote references and automation
   have been updated.

## Consequences

Operational dashboards, log queries and deployment automation must move to `wa-runtime`. During the
compatibility window duplicate ephemeral Redis heartbeat and scheduler-state keys are expected.
Business data is not duplicated, public routes do not change and no database migration is required.
