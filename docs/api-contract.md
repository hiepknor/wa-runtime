# API contract

## Source of truth

The public Runtime contract is generated from Nest controllers and DTOs under `src/contracts`:

```text
source DTO/controller -> contracts/runtime/v1/openapi.json -> platform-specific generated clients
```

The generated OpenAPI document is the integration contract for WA Studio and future desktop,
mobile, web and service consumers. It is not a promise that internal PostgreSQL, Redis, BullMQ or
OpenWA payload shapes are stable.

Swagger UI is enabled by default outside production and can be explicitly controlled with
`ENABLE_RUNTIME_DOCS`. In production, prefer distributing the committed OpenAPI file rather than
exposing interactive docs publicly.

## Base URL and authentication

The current base path is:

```text
/api/v1
```

All business endpoints require:

```http
X-Runtime-Key: <RUNTIME_API_KEY>
```

Health probes and the signed OpenWA webhook ingress are public by design. The webhook has its own
HMAC authentication and is excluded from Swagger.

The current static Runtime key is for development and trusted internal clients. A desktop client may
keep it in the operating system credential store during the initial phase. A browser application or
distributed mobile binary must never embed it: introduce user authentication with short-lived
tokens, authorization scopes and a trusted backend/access layer first. No client may persist an
OpenWA key in configuration, logs or local state.

## Idempotency

These creation endpoints require an `Idempotency-Key` header:

- `POST /message-jobs`;
- `POST /campaigns`;
- `POST /group-lists`;
- `POST /campaigns/{id}/runs`.

Keys describe one operator intent and should be stable across HTTP retry, timeout and client
restart. Do not generate a new key merely because the response was lost. Reusing a campaign-run key
with a different execution mode returns HTTP 409. Message-job keys are scoped separately from
campaign delivery keys and are bound to a request fingerprint; reusing one with different content,
recipient, schedule or execution mode also returns HTTP 409.
Campaign-create keys are UUIDs, are bound to the canonical trimmed payload and schedule, and return
the original draft with HTTP 200 on an exact replay. Reusing a key for another payload returns HTTP
409 `CAMPAIGN_IDEMPOTENCY_CONFLICT`.
Group-list-create keys are UUIDs bound to the canonical session, trimmed metadata and sorted initial
membership. Exact replay returns the original list with HTTP 200; another payload returns HTTP 409
`GROUP_LIST_IDEMPOTENCY_CONFLICT`.

## Endpoint groups

### Health

```text
GET /health/live
GET /health/ready
```

### Gateway sessions and groups

```text
GET  /sessions
GET  /sessions/{id}
POST /sessions/{id}/sync
GET  /sessions/{id}/sync-runs/{runId}

GET  /groups?sessionId={sessionId}&limit=50&offset=0&query={search}&capabilityStatus={statuses}&capabilityFreshness={freshness}&isActive={boolean}&minParticipants={integer}&maxParticipants={integer}
GET  /groups/{id}?sessionId={sessionId}
GET  /groups/{id}/members?sessionId={sessionId}&limit=50&offset=0&query={search}
POST /groups/{id}/refresh-capability?sessionId={sessionId}
GET  /messages?sessionId={sessionId}&groupId={groupId}
```

Session and group reads come from the Runtime's durable read model, not a synchronous pass-through
to OpenWA. Group list search is a trimmed, case-insensitive literal substring match across group
name, ID and description. `capabilityStatus` and `capabilityFreshness` are comma-separated arrays;
values within one parameter are ORed and different filter types are ANDed. `CURRENT` means
`sendCapability.invalidatedAt` is null and `STALE` means an invalidation is pending. Omitting
`isActive` preserves the active-only behavior. Group list results use name then group ID ordering,
and `meta.total` counts the complete filtered dataset before pagination. Participant-count bounds
are inclusive non-negative 32-bit integers, matching the persisted count type. When either bound is
present, records whose synchronized `participantsCount` is unknown do not match; zero is a valid
bound. Invalid bounds return HTTP 400 `GROUP_FILTER_PARTICIPANTS_INVALID`, while an inverted range returns
`GROUP_FILTER_PARTICIPANTS_RANGE_INVALID`.

