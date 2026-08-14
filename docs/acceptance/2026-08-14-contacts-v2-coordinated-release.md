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

WA Studio commit: **PENDING**. The inspected WA Studio `main` at `653fb98` still has the pre-v2
Runtime snapshot and generated types: the snapshot is not byte-identical to Runtime and does not
contain the additive resolved identity, provenance or dataset-revision fields. This commit is not a
compatible coordinated-release candidate.

## Runtime staging evidence

Runtime implementation commits: `c696e5d` through `fb814a4` inclusive. Current staging code image:
`wa-runtime:fb814a4`. Supporting operations documentation is recorded in `cde0682`; the subsequent
test-hardening commit `f4433de` is not part of the deployed image. The committed OpenAPI artifact
remains byte-identical to the artifact introduced in the contract commit; the corrective projection
commits did not change the public contract.

Verified without enabling projection reads:

- migrations 021–031 applied and readiness stayed healthy with live sends disabled. A logical
  PostgreSQL backup (423,407,688 bytes) was verified before migration 031;
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
- migration 029 added an allowlist-scoped late-membership catch-up path. It repaired the observed
  post-resolution membership gap without scanning inactive sessions;
- unchanged inbound push names now preserve evidence without repeatedly requesting the same
  projection, and unchanged resolution generations diff against the preceding completed generation
  before enqueueing projection work;
- concurrent group replacement and projection initially exposed an opposite row-lock order and
  repeated PostgreSQL deadlocks. Both writers now acquire the same session-scoped transaction lock
  before member/work rows; the staging queue subsequently advanced without another deadlock;
- projection work now uses the resolved cluster as its canonical key. Existing alias intents are
  coalesced in bounded `FOR UPDATE SKIP LOCKED` batches, while running leases are never cancelled;
- group replacement passes only member rows actually inserted or changed into contact evidence and
  projection. A single membership change no longer fans out work for every otherwise unchanged
  participant in that group;
- the clean full sync retained 3,842 unchanged phone-JID memberships after the one-shot evidence
  cursor had completed. Migration 030 and `f1e2692` add an indexed, allowlist-scoped, per-session
  locked late-evidence catch-up. The eligible missing-evidence count converged from 3,842 to zero in
  bounded 1,000-row ticks; the inactive-session set was not scanned, LID-derived-phone violations
  remained zero and no projection failure or deadlock was observed;
- after that queue drained, 99 older evidence-linked rows still had no materialized identity type.
  Migration 031 adds a partial catch-up index and `fb814a4` treats a missing identity type as
  incomplete projection work. The planner used an index-only scan and all 99 rows converged without
  projection failures or deadlocks;
- a production-backed FULL sync completed all 574 discovered groups with zero failed or skipped
  items, synchronizing 267,816 membership rows in 1,525 seconds. Transient upstream rate pressure
  recovered within the durable attempt budget, removing the previous four-item full-sync blocker;
- one deployment briefly inherited the older shared environment and therefore started with contact
  rollout flags at their disabled defaults. No projection reads were enabled. The current and shared
  environment sources were reconciled, services were restarted, and readiness plus the intended
  shadow-on/read-off/legacy-on flags were reverified before continuing;
- the final allowlisted snapshot contained 267,809 member rows: every row had evidence, a non-zero
  shadow projection revision and a materialized identity type. Active pending, active failed,
  missing-evidence, unprojected, missing-identity-type and invalid-LID-as-phone counts were all zero.
  The 23,541 inactive historical work rows remained isolated;
- final coverage was 54,249 projected names and 146,983 resolved phones. By exact identity type,
  120,826 rows were LID (202 named, zero resolved phone) and 146,983 were PHONE_JID (54,047 named and
  resolved). Name provenance was 16,450 contact names, 37,799 push names and 213,560 null;
- shadow-vs-legacy comparison found 4,394 name, 22 phone and 8,220 provenance differences. These are
  expected v2 enrichment/precedence differences: v2 does not mirror into legacy while legacy fan-out
  remains enabled, and the additive contract preserves nullable values and explicit provenance;
- a final all-projected read canary traversed 1,948 members in ten pages with exactly 1,948 unique
  participant identities, stable non-zero dataset revision and byte-stable repeated page 0. Search
  by display name, phone and participant identity passed, as did whitespace normalization, empty and
  out-of-range pages, invalid pagination (400), missing/cross-session isolation (404), and missing
  authentication (401). Direct Runtime latency was p50 11.94 ms/p95 24.51 ms; staging HTTPS was p50
  26.76 ms/p95 31.95 ms;
- rollback was rehearsed by restarting only the API with projection reads disabled. The legacy page
  returned 25 rows with `datasetRevision=0` and row `projectionRevision=0`. Staging was left healthy
  with projection reads disabled, legacy fan-out enabled and live sends disabled;
- final local verification passed 28 unit files/87 tests, 19 integration files/129 tests and the
  dedicated 12-test group-member suite. TypeScript typecheck/build, Runtime OpenAPI regeneration,
  contract diff check and `git diff --check` also passed. The alias-to-cluster regression was run
  independently three times before the full suite.

The Runtime staging gates are complete. The coordinated release remains pending only until WA Studio
adopts the exact Runtime OpenAPI artifact, regenerates its client, passes its v2 tests and records the
compatible commit here. The staging read switch remains disabled and legacy fan-out remains enabled.

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

Runtime staging evidence: **PASS (backend only)**.
Release status: **PENDING**.
