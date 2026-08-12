# Group-member coordinated release — 2026-08-12

## Release scope

This record coordinates the breaking removal of `GroupDetailDto.members` from the Runtime `/api/v1`
contract with the WA Studio migration to the paginated group-member endpoint.

| Component | Release evidence |
| --- | --- |
| WA Runtime | Commit range `34d9faf..0f7afd3` (group-member feature through staging sync hardening) |
| WA Studio | Commit `764f078` (contains group-member migration, WA Runtime identity and the exact staging origin) |
| Runtime OpenAPI artifact | `contracts/runtime/v1/openapi.json` at `0f7afd3` |
| OpenAPI SHA-256 | `f27f61b0177861e71a309877b2f238e25e80a30358d827f671c0d5738a0b7a79` |

The identity, deployment and sync-recovery changes after the group-member implementation do not
change paths, schemas or endpoint semantics. The artifact at `0f7afd3` was compared byte-for-byte with the WA
Studio snapshot at `764f078`. This is the artifact deployed to staging.
Any later Runtime contract change invalidates this approval and requires a regenerated artifact, a
new Runtime commit range and a corresponding WA Studio snapshot update.

## Client migration evidence

WA Studio verification at `764f078` confirms:

- its renamed `contracts/wa-runtime/v1/openapi.json` snapshot matches Runtime `0f7afd3`
  byte-for-byte;
- generated TypeScript API types were refreshed with `npm run contract:generate`;
- no runtime consumer reads `GroupDetailDto.members`;
- member pagination and search use `GET /api/v1/groups/{id}/members` and `meta.total`;
- metadata, member-page and capability-refresh request state are independent;
- `npm run check` passed 37 tests, TypeScript compilation, production build, OpenAPI regeneration,
  Rust formatting, Cargo clippy and `git diff --check` on a clean worktree.

This supplied evidence removes the known pre-staging contract blocker. It does not substitute for
the coordinated staging smoke test below.

## Deployment constraints

- Deploy Runtime and WA Studio to staging as one coordinated change.
- Do not production-deploy the Runtime contract independently or before WA Studio `764f078`.
- Deploy immutable revisions; do not deploy either component from an uncommitted working tree.
- Keep `ALLOW_LIVE_SENDS=false` during staging validation unless a separately approved test requires
  otherwise. The scenarios below require reads and capability refresh only.
- Record non-sensitive evidence such as staging revision, timestamp, HTTP status, counts and request
  IDs. Do not record member names, phone numbers, participant IDs, API keys or session IDs here.

## Staging smoke-test checklist

Staging infrastructure verification on 2026-08-12 found:

- WA Runtime `0f7afd3` is deployed at `https://wa-runtime-staging.onio.cc` as image
  `wa-runtime:0f7afd3`; API, scheduler, PostgreSQL, Redis and the worker are healthy;
- every Runtime container uses the `wa-runtime-*` prefix and private storage DNS aliases; logical
  PostgreSQL dumps before and after the Compose project/volume migration are identical, while the
  source volumes remain available for rollback;
- readiness reports OpenWA `0.16.0`, two required process heartbeats, two allowlisted session IDs and
  `liveSendsEnabled=false`; the scoped OpenWA operator key cannot list the existing production
  session;
- WA Studio `764f078` permits only the exact staging HTTPS origin in addition to local development
  origins. `npm run check` passed, and `npm run tauri build` produced the arm64 DMG with SHA-256
  `475271c85d7b5db88ee8665c14991fff54c8e13991679664fc8a84b612bf8a04`;
- the approved Runtime OpenAPI SHA-256 remains unchanged and matches the WA Studio snapshot;
- a dedicated OpenWA `0.16.0` instance is healthy at `https://wa-staging.onio.cc`. It uses an
  isolated SQLite/local-storage directory and Docker network, has no Docker socket/proxy access,
  and exposes one Runtime-scoped staging session record;
- a second dedicated staging session is connected and unrestricted. Its resumable full Runtime sync
  completed with 574 groups and 267,806 member records after staging exposed missing OpenWA subjects,
  transient failures and long-lived rate limits. Runtime now preserves hydrated subjects, resumes
  the same run from durable detail timestamps, serializes detail reads and tolerates missing detail
  subjects. The existing production OpenWA instance remains isolated;
