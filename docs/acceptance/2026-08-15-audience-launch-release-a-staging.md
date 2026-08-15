# Audience launch invariants Release A — staging pass

- Status: `RUNTIME_AND_STUDIO_READY / COORDINATED_STAGING_PENDING / RELEASE_B_GATED`
- Runtime commit: `0cddc89d15cca6cd13a1cd0e1d352aaf469fccdb`
- Staging image: `wa-runtime:0cddc89`
- Image ID: `sha256:f0d7aba076791d185b2a395af790e4ecf34e2682dd7bff6779bea35c8e944b3f`
- Runtime origin: `https://wa-runtime-staging.onio.cc`
- Evidence time: `2026-08-15T12:47:02Z`
- OpenAPI SHA-256: `4b932b05213252c624b9d0cb359d696d30db9e90d23e1b91421286076ccec760`
- WA Studio baseline: `25a57fbef3a8b45ff00a1ec2ce7240c660ead0a2`
- WA Studio migration commit: `ba1038ad5d1a86e312f616debf05fa44f5257e4b`

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

WA Studio completed its migration and confirmed the Runtime artifact byte-for-byte. Its local gate
passed 33 test files and 263 tests, TypeScript production build, Rust formatting/Clippy and two
byte-stable contract generations. Its worktree was clean; it did not push, deploy, tag, send LIVE or
send a real message.

1. Run coordinated authoring and run-snapshot smoke. The OpenWA 0.18.0 mismatch was resolved by the
   reviewed Runtime upgrade at commit `48ad3a0`.
2. Observe lifecycle audit over an agreed window with `multipleLive=0` and no recurring drift.
3. Implement Release B as a new migration adding the partial unique index; do not modify migration 035.
4. Do not enable production or live sends as part of this record.

Release B and production remain gated. No reconciliation write was needed during this rollout.
