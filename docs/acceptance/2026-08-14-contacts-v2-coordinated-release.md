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

## Runtime staging evidence

Runtime implementation commits: `c696e5d` through `c84de86` inclusive. Staging image:
`wa-runtime:c84de86` (corrective commit after the initial `9685e46` shadow rollout). The committed
OpenAPI artifact in `c84de86` is the Runtime contract artifact under test; the corrective commit did
not change the public contract.

Verified without enabling projection reads:

- migrations 021–028 applied and readiness stayed healthy with live sends disabled;
- evidence backfill completed after scanning 535,388 historical membership rows; all 535,387 rows
  present at completion had an evidence identity (one row changed concurrently during the scan);
- restarting the scheduler during the bounded backfill preserved the keyset cursor and did not
  restart the job;
- the first resolution attempt exposed an unbounded name-ranking plan: it exceeded eight minutes,
  crossed the five-minute scheduler warning threshold and was cancelled before cutover;
- `c84de86` materializes the eligible name observations before deterministic selection and scopes
  resolution/projection claims to `OPENWA_ALLOWED_SESSION_IDS`;
- the same staging dataset then resolved 25,530 identities into 24,271 clusters, with 2,518 linked
  identities and zero conflicts, in approximately 72 seconds;
- the next published generation resolved 25,594 identities into 24,320 clusters, with 2,548 linked
  identities and zero conflicts;
- projection queue metrics distinguish eligible work from 23,541 inactive historical-session jobs;
  inactive work remained unchanged while eligible work progressed.
- with `CONTACT_PROJECTION_MAX_JOBS_PER_TICK=100`, projection completed 100 jobs per tick without
  failures; observed PostgreSQL CPU was approximately 28% and scheduler memory approximately 50 MiB
  during an isolated sample;
- a 20-request largest-group member-page benchmark under projection load returned 20/20 HTTP 200;
  direct Runtime latency was p50 9.97 ms and p95 17.98 ms. The same calls through the staging HTTPS
  edge were p50 77.78 ms and p95 126.00 ms, so edge/network latency is reported separately from the
  sub-50-ms application gate;
- the second FULL sync used to publish a projection-aware generation encountered upstream HTTP 429;
  contact snapshot publication and resolution completed, but the group-sync run has terminal item
  failures and is not accepted as a clean full-sync smoke result.
- a mixed-mode read canary traversed all 1,933 records in the largest observed group in ten pages:
  1,933 unique participant identities, zero duplicates/missing rows, byte-stable repeated page 0 and
  a non-zero dataset revision; page 0 deliberately contained both projected and revision-zero
  fallback rows;
- default/custom pagination, display-name/phone/participant search, whitespace query, empty result,
  out-of-range offset, invalid limit/offset, missing group and cross-session 404 behavior passed;
- group detail remained free of embedded members and both deprecated compatibility fields and the
  additive v2 identity fields remained present;
- the staging read switch was returned to `false`; the rollback page remained healthy with the same
  total and `datasetRevision=0`, while legacy fan-out stayed enabled.
- synchronous legacy fan-out was then disabled temporarily with reads still on legacy; 5,414 member
  rows fenced to projection jobs completed during that window had zero shadow-vs-legacy mismatches.
  Readiness stayed healthy, after which legacy fan-out was restored to `true`.

The coordinated gate remains pending while the eligible projection backlog drains, API/failure
smoke tests run and the WA Studio commit is recorded. The staging read switch remains disabled and
legacy fan-out remains enabled.

## Staging gates

- member evidence backfill and projection bootstrap complete, followed by a newer completed
  resolution generation, with zero unprojected linked member rows;
- zero LID user-parts in `shadow_resolved_phone_number`;
- zero failed projection work and projection lag p95 below 30 seconds;
- aggregate shadow-vs-legacy mismatch explained by v2 semantics;
- member API p95 below 50 ms for the largest observed group;
- stable pagination/search/count and session-isolation smoke tests pass;
- inbound webhook processing remains successful with synchronous member fan-out disabled;
- rollback to legacy reads is exercised while the async worker mirrors legacy columns.

Runtime staging evidence: **IN PROGRESS**.
Release status: **PENDING**.
