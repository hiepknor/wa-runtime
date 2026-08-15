# Saved Group Lists contract handoff

- Status: `COORDINATED_STAGING_PASS / OBSERVATION_PENDING / RELEASE_B_GATED`
- Date: 2026-08-15
- Runtime ADR: `f92edef`
- Runtime implementation: `b762739`
- Runtime tests: `e412ba5`
- Runtime archived-mutation refinement: `798b306`
- Runtime audience binding baseline: `b8d63ff`
- Runtime Release A hardening: `0cddc89`
- Runtime delivery range: `f92edef^..0cddc89`
- Authoritative artifact: `contracts/runtime/v1/openapi.json`
- OpenAPI SHA-256: `4b932b05213252c624b9d0cb359d696d30db9e90d23e1b91421286076ccec760`
- WA Studio baseline: `25a57fbef3a8b45ff00a1ec2ce7240c660ead0a2`
- WA Studio migration commit: `ba1038ad5d1a86e312f616debf05fa44f5257e4b`

## Contract decision

Runtime publishes session-scoped static saved group lists at `/api/v1/group-lists`. Applying a list
is a WA Studio authoring operation that copies its bounded membership into staged campaign targets.
Campaigns persist binary current-state provenance for an exact applied membership revision, including
an immutable source-list name snapshot. Manual target replacement clears provenance. Campaign runs
copy this audit snapshot and never resolve the mutable list during execution. There is no dynamic
filter membership or preflight-policy change in this release.

List creation is idempotent. Membership contains at most 1,000 unique durable groups and is replaced
atomically. Archive is soft and cannot mutate an existing campaign target snapshot. Every operation
uses the allowlisted-session boundary and `RuntimeErrorDto` responses.

## Runtime verification

The implementation was verified locally with:

```text
npm run check:all
npm run contract:generate  # twice, byte-stable
git diff --check
codegraph sync
```

Results at the recorded implementation:

- 33 unit test files, 104 tests passed;
- 23 integration test files, 189 tests passed;
- saved-list integration coverage includes concurrent create replay, literal search and filtered
  pagination, metadata normalization, duplicate/limit/missing/cross-session validation, 1,000-group
  replacement, no-op revisions, archive isolation and absence of run/delivery/job side effects;
- repeated contract generation produced the SHA-256 above.

## Runtime Release A staging evidence

At `2026-08-15T12:47:02Z`, staging served `https://wa-runtime-staging.onio.cc` from image
`wa-runtime:0cddc89` with image ID
`sha256:f0d7aba076791d185b2a395af790e4ecf34e2682dd7bff6779bea35c8e944b3f` on API, worker and scheduler.
A pre-migration logical PostgreSQL backup completed successfully.

- migration `035_audience_snapshot_provenance.sql` is applied;
- the deferred single-LIVE unique index is absent, as required for Release A;
- readiness reports PostgreSQL, Redis, worker and scheduler ready with live sends disabled;
- authenticated `groups`, `group-lists` and `campaigns` page reads returned HTTP 200 with valid page metadata;
- lifecycle audit before and after rollout reported zero duplicate LIVE campaigns and zero lifecycle drift;
- the scheduled lifecycle audit completed with zero consecutive failures;
- no lifecycle drift, scheduler failure/timeout or fatal application event appeared in rollout logs.

The OpenWA 0.18.0 contract was subsequently reviewed at Runtime commit `48ad3a0`. Staging now pins and
reports 0.18.0, and a controlled incremental sync completed without validation or reconciliation
failure. The prior upstream version-mismatch blocker is closed.

## WA Studio verification

WA Studio confirmed that its copied Runtime artifact is byte-identical with SHA-256
`4b932b05213252c624b9d0cb359d696d30db9e90d23e1b91421286076ccec760`. At migration commit
`ba1038ad5d1a86e312f616debf05fa44f5257e4b`, Studio reported:

- 33 test files and 263 tests passed;
- TypeScript production build passed;
- Rust formatting and Clippy passed;
- contract generation ran twice and was byte-stable;
- the Studio worktree was clean;
- no push, deployment, release tag, LIVE send or real message occurred.

## Coordinated release gate

Runtime and Studio contract readiness is complete. Coordinated staging ran at
`2026-08-15T15:07:26Z` with Studio commit
`ba1038ad5d1a86e312f616debf05fa44f5257e4b` local and Runtime staging on
`wa-runtime:48ad3a0`. The smoke covered idempotent create, search, archive, atomic membership
replacement, multi-page selection over 574 groups, applying an exact membership revision, campaign
and run snapshot independence after list rename/archive, allowlist isolation and a completed
two-target DRY_RUN. There were no LIVE runs, real-send delivery states or lifecycle drift.

Studio displayed the retained campaign and its materialized saved-list provenance, preserved a
selected target outside the current page, displayed the completed DRY_RUN and produced a fresh WARN
preflight with consistent two-target counters. The local Studio quality gate passed again at the
recorded commit, and the Studio worktree remained clean after verification.

The smoke found that campaign preflight returns HTTP 201 although OpenAPI declares HTTP 200. Studio's
2xx handling worked, but the implementation/contract mismatch must be resolved and the affected smoke
repeated before production.

Production remains blocked pending the HTTP-status follow-up and a clean lifecycle observation window.
Release B's partial unique index remains blocked until Release A lifecycle observations stay clean.
Migration 035 is additive and may remain applied if the application is rolled back to the prior Runtime
revision.
