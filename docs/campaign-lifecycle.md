# Campaign lifecycle

## Model

A campaign is an editable definition containing one session, text content, a schedule and selected
group targets. A campaign run is an immutable execution snapshot. A campaign delivery is the
outcome for one target group within a run.

```text
Campaign (editable)
  -> CampaignRun (immutable payload + target snapshot)
       -> CampaignDelivery (one per group)
            -> MessageJob (created only when materialized)
```

Editing a campaign never modifies an existing run.

## Group send capability

Every active group has one capability status:

| Status | Meaning |
| --- | --- |
| `ALLOWED` | Current metadata supports sending. |
| `DENIED` | Current metadata proves sending is not permitted. |
| `UNKNOWN` | The Runtime needs refreshed metadata or could not establish permission. |

Important reasons include `SEND_ALLOWED`, `GROUP_READ_ONLY`, `ADMIN_ONLY`,
`ADMIN_STATUS_UNKNOWN`, `METADATA_INCOMPLETE`, `GROUP_CHANGED`, `REFRESH_FAILED` and
`GATEWAY_PERMISSION_DENIED`.

Group join, leave and update events invalidate capability. A manual refresh marks the group unknown
and schedules a targeted OpenWA detail read. Responses carry an expected revision so a stale refresh
cannot overwrite a newer group event.

## Draft and targets

Campaign targets are replaced atomically, either from explicit group IDs or by applying one exact
saved-list membership revision. Target IDs must be unique group JIDs ending in `@g.us`,
must belong to the campaign's session and must exist in the durable group read model. Inactive,
denied and unknown groups may be retained so clients can show them and preflight can explain the
policy result. Replacement rejects duplicate IDs and more than 1,000 unique IDs. It validates the
whole input before changing any row and returns the canonical complete list ordered by group name
then group ID.

Supported schedules:

- `IMMEDIATE`: run as soon as preparation succeeds;
- `ONCE`: requires `scheduledAt`; preparation happens immediately and dispatch waits until due.

Create defaults an omitted `scheduleType` to `IMMEDIATE`. Its canonical `scheduledAt` is null.
`ONCE` timestamps must be valid future ISO-8601 values at create or when scheduling is edited. A
content-only PATCH preserves the stored schedule, even after the scheduled instant has elapsed;
changing `ONCE` to `IMMEDIATE` clears `scheduledAt`. PostgreSQL stores `timestamptz`, and API
responses serialize timestamps in UTC.

Campaign content/schedule changes advance `revision`; target-set changes independently advance
`targetsRevision`. Material no-op writes do not advance either counter. These revisions bind a
preflight result to the definition it checked. PATCH accepts optional `expectedRevision`, while target
replacement accepts optional `expectedTargetsRevision`; stale values return typed HTTP 409 without a
write. Legacy omission remains accepted, but Runtime still protects the request's read/write window
with an internal compare-and-swap predicate. Target list and replacement responses include the
canonical `targetsRevision` represented by their complete target data.

Saved-list application locks the DRAFT campaign and saved list in one transaction, validates session
scope and optional target/membership revision preconditions, then materializes a campaign-owned target
snapshot. The response returns nullable source provenance with list ID, membership revision and apply
time as part of the same atomic operation. Subsequent target reads use one repeatable-read snapshot
for campaign revision, provenance and target data. Editing, renaming or archiving the list
does not propagate. Manual target replacement clears provenance. A run snapshots the provenance for
audit but never resolves the mutable saved list during preflight or delivery.

The source is deliberately binary current-state provenance rather than a change history. Non-null
provenance means the current target set exactly matches the recorded list membership revision; null
means the set is custom. Campaigns and runs snapshot the list name as presentation metadata, so later
list rename or archive cannot rewrite audit output.

## Preflight

Preflight policy version 2 evaluates five checks. Version 2 treats invalidated capability snapshots
as stale/unknown even when their last stored status was `ALLOWED`.

