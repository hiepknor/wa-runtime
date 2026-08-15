# Audience launch invariants Release A — staging pass

- Status: `RELEASE_A_STAGING_PASS / RELEASE_B_GATED / PRODUCTION_NOT_STARTED`
- Runtime commit: `0cddc89d15cca6cd13a1cd0e1d352aaf469fccdb`
- Staging image: `wa-runtime:0cddc89`
- Image ID: `sha256:f0d7aba076791d185b2a395af790e4ecf34e2682dd7bff6779bea35c8e944b3f`
- Runtime origin: `https://wa-runtime-staging.onio.cc`
- Evidence time: `2026-08-15T12:47:02Z`
- OpenAPI SHA-256: `4b932b05213252c624b9d0cb359d696d30db9e90d23e1b91421286076ccec760`

## Pre-deployment gate

- Runtime worktree was clean and commit was pushed to `origin/main`.
- A restricted PostgreSQL custom-format logical backup completed before migration.
- Database inspection found zero LIVE runs and zero campaigns with duplicate LIVE runs.
- Migration 035 and the former migration 036 had not been applied before this rollout.
- Live sends remained disabled.

## Deployment and verification

Release A applied only `035_audience_snapshot_provenance.sql`. API, worker and scheduler were rebuilt
from the exact commit and converged healthy on the same immutable image ID. The source artifact checksum
on the server matched the local authoritative OpenAPI checksum.

Authenticated read-only smoke checks returned HTTP 200 and valid paginated response shapes for:

- `GET /api/v1/groups`;
- `GET /api/v1/group-lists`;
- `GET /api/v1/campaigns`.

The operator lifecycle audit returned:

```json
{"mode":"audit","duplicateLiveCampaigns":0,"lifecycleDrift":0}
```

The scheduler's `campaign-lifecycle-audit` tick completed successfully with no failure, timeout or
drift event. The database contains the campaign and run source-name snapshot columns. It deliberately
does not contain `uq_campaign_runs_single_live_launch` in Release A.

## Remaining gates

1. Regenerate and verify WA Studio against the recorded OpenAPI artifact.
2. Resolve the staging OpenWA version mismatch: Runtime pins reviewed release `0.16.0`, but the
   connected deployment reports `0.18.0`.
3. Run coordinated authoring and run-snapshot smoke after that mismatch is resolved.
4. Observe lifecycle audit over an agreed window with `multipleLive=0` and no recurring drift.
5. Implement Release B as a new migration adding the partial unique index; do not modify migration 035.
6. Do not enable production or live sends as part of this record.

Release B and production remain gated. No reconciliation write was needed during this rollout.
