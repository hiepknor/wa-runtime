# ADR 010: Revision-bound audience snapshots and provenance

- Status: Accepted
- Date: 2026-08-15
- Builds on: ADR 008 and ADR 009

## Context

Synchronized groups are mutable external facts, saved group lists are reusable operator intent,
campaign targets are an editable audience, and run targets are an immutable execution snapshot.
ADR 008 initially made applying a saved list a client-side copy. That preserves campaign snapshot
semantics, but it cannot atomically prove which saved-list membership revision was applied.

## Decision

1. The four ownership layers remain separate:
   `gateway_groups -> group_list_items -> campaign_targets -> campaign_run_targets`.
2. Campaigns never resolve a saved list dynamically during preflight or execution.
3. Runtime exposes an atomic operation that copies one saved-list membership revision into a DRAFT
   campaign target set. It locks both aggregates, checks their revisions and persists provenance.
4. Provenance records the source list ID and membership revision. Renaming, editing or archiving the
   list later never changes the campaign target set.
5. Manual target replacement clears saved-list provenance. Reapplying the same effective source and
   membership is a no-op; changing either membership or provenance advances `targetsRevision`.
6. Saved-list metadata and membership use separate revisions. The aggregate `revision` advances for
   any effective mutation; `membershipRevision` advances only when the group-ID set changes.
7. Target-list responses return data, its `targetsRevision`, and nullable source provenance from the
   same database snapshot.
8. Archived lists remain valid provenance but cannot be newly applied.
9. Nullable Campaign `source` is current-state provenance, not historical lineage: non-null means
   the effective target set exactly matches the recorded membership revision; manual replacement
   clears it and produces a custom snapshot.
10. Campaign and run provenance snapshot the source list name for presentation and audit. Later
    rename/archive operations do not rewrite that name snapshot.

## Consequences

- Applying 1,000 IDs no longer requires a client read/copy/write race or a large request body.
- Campaign execution remains bound only to materialized campaign targets, not mutable list state.
- Existing manual replacement remains supported and wire-compatible.
- New clients should send both campaign-target and list-membership preconditions.

## Required verification

- a concurrent list edit or campaign target edit returns typed HTTP 409 without a partial write;
- cross-session and archived lists cannot be applied;
- a source in a non-allowlisted session is indistinguishable from a missing source;
- list edits and archive do not mutate campaigns already populated from the list;
- target data, revision and provenance are returned from one repeatable-read snapshot.
