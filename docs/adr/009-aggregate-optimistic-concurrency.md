# ADR 009: Additive optimistic concurrency for authoring aggregates

- Status: Accepted
- Date: 2026-08-15
- Applies to: campaign definitions, campaign target sets and saved group lists

## Context

Campaign and saved-list responses expose revisions, but mutations previously reconstructed complete
state from a read and then wrote it without a compare-and-swap predicate. Concurrent editors could
therefore overwrite disjoint metadata changes or replace a newer target/membership snapshot. The
revisions bound campaign preflight results but did not protect authoring.

## Decision

1. `PATCH /campaigns/{id}` accepts optional `expectedRevision`.
2. `PUT /campaigns/{id}/targets` accepts optional `expectedTargetsRevision`.
3. Saved-list metadata and membership replacements accept optional `expectedRevision`.
4. New clients send the revision they loaded. A mismatch returns HTTP 409 with a stable typed code;
   no mutation is applied.
5. Omission remains backward-compatible, but Runtime still uses the revision read at the start of the
   request as an internal compare-and-swap value. A concurrent change during that request therefore
   returns 409 instead of being overwritten.
6. Campaign content and targets keep independent counters. Saved-list metadata and membership share
   one aggregate revision because both define the reusable selection.
7. Material no-op writes keep their current revision.

## Consequences

- WA Studio can adopt the fields without a coordinated breaking rollout.
- A legacy client may newly receive a conflict during a true concurrent race and should reload.
- Archive is internally compare-and-swap protected. A client-visible archive precondition is deferred
  until Studio needs concurrent archive UX; archive remains idempotently unavailable after completion.
- Conflict responses do not expose private aggregate content, only expected/current numeric revisions
  when already authorized.

## Required verification

- stale metadata and target/membership writes return typed 409 responses;
- the newer persisted value remains unchanged;
- cross-session and archived/not-editable behavior retains precedence;
- OpenAPI publishes all optional revision preconditions.
