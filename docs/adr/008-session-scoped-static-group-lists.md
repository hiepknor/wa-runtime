# ADR 008: Session-scoped static group lists

- Status: Accepted
- Date: 2026-08-15
- Builds on: ADR 003 and the campaign target snapshot contract
- Amended by: ADR 010, which replaces the client-side apply decision with an atomic Runtime operation

## Context

WA Studio can search and filter every synchronized group while editing a campaign, but every new
campaign starts with an empty target selection. Operators need named, reusable selections without
turning volatile capability, freshness or participant-count filters into campaign policy.

The synchronized `gateway_groups` relation is a Runtime-owned durable read model. Campaign targets
are a persisted snapshot that changes only through atomic replacement and is evaluated by preflight.
Reusable selections must preserve both boundaries: OpenWA synchronization must not rewrite
operator-owned lists, and editing a list must not silently change an existing campaign audience.

## Decision

1. A group list is a first-class, session-scoped, user-managed aggregate with its own metadata,
   revision and membership.
2. WA Studio may colocate group-list management with the Groups workspace, but Runtime exposes a
   separate `/api/v1/group-lists` resource and does not add list state to `gateway_groups`.
3. Membership is a static set of group IDs. Search and filter expressions are not persisted as
   dynamic membership rules.
4. A list may contain active or inactive groups and any send-capability state. Eligibility remains a
   campaign preflight policy decision.
5. A list contains at most 1,000 unique groups from its own session. Complete membership replacement
   is atomic and increments the list revision only when the effective set changes.
6. The initial release applies a list as a client-side copy. ADR 010 supersedes this mechanism with
   revision-bound atomic application in Runtime while retaining snapshot, rather than live-binding,
   semantics.
7. Renaming, editing or archiving a list never changes campaign targets already saved from it.
8. Archiving is soft. Archived lists are not returned by normal list browsing and cannot be edited,
   but their stored membership and all campaign target snapshots remain intact.
9. List creation is idempotent so a lost HTTP response cannot create duplicate reusable lists.
10. All list reads and writes enforce the existing allowlisted-session visibility model. Composite
    foreign keys prevent cross-session membership.

## Consequences

- Operators can reuse a named selection while still reviewing and adjusting the complete staged
  target set before saving a campaign.
- Group synchronization and capability refresh remain independent of user-managed list state.
- Campaign preflight, target revisions, run creation and message delivery require no contract or
  implementation changes.
- A list edit does not propagate to campaigns. Operators who need the new membership explicitly add
  or replace from the list and save the campaign target set again.
- The bounded complete membership response is at most 1,000 records, matching the existing campaign
  target contract and avoiding pagination ambiguity while applying a list.

## Rejected alternatives

- **Live campaign-to-list binding:** silently changes a campaign audience and introduces another
  revision/staleness axis into preflight.
- **Persist saved filters:** capability, freshness, active state and participant counts are volatile;
  dynamic evaluation would make membership change without an explicit operator action.
- **Store list membership on `gateway_groups`:** couples operator state to an upstream read model and
  cannot represent membership in multiple lists cleanly.
- **Persist list provenance on campaign targets in the initial release:** deferred at the time; ADR
  010 later accepts it together with an atomic apply boundary and separate membership revision.
- **A dedicated top-level product domain:** the UI concern is currently a group-management sub-view;
  the backend resource remains independent so it can be promoted later without a data migration.

## Delivery and acceptance gates

The rollout is additive: schema and Runtime API, authoritative OpenAPI artifact, WA Studio adoption,
then coordinated staging validation. Existing Runtime and Studio versions ignore the new tables and
endpoints.

Acceptance requires atomic membership tests, allowlist and cross-session isolation, deterministic
list ordering, idempotent creation, no campaign mutation from list edits or archive, and regression
coverage proving that campaign preflight and execution behavior are unchanged.