Group detail contains metadata only; synchronized members are fetched separately with database-
backed pagination and optional literal substring search across display name, phone number and
participant ID. Member results are ordered deterministically, and `meta.total` counts matching
synchronized member rows rather than the group's upstream participant count. Neither group-list
search nor capability filtering joins or loads members. Full sync and capability refresh endpoints
are asynchronous.

Member rows add exact `identityType`, nullable `resolvedPhoneNumber`, `displayNameSource` provenance
and a monotonic `projectionRevision`. The legacy `phoneNumber` remains present but may contain a LID
user-part and must not be presented as a verified phone. `meta.datasetRevision` is a monotonic
group-level generation bumped by every committed member insert, update or delete; a change between
page requests tells clients to restart pagination if they require one stable dataset snapshot. A
value of zero denotes the legacy fallback before projection cutover. Search/count/order continue to
use the same materialized row and repeatable-read database snapshot; member reads never resolve
Contacts or call OpenWA.

#### Group-member coordinated release gate

The Runtime release that removes `GroupDetailDto.members` must not be deployed until every WA
Studio client in the release has regenerated its Runtime client, reads members exclusively from
`GET /groups/{id}/members`, and passes pagination/search integration tests. The release record must
link the corresponding WA Studio change. If those conditions cannot be met, hold this Runtime
release and use an API v2 or a time-bounded compatibility contract instead.

### Saved group lists

```text
GET    /group-lists?sessionId={sessionId}&query={search}&limit=50&offset=0
POST   /group-lists
GET    /group-lists/{id}
PATCH  /group-lists/{id}
DELETE /group-lists/{id}
GET    /group-lists/{id}/groups
PUT    /group-lists/{id}/groups
```

Saved group lists are session-scoped, static selections of at most 1,000 unique synchronized group
IDs. They are operator-owned resources, not fields on the OpenWA-derived group read model. Search is
a trimmed, case-insensitive literal substring match on list name and description with escaped SQL
wildcards. Active results use `updatedAt DESC, id ASC`; predicates run before pagination and
`meta.total` counts the filtered active dataset.

Create accepts optional initial membership and is atomic and idempotent. Complete membership reads
are intentionally bounded rather than paginated so a client can stage one unambiguous snapshot.
Replacement validates the whole set before writing, rejects duplicate, missing and cross-session
IDs, and increments `revision` only when membership changes. Current group name, active state,
participant count and send capability are returned for presentation; inactive, denied and unknown
groups remain valid members.

`DELETE` soft-archives a list. Archive and later list edits never alter campaign targets. Applying a
list to a campaign is a client authoring operation that copies IDs into the staged selection; the
existing campaign target replacement remains the only campaign persistence operation. Runtime does
not persist campaign-to-list provenance or live binding in v1.

Saved-list validation uses stable `GROUP_LIST_*` codes, including `GROUP_LIST_SESSION_INVALID`,
`GROUP_LIST_NAME_INVALID`, `GROUP_LIST_QUERY_INVALID`, `GROUP_LIST_GROUP_INVALID`, duplicate/limit,
missing-group, session-mismatch, name-conflict and idempotency errors. Clients must not parse the
human-readable message or expect invalid group IDs to be echoed in error details.

### Campaign definitions

```text
POST  /campaigns
GET   /campaigns
GET   /campaigns/{id}
PATCH /campaigns/{id}
GET   /campaigns/{id}/targets
PUT   /campaigns/{id}/targets
POST  /campaigns/{id}/preflight
POST  /campaigns/{id}/runs
GET   /campaigns/{id}/runs
```

Campaign lists accept optional `query`, `status` and `scheduleType` filters. `query` is trimmed and
performs a case-insensitive literal substring search on campaign name; a valid UUID also exact-
matches campaign ID. Message text is deliberately excluded. `status` and `scheduleType` use comma-
separated `form` arrays (`explode=false`): values within one filter are ORed and different filters
are ANDed. Empty filters are ignored. Predicates run before pagination, `meta.total` counts the
filtered dataset, and ordering is `updatedAt DESC, id ASC`.

