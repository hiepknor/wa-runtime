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

Campaign targets are replaced atomically. Target IDs must be unique group JIDs ending in `@g.us`,
must belong to the campaign's session and must exist as active groups. A draft may retain denied or
unknown groups so clients can show them and preflight can explain the problem.

Supported schedules:

- `IMMEDIATE`: run as soon as preparation succeeds;
- `ONCE`: requires `scheduledAt`; preparation happens immediately and dispatch waits until due.

## Preflight

Preflight policy version 1 evaluates five checks:

| Check | Blocks when |
| --- | --- |
| `CONTENT_VALID` | Text is blank or exceeds 4096 characters. |
| `TARGETS_VALID` | No group is selected. |
| `SESSION_SENDABLE` | Session is not ready, engine is not loaded or the account is restricted. |
| `GROUP_CAPABILITY` | For `LIVE`, any group is denied or unknown. It is only a warning for `DRY_RUN`. |
| `LIVE_SEND_ALLOWED` | Execution is `LIVE` while `ALLOW_LIVE_SENDS=false`. |

The result is `PASS`, `WARN` or `BLOCK`. `DRY_RUN` may proceed with capability warnings and never
calls OpenWA's send endpoint. A run with a blocking result enters `BLOCKED` without message jobs.

## Creating a run

`POST /api/v1/campaigns/{id}/runs` requires an `Idempotency-Key` and an execution mode. The Runtime
atomically creates the run and snapshots:

- campaign text;
- session ID and scheduled time;
- selected group IDs and names;
- each group's capability, reason and revision.

Repeating the same key and mode returns the existing run. Reusing the key with a different mode
returns HTTP 409.

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

### Resume

`POST /campaign-runs/{id}/resume` accepts `PAUSED` or `BLOCKED`. It reruns preflight and refreshes
capability snapshots only for work that has not started. A still-blocked run remains `BLOCKED` and
returns HTTP 409 with the current preflight report.

### Cancel

`POST /campaign-runs/{id}/cancel` accepts any non-terminal run. It creates missing delivery audit
rows, marks pending targets cancelled, and cancels linked message jobs that are still scheduled or
queued. Processing and already accepted messages cannot be recalled.

## Recovery

PostgreSQL contains enough state to resume after process or Redis interruption:

- `PREPARING` runs are re-enqueued for preparation;
- due `SCHEDULED` runs are activated;
- `RUNNING` runs continue materializing pending deliveries;
- delivery state is reconciled from durable message jobs;
- stale queued message jobs return to scheduled state.

Operators should restart services normally and inspect run progress before attempting any manual
database change.
