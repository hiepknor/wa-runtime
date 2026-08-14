# Contacts v2 coordinated release — PENDING

This record gates the additive WA Runtime member-identity contract and WA Studio adoption. It must
remain `PENDING` until the shadow pipeline is enabled on staging, the checks below pass and the exact
WA Studio commit is recorded. Do not enable projection reads or disable legacy fan-out in production
from this document alone.

## Runtime contract

`GET /api/v1/groups/{groupId}/members` retains `participantId`, deprecated `phoneNumber`,
`displayName`, `isAdmin` and `isSuperAdmin`, and adds:

- `identityType`: `LID`, `PHONE_JID`, `OTHER_JID` or null;
- `resolvedPhoneNumber`: verified/resolved digits or null;
- `displayNameSource`: contact, membership, exact push or resolved-alias push provenance;
- `projectionRevision`: monotonic row revision, with zero denoting legacy fallback;
- `meta.datasetRevision`: highest projection revision in the group.

The endpoint remains database-paginated and server-searchable. Runtime never treats a LID user-part
as a phone number. `displayName` remains nullable.

## WA Studio handoff

1. Copy the committed Runtime OpenAPI snapshot and regenerate the TypeScript client with WA Studio's
   standard contract command; do not hand-edit generated types.
2. Prefer `resolvedPhoneNumber` for a phone label. If it is null, show `participantId` or an explicit
   unresolved identity state; never reinterpret `phoneNumber` for `identityType=LID`.
3. Continue using Runtime `displayName` and server-side `query`; do not join or infer Contacts in the
   desktop client.
4. Treat `displayNameSource` as provenance, not text to display as a contact name.
5. Record `meta.datasetRevision` when loading page 0. If it changes on a later page, restart at page 0
   or clearly indicate that enrichment changed; do not merge pages from different revisions.
6. Preserve current group/session cancellation and out-of-order response guards.
7. Add tests for nullable names/phones, LID identity, verified phone-JID resolution, alias-name source,
   revision change between pages, search after enrichment, and compatibility with extra response
   fields.

WA Studio commit: **PENDING**.

## Staging gates

- projection bootstrap complete and zero unprojected linked member rows;
- zero LID user-parts in `shadow_resolved_phone_number`;
- zero failed projection work and projection lag p95 below 30 seconds;
- aggregate shadow-vs-legacy mismatch explained by v2 semantics;
- member API p95 below 50 ms for the largest observed group;
- stable pagination/search/count and session-isolation smoke tests pass;
- inbound webhook processing remains successful with synchronous member fan-out disabled;
- rollback to legacy reads is exercised while the async worker mirrors legacy columns.

Runtime staging evidence: **PENDING**.
Release status: **PENDING**.
