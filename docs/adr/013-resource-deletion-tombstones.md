# ADR 013: Resource deletion tombstones

- Status: Accepted
- Date: 2026-08-16
- Applies to: Campaign and saved group-list deletion

## Context

Campaign `ARCHIVED` is already the terminal lifecycle state of a one-send LIVE plan. Reusing that
state for an operator Delete action would conflate execution history with workspace visibility.
Physical deletion is also unsafe: campaign runs deliberately restrict parent deletion, saved-list
provenance restricts source-list deletion, and removing the row that owns a create idempotency key
would allow a later retry to recreate a resource the operator believed was deleted.

## Decision

1. Saved group-list `DELETE` continues to set `archived_at`; it never deletes membership or changes
   campaign targets already copied from the list.
2. Repeated saved-list `DELETE` is idempotent and returns HTTP 204 after the list is archived.
3. Replaying a create idempotency key owned by an archived list returns
   `GROUP_LIST_IDEMPOTENCY_KEY_RETIRED` instead of returning the hidden resource.
4. Campaign deletion is independent of Campaign lifecycle. It sets nullable `deleted_at`, increments
   the content revision and leaves `status`, targets, runs, deliveries and message jobs intact.
5. A Campaign may be deleted only while `DRAFT` or `ARCHIVED` and only when every run is terminal.
   `ACTIVE`/`PAUSED` plans and non-terminal DRY_RUNs must be cancelled first.
6. Campaign delete requires both the observed content and target revisions. The repository locks the
   Campaign and any non-terminal run candidate, so launch, target mutation and delete serialize.
7. Active Campaign reads and mutations exclude tombstones. Direct run reads remain available until
   operational retention removes the terminal run graph.
8. A repeated Campaign delete returns HTTP 204. Replaying its create key returns
   `CAMPAIGN_IDEMPOTENCY_KEY_RETIRED`; deletion never makes an idempotency key reusable.
9. Physical erasure is not part of the public DELETE transaction. A future retention policy may
   purge an old tombstone only after no run references it and the idempotency window has expired.

## Consequences

- Campaign lifecycle and lifecycle auditing retain their existing meaning.
- Workspace cleanup does not destroy execution evidence or permit retry resurrection.
- An older Runtime does not understand `deleted_at` and can expose or mutate tombstones. Once the
  first deletion is accepted, rollback must stay at or above the tombstone-aware Runtime release.
- WA Studio must send both revisions, remove a Campaign only after HTTP 204, and require active work
  to be cancelled before retrying Delete.

## Required verification

- deleted Campaigns disappear from list/detail/target/preflight and campaign-scoped run APIs;
- direct terminal run reads and database run/target records remain intact;
- stale content or target revisions return HTTP 409 without a partial mutation;
- Delete versus LIVE launch has exactly one winner;
- non-terminal DRY_RUN and LIVE states block deletion until cancellation;
- repeated Delete returns HTTP 204;
- create-key replay after deletion/archive returns the typed retired-key conflict;
- non-allowlisted resources retain not-found semantics.
