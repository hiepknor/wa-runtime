# Group-member coordinated release — 2026-08-12

## Release scope

This record coordinates the breaking removal of `GroupDetailDto.members` from the Runtime `/api/v1`
contract with the WA Studio migration to the paginated group-member endpoint.

| Component | Release evidence |
| --- | --- |
| Automation Runtime | Commit range `34d9faf..5d8613a` (feature through release-gate documentation) |
| WA Studio | Commit `adee01d` (`feat(groups): paginate and search synchronized members`) |
| Runtime OpenAPI artifact | `contracts/runtime/v1/openapi.json` at `5d8613a` |
| OpenAPI SHA-256 | `753f08cb6e7068b8d1c3715142337e8d89db154c9c5b97c92cc20556843b45df` |

The Runtime artifact in the working tree was compared byte-for-byte with the artifact stored at
`5d8613a`; no contract delta was present. This is the Runtime OpenAPI artifact approved for the
coordinated staging deployment. Any later Runtime contract change invalidates this approval and
requires a regenerated artifact, a new Runtime commit range and a corresponding WA Studio snapshot
update.

## Client migration evidence

WA Studio reports the following verification at `adee01d`:

- its OpenAPI snapshot matches Runtime `5d8613a` byte-for-byte;
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
- Do not production-deploy the Runtime contract independently or before WA Studio `adee01d`.
- Deploy immutable revisions; do not deploy either component from an uncommitted working tree.
- Keep `ALLOW_LIVE_SENDS=false` during staging validation unless a separately approved test requires
  otherwise. The scenarios below require reads and capability refresh only.
- Record non-sensitive evidence such as staging revision, timestamp, HTTP status, counts and request
  IDs. Do not record member names, phone numbers, participant IDs, API keys or session IDs here.

## Staging smoke-test checklist

Staging deployment preflight on 2026-08-12 found:

- local Runtime `9591e42` contains the approved contract commit `5d8613a`, and the OpenAPI SHA-256
  remains the approved hash, but this revision is 21 commits ahead of `origin/main`;
- WA Studio `acd2b34` contains migration commit `adee01d`, matches `origin/main`, regenerates the same
  OpenAPI hash and passes `npm run check` (8 test files/37 tests, frontend build, Rust formatting and
  Cargo clippy);
- neither repository defines a staging deployment pipeline or target;
- WA Studio's Tauri HTTP capability permits only `127.0.0.1:3100` and `localhost:3100`. The exact
  staging HTTPS Runtime origin has not been supplied, so a staging-capable immutable desktop build
  cannot yet be produced safely.

Overall staging status: **BLOCKED**.

| Scenario | Expected result | Evidence | Status |
| --- | --- | --- | --- |
| Deployment revisions | Runtime contains `5d8613a`; WA Studio contains `adee01d` | WA Studio revision is published; Runtime `9591e42` is local-only and the staging target is undefined | BLOCKED |
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

Pre-staging contract compatibility is confirmed for Runtime `34d9faf..5d8613a`, WA Studio
`adee01d`, and the approved OpenAPI hash above. To resume the coordinated staging deployment, supply
the exact HTTPS Runtime staging origin and deployment target, add that exact origin to the WA Studio
Tauri capability, publish immutable Runtime and WA Studio revisions, and provide access to the
staging deployment mechanism. Then deploy both revisions together and execute every remaining smoke
row. Change the gate to **PASS** only after every row is successful.