| Check | Blocks when |
| --- | --- |
| `CONTENT_VALID` | Text is blank or exceeds 4096 characters. |
| `TARGETS_VALID` | No group is selected. |
| `SESSION_SENDABLE` | Session is not ready, engine is not loaded or the account is restricted. |
| `GROUP_CAPABILITY` | For `LIVE`, any group is denied or unknown. It is only a warning for `DRY_RUN`. |
| `LIVE_SEND_ALLOWED` | Execution is `LIVE` while `ALLOW_LIVE_SENDS=false`. |

The result is `PASS`, `WARN` or `BLOCK`. `DRY_RUN` may proceed with capability warnings and never
calls OpenWA's send endpoint. A run with a blocking result enters `BLOCKED` without message jobs.
Standalone `POST /campaigns/{id}/preflight` is read-only for both `DRY_RUN` and `LIVE`: it does not
create a campaign run, run target, delivery or message job and does not enqueue or call a send
adapter. `BLOCK` takes precedence over `WARN`, which takes precedence over `PASS`. Target issue
reasons are stable `TARGET_CAPABILITY_DENIED`, `TARGET_CAPABILITY_UNKNOWN` or
`TARGET_CAPABILITY_STALE` codes; an invalidated capability is treated as unknown even when its stored
status was previously allowed. The underlying capability remains a separate field. Reports include
the campaign and target revisions they checked.
Preparation and resume compare observed capability revisions again before committing the decision.
A changed revision causes a retry/conflict rather than applying stale policy, and preparation churn
does not consume the operational failure-attempt budget.

## Reusable staging fixture

Use one dedicated staging session and one stable UUID idempotency key. The reset command creates the
draft once, then resets content, immediate scheduling and the complete target set without creating a
run or sending a message:

```bash
CAMPAIGN_FIXTURE_RUNTIME_URL=https://wa-runtime-staging.example \
CAMPAIGN_FIXTURE_RUNTIME_KEY=... \
CAMPAIGN_FIXTURE_SESSION_ID=... \
CAMPAIGN_FIXTURE_IDEMPOTENCY_KEY=... \
CAMPAIGN_FIXTURE_GROUP_IDS=first@g.us,second@g.us \
npm run campaign:fixture:reset
```

The fixture campaign must remain `DRAFT`; if another workflow changes its status, provision a new
dedicated fixture key rather than modifying status directly.

## Creating a run

`POST /api/v1/campaigns/{id}/runs` requires an `Idempotency-Key` and an execution mode. The Runtime
atomically creates the run and snapshots:

- campaign text;
- session ID and scheduled time;
- selected group IDs and names;
- each group's capability, reason and revision.
- optional saved-list source provenance for the materialized target set.

Repeating the same key and mode returns the existing run. Reusing the key with a different mode
returns HTTP 409.

A campaign is one live send plan. While `DRAFT`, it may create multiple DRY_RUN snapshots without a
status change. The first LIVE launch atomically changes the campaign to `ACTIVE`. Release A enforces at
most one LIVE run in the repository transaction and audits historical drift; after that gate is clean,
Release B adds the database unique index as the final invariant. New launches may send optional expected
campaign/target revisions, and stale values return HTTP 409. A LIVE `ONCE` launch whose scheduled
instant has passed is rejected. Idempotent replay of the winning key is checked before lifecycle
rejection and therefore remains safe after launch.

## Campaign deletion

`DELETE /campaigns/{id}` removes a quiescent campaign from active workspace reads by writing a
`deleted_at` tombstone. It requires `expectedRevision` and `expectedTargetsRevision`. The campaign
must be `DRAFT` or `ARCHIVED`, and every DRY_RUN or LIVE run must already be terminal. `ACTIVE` and
`PAUSED` campaigns require LIVE cancellation; non-terminal DRY_RUNs require their own cancellation.

Deletion leaves campaign targets and immutable run/delivery/message-job evidence intact. Direct run
reads remain available until normal operational retention. Repeating DELETE returns HTTP 204, while
replaying the Campaign create idempotency key returns `CAMPAIGN_IDEMPOTENCY_KEY_RETIRED` rather than
resurrecting or returning the hidden Campaign.

