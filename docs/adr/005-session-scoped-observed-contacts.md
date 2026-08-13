# ADR 005: Session-scoped observed contacts and identity resolution

- Status: Accepted
- Date: 2026-08-14
- Builds on: ADR 003 and ADR 004

## Context

WA Runtime synchronizes every group participant into `group_members`, but OpenWA 0.16.0 frequently
returns a nullable participant name and an unresolved WhatsApp LID. In the measured staging dataset,
all group-participant names were absent, while the separate OpenWA contact store could enrich most
phone-JID participants and only a small fraction of unique LID participants.

The Baileys contact store is an event-fed, bounded observation cache. It receives contacts, names and
LID-to-phone evidence from contact events, history synchronization and message traffic; it is not a
complete mirror of the account owner's phone address book. Its absence semantics are therefore not
authoritative. OpenWA may also know the same person through several identifier dialects, and a LID's
numeric user-part is explicitly not a phone number.

WA Runtime needs a durable contact model so observed names can enrich synchronized members without
adding per-member upstream reads, read-time contact joins or cross-session identity leakage.

## Decision

1. WA Runtime owns a session-scoped **observed contacts** read model. It guarantees an identity record
   for every synchronized group member, not a non-null phone number or display name for every contact.
2. A logical contact has one or more identifiers. Identifiers are unique only inside a session and
   are typed as LID, phone JID, phone number or another JID.
3. Identifiers are linked only by authoritative evidence observed in one session. Runtime never
   derives a phone number from a LID user-part, merges by display name, or consumes a global
   cross-session LID mapping as authoritative evidence.
4. Contact names retain their source. The initial deterministic precedence is OpenWA contact name,
   group-participant name, OpenWA push name, then null. OpenWA 0.16.0's contact `name` is recorded as
   `OPENWA_CONTACT_NAME`; Runtime does not claim whether Baileys obtained it from an address-book or
   verified-business field.
5. Names are trimmed, empty values become null and valid Unicode spelling/case is preserved. A phone,
   JID or LID is not synthesized into a display name.
6. Group synchronization seeds contact identities in bounded database batches. OpenWA contacts are
   ingested in bounded pages, once per session contact refresh, never once per group member.
7. An OpenWA contact listing is an `OBSERVED` snapshot. A missing record does not delete a durable
   contact, identifier or name. Retention or deletion requires a separately reviewed policy.
8. Contact synchronization is enrichment. A contact read failure does not fail authoritative group
   reconciliation, and the previous successfully observed contact data remains usable.
   Full-sync and periodic contact refreshes share a PostgreSQL generation/lease fence per session.
9. The effective member display name is materialized in `group_members`. Member search, count,
   deterministic ordering and pagination remain database-side and do not join or fetch contacts on
   the request path.
10. Group-member identity remains the gateway participant ID. A nullable internal contact link is
    additive and does not replace the public participant identity or return contacts from group
    detail.
11. All contact tables, constraints, queries, jobs and caches include `session_id`. Contact names and
    identifiers are PII and must not appear in logs, metric labels or notification payloads.
12. Public Contacts endpoints are deferred until the read model, merge behavior and observed-snapshot
    lifecycle pass staging. The existing group-member contract remains unchanged during the initial
    rollout.
13. Inbound message `contact.pushName` may update `OPENWA_PUSH_NAME` behind an independent feature flag.
    Runtime persists neither the raw webhook contact object nor message-derived identity links; failure
    of this optional enrichment does not poison the durable message webhook.

## Data model

The initial schema contains:

- `contacts`, keyed by `(session_id, id)`, for the logical contact and effective name;
- `contact_identifiers`, keyed by `(session_id, identity_type, identity_value)`, for observed aliases;
- `contact_names`, keyed by `(session_id, contact_id, name_source)`, for source-specific names;
- `contact_sync_state`, keyed by `session_id`, for observed snapshot generation and status;
- additive `group_members` columns for the contact link, raw participant name and effective-name
  provenance.

