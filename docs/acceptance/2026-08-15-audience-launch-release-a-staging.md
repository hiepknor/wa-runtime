# Audience launch invariants Release A/B — staging pass

- Status: `RELEASE_B_STAGING_PASS / PRODUCTION_GATED`
- Runtime Release A commit: `0cddc89d15cca6cd13a1cd0e1d352aaf469fccdb`
- Runtime preflight-status fix: `e48aa9e0fc6201b698934a802c755b0738366473`
- Runtime Release B commit: `c4210f8b39278b73b7c24557947508157eb4421b`
- Current staging image: `wa-runtime:c4210f8`
- Current image ID: `sha256:7e16e12537da075f55355d6e2b89de6ad58a6685968fb962d1fad7adfd92045d`
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

## WA Studio readiness

WA Studio completed its migration and confirmed the Runtime artifact byte-for-byte. Its local gate
passed 33 test files and 263 tests, TypeScript production build, Rust formatting/Clippy and two
byte-stable contract generations. Its worktree was clean; it did not push, deploy, tag, send LIVE or
send a real message.

## Coordinated staging evidence

At `2026-08-15T15:07:26Z`, WA Studio commit
`ba1038ad5d1a86e312f616debf05fa44f5257e4b` ran locally against Runtime staging. Runtime API, worker
and scheduler were healthy on `wa-runtime:48ad3a0`; OpenWA reported `0.18.0`, the single configured
session was ready and live sends remained disabled.

The coordinated smoke used one reusable DRAFT campaign and an archived temporary saved list. It
verified:

- idempotent list creation, literal search and filtered pagination;
- atomic membership replacement with two groups selected across separate pages of a 574-group
  dataset;
- applying an exact saved-list membership revision to staged campaign targets;
- campaign source-name and membership provenance remaining unchanged after list rename and archive;
- DRY_RUN and LIVE preflight counters, with preflight producing no run, delivery or linked-job rows;
- allowlist isolation using the existing not-found boundary;
- an immutable run source snapshot after the source list was renamed and archived;
- a two-target DRY_RUN reaching `COMPLETED` with two dry-run completions;
- zero LIVE runs and zero delivery states associated with a real send.

The Studio UI loaded the retained campaign, displayed its two saved targets and materialized source
provenance, kept a selected target visible outside the current result page, displayed the completed
DRY_RUN and successfully ran a fresh DRY_RUN preflight. The report was `WARN` with internally
consistent counters: two total, one allowed, one denied and zero unknown. The Runtime lifecycle audit
remained at zero duplicate LIVE campaigns and zero lifecycle drift before and after the smoke. No
relevant API, worker or scheduler error appeared in the smoke window.

The preflight HTTP finding was closed at Runtime commit `e48aa9e`: the controller now explicitly
returns HTTP 200 for DRY_RUN and LIVE, integration tests assert both statuses, and the contract test
rejects an accidental 201 response declaration. The authoritative artifact already declared 200, so
two regenerations remained byte-stable at the recorded SHA-256 and Studio needed no contract update.
After staging moved to `wa-runtime:e48aa9e`, direct Runtime smoke and Studio local preflight both
passed; preflight did not change run, delivery or linked-job counts.

## Reduced observation gate

The operator approved replacing the 24-hour wait with three consecutive scheduler audit ticks plus
manual audits before and after. The three ticks completed at `2026-08-15T15:32:00.301Z`,
`2026-08-15T15:33:00.302Z` and `2026-08-15T15:34:00.303Z`. Every tick reported zero consecutive
failures, no timeout, zero duplicate LIVE campaigns and zero lifecycle drift. No reconciliation write
was needed.

## Release B staging evidence

Release B commit `c4210f8` adds migration `036_single_live_campaign_launch.sql`; migration 035 remains
unchanged. Local verification passed 34 unit files with 107 tests and 23 integration files with 189
tests. Contract generation remained byte-stable at the existing SHA-256.

Immediately before migration, the manual audit was `0/0`. A PostgreSQL 17 custom-format backup was
written to `/var/backups/wa-runtime/pre-release-b-20260815T153757Z.dump`, verified with the matching
PostgreSQL 17 `pg_restore` catalog reader (280 entries) and restricted to mode 600. API, worker and
scheduler were quiesced while migration 036 ran. The migration completed, and all three processes
converged healthy on `wa-runtime:c4210f8` with live sends disabled and OpenWA `0.18.0`.

Catalog verification confirmed both the migration record and
`uq_campaign_runs_single_live_launch`. A rollback-only database probe created one temporary LIVE row,
received PostgreSQL `23505` at that exact index for the second row, and rolled the entire probe back.
The post-migration audit remained `0/0`; the first scheduler audit succeeded with no timeout or
failure. DRY_RUN and LIVE preflight both returned HTTP 200, LIVE remained blocked by the send
interlock, and preflight caused no run or delivery changes.

## Remaining gates

1. Pin and publish the reviewed Runtime and Studio revisions through the normal release process.
2. Take a fresh production backup and require a final `0/0` lifecycle audit before applying migration
   036 in a quiesced production window.
3. Do not roll back to a Runtime older than Release A after migration 036 is applied; retain the index
   and use a compatible forward fix.
4. Keep live sends disabled until a separate production authorization explicitly enables them.

Release B staging is complete. Production remains gated and was not changed by this rollout.