## Run states

```text
PREPARING -> BLOCKED
     |
     +----> SCHEDULED -> RUNNING -> COMPLETED
                         |    |
                         |    +--------> PARTIAL_FAILED
                         +-------------> PAUSED -> RUNNING

PREPARING | BLOCKED | SCHEDULED | RUNNING | PAUSED -> CANCELLED
PREPARING -> FAILED  (preparation exhausted all retries)
```

`statusReason` explains operational transitions such as `PREFLIGHT_BLOCKED`, `MANUAL_PAUSE`,
`SESSION_NOT_SENDABLE`, `CANCELLED_BY_OPERATOR`, `PREPARATION_FAILED` and
`ONE_OR_MORE_DELIVERIES_FAILED`.

When a live run loses session sendability, the scheduler automatically pauses new materialization.
Already buffered jobs may finish. Resume always runs current preflight again.

## Delivery states and progress

```text
PENDING -> MATERIALIZED -> PROCESSING
                         -> DRY_RUN_COMPLETED
                         -> ACCEPTED -> SENT -> DELIVERED -> READ
                         -> FAILED | UNKNOWN
PENDING -> BLOCKED_CAPABILITY_CHANGED
PENDING/MATERIALIZED -> CANCELLED
```

`ACCEPTED` means OpenWA accepted the send call; later webhooks can advance it to `SENT`, `DELIVERED`
or `READ`. The campaign is considered dispatch-complete once no delivery remains in `PENDING`,
`MATERIALIZED` or `PROCESSING`. Any failed, unknown, capability-blocked or cancelled delivery makes
the final run `PARTIAL_FAILED`; otherwise it becomes `COMPLETED`.

The run response exposes counts for every delivery state. Clients should render these server counts
and must not derive authoritative progress from locally cached rows.

## Controls

### Pause

`POST /campaign-runs/{id}/pause` accepts `SCHEDULED` or `RUNNING`. It prevents new delivery
materialization but does not claim to recall jobs already processing.
Pausing a LIVE run also changes its campaign to `PAUSED`; DRY_RUN controls do not change campaign
status.

### Resume

`POST /campaign-runs/{id}/resume` accepts `PAUSED` or `BLOCKED`. It reruns preflight and refreshes
capability snapshots only for work that has not started. A still-blocked run remains `BLOCKED` and
returns HTTP 409 with the current preflight report.
Successful LIVE resume changes the campaign to `ACTIVE`; a blocked resume leaves the campaign
`PAUSED`.

### Cancel

`POST /campaign-runs/{id}/cancel` accepts any non-terminal run. It creates missing delivery audit
rows, marks pending targets cancelled, and cancels linked message jobs that are still scheduled or
queued. Processing and already accepted messages cannot be recalled.
Cancelling a LIVE run archives its campaign. LIVE completion, partial failure or exhausted
preparation retries also archive the one-send plan; detailed outcome remains on the immutable run.

## Recovery

PostgreSQL contains enough state to resume after process or Redis interruption:

- `PREPARING` runs are re-enqueued for preparation;
- due `SCHEDULED` runs are activated;
- `RUNNING` runs continue materializing pending deliveries;
- delivery state is reconciled from durable message jobs;
- stale queued message jobs return to scheduled state.

Operators should restart services normally and inspect run progress before attempting any manual
database change.

Before the Release B single-LIVE index, inspect aggregate lifecycle drift with:

```bash
npm run campaign:lifecycle:audit
```

The command returns non-zero while drift or duplicate LIVE runs remain. After Release A is running and
launches are quiesced, unambiguous campaign-status drift can be repaired transactionally with:

```bash
npm run campaign:lifecycle:reconcile
```

Reconciliation never resolves duplicate LIVE runs automatically. Their immutable run records require
operator investigation and an explicit incident decision before the unique index may be deployed.
