# ADR 007: Evidence-first, reversible contact resolution

- Status: Accepted
- Date: 2026-08-14
- Builds on: ADR 003, ADR 004 and ADR 005
- Supersedes: ADR 005's destructive contact merge and contact-global participant-name decisions

## Context

ADR 005 established a session-scoped observed-contact model and correctly refused to infer a phone
number from a WhatsApp LID. Its staging rollout linked every synchronized member row to a contact and
kept member reads database-side. Further review exposed four limits that must not become permanent
contracts:

1. `group_members.phone_number` still contains OpenWA's raw participant `number`; for every observed
   LID row this is the LID user-part, not an authoritative phone number.
2. Group, contact-snapshot and message producers each materialize names, so their update order can
   temporarily violate the documented contact-name precedence.
3. A logical contact is destructively merged as soon as one snapshot provides an unambiguous phone
   edge. Later contradictory evidence cannot split that contact again.
4. Every named inbound message synchronously takes a session advisory lock and may fan out writes to
   every membership of the sender.

OpenWA's contact store remains a bounded observation cache, not an authoritative address-book mirror.
The Runtime therefore needs to preserve evidence separately from its current resolution and from the
read projection consumed by WA Studio.

## Decision

### Identity and phone semantics

1. An exact observed identity, keyed by `(session_id, identity_type, identity_value)`, is the durable
   anchor for every group member. Logical-contact resolution is optional and rebuildable.
2. `participant_id` remains the public upstream identity. Runtime records its explicit identity type.
3. A resolved phone number is nullable and is populated only by a phone JID or authoritative,
   non-conflicted identity-link evidence. A LID user-part is never a resolved phone number.
4. The existing `phoneNumber` member field remains temporarily as a deprecated legacy value. New
   consumers use `resolvedPhoneNumber`; removal or semantic narrowing of the legacy field requires a
   coordinated versioned contract change.

### Evidence and resolution

5. Contact snapshots stage identity, name and link evidence under a fenced generation. A generation
   becomes eligible for resolution only after every upstream page has been received and validated.
6. Identity edges retain source, source observation time and generation. Names, raw participant
   values or cross-session data never create identity edges.
7. Resolution writes versioned contact clusters and identity assignments. Source evidence is not
   rewritten or deleted by resolution. A later generation can rebuild or split a previous cluster.
8. Conflicting phone evidence is quarantined rather than resolved by page order, arrival order or an
   arbitrary winner. Same-page and cross-page ambiguity have identical semantics.

### Name scope and ordering

9. OpenWA contact names are session/contact observations, group-participant names belong to the exact
   group membership that supplied them, and push names belong to the exact observed identity.
10. Effective member-name precedence is computed by one implementation:
    OpenWA contact name from a non-conflicted resolved cluster, the membership's participant name,
    the latest push name of the exact identity, a resolved alias push name only for a non-conflicted
    cluster, then null.
11. Producers write observations with source event time. An older observation processed later cannot
    replace a newer observation. Names are trimmed, normalized to Unicode NFC, bounded, and rejected
    when they merely repeat a known identity or phone value.

### Projection and execution

12. `group_members` remains the member API read projection. It materializes identity type, resolved
    phone, effective name, provenance, normalized sort data and a projection revision. Member reads do
    not call OpenWA or join the contact graph.
13. Contact-wide projection changes are delivered through PostgreSQL-owned, revisioned dirty work.
    The resolved cluster is the canonical work key; stale exact-identity aliases are coalesced in
    bounded `SKIP LOCKED` batches without cancelling a running lease. Workers use lease fencing and
    coalesce repeated observations before batch-updating memberships. Webhook completion never
    depends on projection completion.
14. Group synchronization may update the membership-local participant name in its fenced group
    transaction, but it does not synchronously resolve or fan out contact-global state. Only member
    rows actually inserted or changed request new projection work; one changed membership must not
    requeue every otherwise unchanged participant in the group.
15. Page and count queries retain one repeatable-read snapshot, database-side filtering and a final
    participant-ID tie-breaker. A group-level dataset generation is incremented transactionally by
    every member insert, update or delete, allowing clients to detect membership or enrichment changes
    between page reads. A maximum row-projection revision is insufficient because delayed lower-
    revision work or deletion of a non-maximum row can change ordering without changing that maximum.

### Isolation, privacy and rollout

16. Every identity, observation, evidence, resolution, assignment, job and projection relation is
    session-scoped and protected by composite foreign keys or equivalent constraints.
17. Durable webhook storage contains only the validated fields required for processing, or its raw
    retention is explicitly documented and bounded. Raw contact objects never enter logs, metrics or
    long-lived normalized runtime events.
18. The migration is additive and feature-gated: schema, dual-write, shadow resolution, shadow
    projection, authoritative projection and API exposure are enabled separately. Applied migrations
    are never reversed in place; rollback disables new producers/readers while preserving evidence.

## Target model

The implementation introduces, in reviewable migrations, relations equivalent to:

- `observed_contact_identities` for exact session-scoped identities;
- `contact_observations` for source- and event-time-scoped names and attributes;
- `contact_link_evidence` for authoritative identity edges;
- snapshot staging/publication state for complete generations;
- versioned resolution runs, clusters and identity assignments;
- `contact_projection_work` for coalesced, fenced materialization;
- additive member-projection columns for identity, resolved phone and revision.

Names are intentionally descriptive rather than a frozen SQL contract. Each migration must preserve
these invariants and be independently applicable before its producer is enabled.

## Consequences

- Runtime can distinguish complete identity coverage from nullable phone/name coverage without
  exposing LID digits as verified phone numbers.
- Resolution becomes deterministic, explainable and reversible at the cost of additional evidence
  and versioned projection storage.
- Snapshot publication and asynchronous materialization introduce bounded eventual consistency.
  Projection revision and aggregate lag metrics make that state visible without exposing PII.
- Read payload and application memory remain proportional to `limit`; contact complexity is removed
  from the request path.
- Existing WA Studio remains compatible while additive fields and shadow projections are introduced.

## Rejected alternatives

- **Patch the current merge winner rules:** cannot make a destructive merge reversible.
- **Treat OpenWA participant `number` as a phone:** observed LID records disprove that semantic.
- **Make group-participant names contact-global:** leaks an observation from one membership into
  unrelated memberships and makes sync order authoritative.
- **Join Contacts during member reads:** couples pagination/search latency to resolution state.
- **Fan out every inbound observation synchronously:** serializes webhook traffic and group sync by
  session.
- **Big-bang replacement:** makes rollback and mismatch diagnosis unsafe for the current staging data.

## Delivery and acceptance gates

Delivery follows additive phases: correctness fixes, schema, identity dual-write/backfill, staged
snapshots, shadow resolver, durable projection, additive API, WA Studio migration, then removal of old
writes in a later release.

Every commit must build and pass its relevant unit/integration tests. Before authoritative cutover:

- every synchronized member has one exact identity in its own session;
- no LID user-part is materialized as a resolved phone;
- evidence permutations produce identical resolutions;
- conflicting evidence can split a previously resolved cluster;
- name precedence is independent of producer arrival order;
- repeated inbound observations are coalesced and webhook processing is not blocked by fan-out;
- member search, count, ordering and pagination remain database-side and deterministic;
- staging baselines for sync duration, projection lag, API latency, database growth and memory remain
  within the release thresholds recorded for the rollout.
