# ADR 011: One live launch per campaign plan

- Status: Accepted
- Date: 2026-08-15
- Applies to: Campaign and CampaignRun lifecycle

## Context

Campaign scheduling belongs to the campaign definition, while the API also permits multiple runs.
Without a launch invariant, an `ONCE` campaign can create multiple LIVE runs by using different
idempotency keys, and the Campaign status enum has no implemented transition owner.

## Decision

1. A Campaign is one send plan, not a reusable sending template.
2. A DRAFT remains editable and may create multiple DRY_RUN executions for review.
3. A campaign may create at most one LIVE run. The first LIVE creation atomically snapshots the
   definition and targets and changes Campaign status from `DRAFT` to `ACTIVE`.
4. A LIVE launch requires the expected campaign and target revisions. Omitted fields remain
   temporarily accepted for backward compatibility, but Runtime binds the launch to the revisions
   locked inside the creation transaction.
5. A LIVE run may be `PREPARING`, `BLOCKED`, `SCHEDULED` or `RUNNING` while Campaign is `ACTIVE`.
   Pausing the live run sets Campaign to `PAUSED`; resuming sets it to `ACTIVE`.
6. Terminal live-run completion or cancellation archives the one-send plan. Campaign `ARCHIVED`
   means no further edits or launches; immutable run state contains the precise terminal outcome.
7. DRY_RUN never changes Campaign status and never consumes the single LIVE launch.
8. Run creation rejects archived/paused campaigns and rejects a second LIVE launch with stable
   machine-readable conflicts.

## Consequences

- Campaign schedule has one unambiguous live execution owner.
- Retry after a lost launch response remains idempotent through the existing key.
- Operators wanting a similar future send create or clone another Campaign; cloning is a separate
  future authoring feature.
- Campaign status is a coarse plan lifecycle; CampaignRun remains the detailed execution authority.
- Rollout uses two releases. Release A deploys application locking, explicit existing-LIVE checks,
  typed conflict handling and lifecycle audit while remaining rollback-compatible with the prior
  database. Release B adds the partial unique index only after every process runs compatible code
  and the audit reports no duplicates or lifecycle drift.
- Before Release B, operators must verify that no campaign already has multiple LIVE runs. Migration
  intentionally fails rather than choosing or deleting historical runs automatically.
- After Release B applies the unique index, versions older than Release A are database-incompatible;
  incidents use a compatible forward-fix rather than an application-only rollback.

## Required verification

- multiple DRY_RUNs remain possible without changing Campaign status;
- concurrent LIVE launch attempts create at most one run;
- replay of the winning idempotency key returns that run;
- pause/resume/terminal transitions keep Campaign and its LIVE run consistent;
- DRAFT edits and target replacement become unavailable after LIVE launch.
- Release B rollout preflight reports zero rows for:
  `SELECT campaign_id FROM campaign_runs WHERE execution_mode = 'LIVE' GROUP BY campaign_id HAVING count(*) > 1`.