Campaign create defaults `scheduleType` to `IMMEDIATE`, whose canonical `scheduledAt` is null.
`ONCE` requires a valid future ISO-8601 date-time; create or scheduling updates reject past times.
A content-only PATCH preserves scheduling, while changing back to `IMMEDIATE` clears the timestamp.
All timestamps are emitted as ISO-8601 UTC. Only `DRAFT` campaigns can be edited.

Campaign PATCH accepts optional `expectedRevision`, and target replacement accepts optional
`expectedTargetsRevision`. Saved-list metadata and membership mutations similarly accept optional
`expectedRevision`. Authorized stale writes return typed HTTP 409 responses and never overwrite the
newer aggregate state. Omitting the precondition remains backward-compatible, while Runtime still
uses an internal compare-and-swap fence against races during one request.

Target replacement rejects duplicates and more than 1,000 IDs, validates the complete set before
writing, and returns the complete canonical list ordered by group name then ID. Existing inactive,
denied and unknown groups may remain targets; preflight owns capability policy. Campaign responses
carry independent `revision` and `targetsRevision` counters. Preflight binds its result to both
counters, uses stable check/target-reason enums, and never creates a run, job or delivery.

### Campaign runs

```text
GET  /campaign-runs/{id}
GET  /campaign-runs/{id}/deliveries
POST /campaign-runs/{id}/pause
POST /campaign-runs/{id}/resume
POST /campaign-runs/{id}/cancel
```

### Low-level message jobs

```text
POST /message-jobs
GET  /message-jobs/{id}
```

Campaign management clients should use campaign-run endpoints. Low-level message jobs remain useful
for diagnostics and narrowly scoped automation, but they do not provide campaign target snapshots
or campaign progress. A low-level live job must target an active synchronized group with current
`ALLOWED` capability; the worker rechecks this policy immediately before delivery.

## Pagination and polling

List responses use:

```json
{
  "data": [],
  "meta": { "total": 0, "limit": 50, "offset": 0 }
}
```

Group-member pages additionally include `meta.datasetRevision`.

Use the limits declared in OpenAPI. Clients may poll sync runs and campaign runs, but should back off
when inactive or backgrounded and stop polling terminal states. Poll the run aggregate for progress;
fetch paginated deliveries for detail or failures. A future push transport may improve UX without
changing these authoritative read endpoints.

## Error handling

Clients should branch on HTTP semantics and display the server message:

- 400: malformed input or missing idempotency header;
- 401: absent or invalid Runtime key;
- 404: resource is absent or outside the allowed session scope;
- 409: idempotency conflict or invalid run-state transition;
- 5xx: transient Runtime/infrastructure failure; retry only idempotent reads or writes carrying the
  same idempotency key.

For blocked resume, HTTP 409 includes the current preflight report. Clients should show its checks
and target issues rather than reducing it to a generic failure toast.

## Compatibility rules

Changes allowed within `/api/v1`:

- add a new endpoint;
- add an optional request field;
- add a response field when consumers tolerate unknown fields;
- add documentation without changing behavior.

Changes requiring `/api/v2` or a coordinated migration:

- remove or rename a field or endpoint;
- make an optional request field required;
- change field meaning or type;
- remove an enum value;
- change idempotency or state-transition semantics incompatibly.

Adding enum values can break exhaustively generated clients even if JSON remains compatible. Treat
every enum addition as a reviewed consumer change.

## Review and generation

With host-reachable environment variables loaded:

```bash
npm run contract:generate
git diff -- contracts/runtime/v1/openapi.json
npm run contract:check
```

Each client project should generate a versioned client from the committed artifact and pin it to a
Runtime release. Do not duplicate DTOs manually across desktop, mobile or web repositories. Runtime
upgrades should first update each generated client in isolation, then compile and test every
supported consumer against it.
