# Saved Group Lists contract handoff

- Status: `RUNTIME_RELEASE_A_STAGING_PASS / STUDIO_PENDING / COORDINATED_STAGING_BLOCKED`
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
- WA Studio commit: pending

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

The Runtime pin remains `OPENWA_RELEASE_TAG=0.16.0`, while the connected OpenWA deployment reports
`0.18.0`. Readiness does not validate this upstream version. OpenWA-dependent coordinated smoke is
therefore blocked until the upstream 0.18 contract is reviewed and the Runtime pin is deliberately
updated, or the Gateway is restored to the reviewed 0.16 release.

## Coordinated release gate

WA Studio must copy the authoritative artifact byte-for-byte, regenerate its client, record its commit
here and pass its Groups/Saved lists/Campaign target integration suite. After the OpenWA version blocker
is resolved, coordinated staging must verify create/edit/archive, multi-page selection, add/replace
staged campaign targets, campaign and run snapshot independence after list rename/archive, allowlist
isolation and expected run side effects.

Production remains blocked until the Studio commit and successful coordinated staging evidence are
recorded. Release B's partial unique index remains blocked until Release A lifecycle observations stay
clean. Migration 035 is additive and may remain applied if the application is rolled back to the prior
Runtime revision.
