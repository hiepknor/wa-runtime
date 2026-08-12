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
- `POST /campaigns/{id}/runs`.

Keys describe one operator intent and should be stable across HTTP retry, timeout and client
restart. Do not generate a new key merely because the response was lost. Reusing a campaign-run key
with a different execution mode returns HTTP 409.

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

GET  /groups?sessionId={sessionId}
GET  /groups/{id}?sessionId={sessionId}
GET  /groups/{id}/members?sessionId={sessionId}&limit=50&offset=0&query={search}
POST /groups/{id}/refresh-capability?sessionId={sessionId}
GET  /messages?sessionId={sessionId}&groupId={groupId}
```

Session and group reads come from the Runtime's durable read model, not a synchronous pass-through
to OpenWA. Group detail contains metadata only; synchronized members are fetched separately with
database-backed pagination and optional literal substring search across display name, phone number
and participant ID. Member results are ordered deterministically, and `meta.total` counts matching
synchronized member rows rather than the group's upstream participant count. Full sync and
capability refresh endpoints are asynchronous.

#### Group-member coordinated release gate

The Runtime release that removes `GroupDetailDto.members` must not be deployed until every WA
Studio client in the release has regenerated its Runtime client, reads members exclusively from
`GET /groups/{id}/members`, and passes pagination/search integration tests. The release record must
link the corresponding WA Studio change. If those conditions cannot be met, hold this Runtime
release and use an API v2 or a time-bounded compatibility contract instead.

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
or campaign progress.

## Pagination and polling

List responses use:

```json
{
  "data": [],
  "meta": { "total": 0, "limit": 50, "offset": 0 }
}
```

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