- backend smoke tests use counts and boolean assertions only. No member names, phone numbers,
  participant IDs, API keys or session IDs were recorded.

Overall staging status: **BLOCKED**.

| Scenario | Expected result | Evidence | Status |
| --- | --- | --- | --- |
| Deployment revisions | WA Runtime contains `0f7afd3`; WA Studio contains `764f078` | Runtime image deployed; staging-capable WA Studio arm64 DMG built from the recorded commit | PASS |
| Runtime contract | Deployed/generated OpenAPI artifact matches the approved SHA-256 above | Runtime artifact and WA Studio snapshot both match `f27f61…a79` | PASS |
| Small group | Detail returns metadata without `members`; member page returns all synchronized rows | Detail omitted `members`; default metadata was `limit=50`, `offset=0`; synchronized groups include a one-member group | PASS |
| Group over three pages | Each page payload is bounded by `limit`; aggregate walk has no duplicates or omissions on an unchanged dataset | A 1,939-member group was walked across 78 pages at page size 25; all 1,939 records were unique and present | PASS |
| Pagination forward/backward | Navigation preserves deterministic ordering and correct `meta.total` | A repeated offset-25 page was byte-identical and the complete walk matched `meta.total` | PASS |
| Display-name search | Server-side search returns matching records across the full synchronized dataset | None of the 267,806 synchronized member records exposes a display name; automated coverage passes | PENDING |
| Phone-number search | Server-side search returns matching records across the full synchronized dataset | Search matched at least one synchronized record | PASS |
| Participant-ID search | Server-side search returns matching records across the full synchronized dataset | Search matched at least one synchronized record | PASS |
| Duplicate display names | Results remain stable across page navigation; participant ID is the final tie-breaker | No display-name fixture exists; automated stable-order coverage passes | PENDING |
| Empty member dataset | HTTP 200 with `data: []` and valid zero-total metadata | Current synchronized groups contain between 1 and 1,939 members; automated empty-dataset coverage passes | PENDING |
| Empty search result | HTTP 200 with `data: []` and filtered `meta.total = 0` | Non-matching server-side query returned HTTP 200, empty data and total 0 | PASS |
| Offset out of range after data change | Runtime returns a valid empty page; WA Studio clamps to a valid page without stale data | Runtime returned HTTP 200, empty data and unchanged total for offset beyond 1,939; WA Studio clamp still needs UI verification | PENDING |
| Missing group | Existing not-found UX is preserved and no member data is displayed | Member request returned HTTP 404 | PASS |
| Group in another session | HTTP 404 behavior is preserved without cross-session data disclosure | Same group requested through an unrelated session ID returned HTTP 404 | PASS |
| Capability refresh | Only group metadata is reloaded; member endpoint call count and member payload do not increase | Backend accepted refresh with HTTP 202 and the synchronized member count remained unchanged; WA Studio request telemetry still needs UI verification | PENDING |

Additional backend contract checks passed: custom pagination returned the requested limit/offset;
whitespace-only search matched the unfiltered total; `limit=0`, `limit=201` and negative offset each
returned HTTP 400; and an offset beyond total returned HTTP 200 with empty data.

For the page-size and capability-refresh checks, capture browser network evidence or equivalent
request telemetry without response bodies containing member data.

## Gate decision

Release gate: **BLOCKED**.

Contract compatibility, full-sync completion and backend staging behavior are confirmed for WA
Runtime `34d9faf..0f7afd3`, WA Studio `764f078`, and the approved OpenAPI hash above. No contract
blocker remains. The release gate stays blocked on installing the recorded WA Studio artifact and
capturing UI evidence for offset clamping and capability refresh, plus representative display-name,
duplicate-display-name and empty-group fixtures if those mandatory scenarios must be demonstrated
manually rather than accepted from the passing automated tests. Do not reuse the production OpenWA
instance or enable live sends for these read-only checks. Change the gate to **PASS** only after
every required row is accepted.
