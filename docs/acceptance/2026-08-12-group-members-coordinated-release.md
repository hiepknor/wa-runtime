# Group-member coordinated release — 2026-08-12

## Release scope

This record coordinates the breaking removal of `GroupDetailDto.members` from the Runtime `/api/v1`
contract with the WA Studio migration to the paginated group-member endpoint.

| Component | Release evidence |
| --- | --- |
| WA Runtime | Commit range `34d9faf..35c5f40` (group-member feature through WA Runtime identity migration) |
| WA Studio | Commit `d779fdb` (contains group-member migration `adee01d` and WA Runtime identity migration) |
| Runtime OpenAPI artifact | `contracts/runtime/v1/openapi.json` at `35c5f40` |
| OpenAPI SHA-256 | `f27f61b0177861e71a309877b2f238e25e80a30358d827f671c0d5738a0b7a79` |

The identity migration changed only the OpenAPI title and one example; paths, schemas and endpoint
semantics are unchanged. The artifact at `35c5f40` was compared byte-for-byte with the WA Studio
snapshot at `d779fdb`. This is the artifact approved for the next coordinated staging deployment.
Any later Runtime contract change invalidates this approval and requires a regenerated artifact, a
new Runtime commit range and a corresponding WA Studio snapshot update.

## Client migration evidence

WA Studio verification at `d779fdb` confirms:

- its renamed `contracts/wa-runtime/v1/openapi.json` snapshot matches Runtime `35c5f40`
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
- Do not production-deploy the Runtime contract independently or before WA Studio `d779fdb`.
- Deploy immutable revisions; do not deploy either component from an uncommitted working tree.
- Keep `ALLOW_LIVE_SENDS=false` during staging validation unless a separately approved test requires
  otherwise. The scenarios below require reads and capability refresh only.
- Record non-sensitive evidence such as staging revision, timestamp, HTTP status, counts and request
  IDs. Do not record member names, phone numbers, participant IDs, API keys or session IDs here.

## Staging smoke-test checklist

Staging deployment preflight on 2026-08-12 found:

- local WA Runtime `35c5f40` contains the group-member contract and identity migration, but it has
  not been published to `origin`;
- local WA Studio `d779fdb` contains migration commit `adee01d`, regenerates the approved OpenAPI
  hash and passes `npm run check` (8 test files/37 tests, frontend build, Rust formatting and Cargo
  clippy), but it has not been published to `origin`;
- neither repository defines a staging deployment pipeline or target;
- WA Studio's Tauri HTTP capability permits only `127.0.0.1:3100` and `localhost:3100`. The exact
  staging HTTPS Runtime origin has not been supplied, so a staging-capable immutable desktop build
  cannot yet be produced safely.

Overall staging status: **BLOCKED**.

| Scenario | Expected result | Evidence | Status |
| --- | --- | --- | --- |
| Deployment revisions | WA Runtime contains `35c5f40`; WA Studio contains `d779fdb` | Both coordinated identity revisions are local-only and the staging target is undefined | BLOCKED |
| Runtime contract | Served/generated OpenAPI hash matches the approved SHA-256 above | Not run | PENDING |
| Small group | Detail returns metadata without `members`; member page returns all synchronized rows | Not run | PENDING |
| Group over three pages | Each page payload is bounded by `limit`; aggregate walk has no duplicates or omissions on an unchanged dataset | Not run | PENDING |
| Pagination forward/backward | Navigation preserves deterministic ordering and correct `meta.total` | Not run | PENDING |
| Display-name search | Server-side search returns matching records across the full synchronized dataset | Not run | PENDING |
| Phone-number search | Server-side search returns matching records across the full synchronized dataset | Not run | PENDING |
| Participant-ID search | Server-side search returns matching records across the full synchronized dataset | Not run | PENDING |
| Duplicate display names | Results remain stable across page navigation; participant ID is the final tie-breaker | Not run | PENDING |
| Empty member dataset | HTTP 200 with `data: []` and valid zero-total metadata | Not run | PENDING |
| Empty search result | HTTP 200 with `data: []` and filtered `meta.total = 0` | Not run | PENDING |
| Offset out of range after data change | Runtime returns a valid empty page; WA Studio clamps to a valid page without stale data | Not run | PENDING |
| Missing group | Existing not-found UX is preserved and no member data is displayed | Not run | PENDING |
| Group in another session | HTTP 404 behavior is preserved without cross-session data disclosure | Not run | PENDING |
| Capability refresh | Only group metadata is reloaded; member endpoint call count and member payload do not increase | Not run | PENDING |

For the page-size and capability-refresh checks, capture browser network evidence or equivalent
request telemetry without response bodies containing member data.

## Gate decision

Release gate: **BLOCKED**.

Pre-staging contract compatibility is confirmed for WA Runtime `34d9faf..35c5f40`, WA Studio
`d779fdb`, and the approved OpenAPI hash above. To resume the coordinated staging deployment, supply
the exact HTTPS Runtime staging origin and deployment target, add that exact origin to the WA Studio
Tauri capability, publish immutable Runtime and WA Studio revisions, and provide access to the
staging deployment mechanism. Then deploy both revisions together and execute every remaining smoke
row. Change the gate to **PASS** only after every row is successful.
