# Saved Group Lists contract handoff

- Status: `RUNTIME_READY / STUDIO_PENDING / STAGING_NOT_STARTED`
- Date: 2026-08-15
- Runtime ADR: `f92edef`
- Runtime implementation: `b762739`
- Runtime tests: `e412ba5`
- Runtime archived-mutation refinement: `798b306`
- Runtime delivery range: `f92edef^..798b306`
- Authoritative artifact: `contracts/runtime/v1/openapi.json`
- OpenAPI SHA-256: `ce54abc0b8f1184b99d1d25e1266f0e7b27c66ce4bb72e03669594eebcaf2b4e`
- WA Studio commit: pending

## Contract decision

Runtime publishes session-scoped static saved group lists at `/api/v1/group-lists`. Applying a list
is a WA Studio authoring operation that copies its bounded membership into staged campaign targets.
There is no live campaign binding, persisted provenance, dynamic filter membership or preflight
change in this release.

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

- 31 unit test files, 98 tests passed;
- 22 integration test files, 169 tests passed;
- saved-list integration coverage includes concurrent create replay, literal search and filtered
  pagination, metadata normalization, duplicate/limit/missing/cross-session validation, 1,000-group
  replacement, no-op revisions, archive isolation and absence of run/delivery/job side effects;
- repeated contract generation produced the SHA-256 above.

## Coordinated release gate

Before staging, WA Studio must copy the authoritative artifact byte-for-byte, regenerate its client,
record its commit here and pass its Groups/Saved lists/Campaign target integration suite. Staging must
then verify create/edit/archive, multi-page selection, add/replace staged campaign targets, campaign
snapshot independence after list edits, allowlist isolation and absence of send/run side effects.

Production remains blocked until the Studio commit and successful coordinated staging evidence are
recorded. The additive migration may remain applied if application rollback is required; old Runtime
and Studio versions ignore the new tables.