The schema uses text check constraints rather than PostgreSQL enums so future source types can be
added through an additive migration without altering an enum in place. Foreign keys use composite
session keys so the database also enforces tenant isolation.

## Identity linking

Every group participant seeds one identifier. Phone JIDs normalize to the neutral `@c.us` dialect;
LIDs remain first-class unresolved identifiers. A separate phone identifier is added only when the
upstream value is a validated phone number rather than the participant's LID user-part.

An OpenWA contact may contribute a contact ID, a normalized phone JID, a phone number and names.
Identifiers carried by the same validated upstream record are authoritative evidence for linking.
If this evidence joins two existing logical contacts, the older contact wins, with UUID as the final
deterministic tie-breaker. The merge and all member repoints occur in one transaction.

## Name materialization

`group_members.participant_display_name` preserves the normalized raw group source. The existing
`display_name` column remains the public effective value. Contact-name changes recompute affected
members in database batches and update only rows whose effective value or source changed.

Materialization intentionally means a contact refresh can move a member between offset pages because
the ordered data changed. Within an unchanged snapshot, the existing participant-ID tie-breaker keeps
ordering deterministic. Enrichment is never performed inside a member-list request.

## Consequences

- Runtime can account for 100 percent of synchronized member identities while honestly retaining
  nullable phone and display-name attributes.
- Existing member payloads and OpenAPI contracts remain compatible; clients only observe improved
  names and search results.
- Contact ingestion and identity merging add PostgreSQL state, PII obligations and one-time backfill
  work. Materialized names duplicate a small value across repeated group memberships to keep reads
  simple and bounded.
- LID and display-name coverage remains limited by evidence OpenWA/Baileys actually observes. Runtime
  reports coverage rather than treating missing upstream attributes as a failure.
- A previous Runtime binary ignores the additive tables and columns. Once new code writes enriched
  display names, application rollback preserves those values; operational rollback prefers a forward
  fix and never reverses an applied migration in place.

## Rejected alternatives

- **Map only group participant names:** already supported, but measured coverage is zero.
- **Fetch a contact or resolve a phone for each member:** creates prohibited N+1 upstream traffic and
  does not make unknown LIDs resolvable.
- **Join contacts during member reads:** complicates identical page/count predicates and makes ordering
  change during lazy enrichment.
- **Use the LID user-part as a phone:** violates the WhatsApp identity contract and can address the
  wrong account.
- **Merge contacts with the same name:** names are neither unique nor stable.
- **Replace all contacts from one OpenWA listing:** Baileys exposes a bounded observation cache, so
  absence is not deletion evidence.
- **Enable full history as the design:** it raises upstream, memory and storage cost without a
  completeness guarantee.

## Rollout

1. Record baseline coverage, full-sync duration, memory and database size.
2. Apply the additive schema with ingestion disabled.
3. Seed identities from synchronized members and backfill existing members. Require a 100 percent
   member-to-contact link ratio for the selected staging session.
4. Enable bounded OpenWA contact snapshots and measure coverage separately for LID and phone JID.
5. Enable effective-name materialization and verify search, count, ordering and page latency.
6. Enable message/contact-event enrichment only after identity merge behavior is stable.
7. Add a public Contacts API only under a separate contract review.

Each producer and materializer has an independent configuration switch. Disabling a producer keeps
already observed data intact. Applied migrations remain forward-only.

## Acceptance gates

- Every synchronized group-member row links to a contact in the same session.
- Re-running group or contact synchronization is idempotent and does not create duplicate logical
  contacts.
- Tests prove that identical identifiers in different sessions never link or enrich each other.
- No code derives a phone from an unresolved LID or merges identities by name.
- Contact ingestion uses bounded pages and database batches with no per-member network calls.
- Contact snapshot failure leaves group reconciliation successful and preserves previous observations.
- Group reconciliation with a null participant name does not erase a richer contact-derived name.
- Member response memory remains proportional to `limit`; search and filtered total remain database-side.
- Existing group list, detail, member pagination, capability and durable-sync tests pass.
- Metrics contain aggregate identity type/source counts and no raw names, phones or WhatsApp IDs.
