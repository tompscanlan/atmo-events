# Implementation Plan: A standard-shaped group, live on the public alpha

**Branch**: `openmeet/groups-iter1` (spec dir `001-standard-shaped-group`) | **Date**: 2026-09-15 |
**Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/001-standard-shaped-group/spec.md`

## Summary

Move the group control plane out of D1 columns and into the draft standard's places — `declaration`
in the group's public repo, `profile`/`rule` in an `about` space, `role`/`permissions`/`membership`/
`access` in a `members` space — and read it back with the credential the app already holds. The
existing write gate and permission vocabulary stay; what changes is **where the authorization data
lives** and **where pages read from**. Nothing in the iteration waits on a sync engine, a DPoP
client, an unmerged upstream PR, or an undecided question.

## Technical Context

**Language/Version**: TypeScript 5.x, Svelte 5 / SvelteKit 2, Node ≥ 22 for tooling

**Primary Dependencies**: `@atcute/client` (XRPC), `@atproto/*` for PLC/handle work, Cloudflare
Workers runtime (`wrangler`, pinned per-repo in `apps/web`), `@atmo-dev/contrail` (read path only,
`apps/api` — not deployed this iteration)

**Storage**: group records on `pds.opnmt.net` (spaces alpha); D1 `atmo-events-v5` as a cache
(`apps/web/migrations/0001_groups.sql`)

**Testing**: `vitest` (`apps/web/src/lib/groups/*.test.ts`, `server/*.test.ts` exist), plus a live
browser walkthrough against the testnet worker

**Target Platform**: Cloudflare Workers + a reference PDS running the `permissioned-data` branch

**Project Type**: web app (SvelteKit web worker + a separate API worker, out of scope here)

**Performance Goals**: group page server render ≤ 1 space read per record class, no N+1 over roles;
no regression to the public event path

**Constraints**: space reads require the group's own credential (an account credential reads its own
repo inside a space); spaces are absent from Jetstream; per-record writes only, no space import

**Scale/Scope**: single-digit groups on the alpha; 10 route files, ~15 lib files under
`apps/web/src/lib/groups/`

### Base-branch fact (read this before citing anything)

The groups implementation is **not on main**. It lives on `origin/archive/groups-spaces-2026-09-13`
@ `2db3dc5`, whose merge base with `upstream/main` is `bac5100`; `upstream/main` @ `ed2fb42` is 2
commits ahead of it. This branch (`openmeet/groups-iter1`) is those 9 commits **rebased onto
`upstream/main`**, tip `1d34134`, and every `path:line` below was read at that tip. Two consequences:

- `upstream/main` has only `apps/web` — `apps/api/` (including `src/spaces.ts` and
  `contrail.config.ts`) exists on this branch and on `upstream/migration/standalone-api` @ `5862464`,
  not on main. Any plan row touching `apps/api` is fork-local by construction.
- Our fork's `origin/main` @ `4da0eb6` (2026-07-30) is behind upstream; do not use it as a base.

## Constitution Check

*GATE: passed 2026-09-15 against Constitution v1.0.0.*

| Principle | Status | Evidence / note |
|---|---|---|
| I. One NSID constant, type ≠ XRPC prefix | ⚠️ **violation, tracked** | `SPACES_NAMESPACE = GROUP_SPACE_TYPE` (`apps/api/src/spaces.ts:38`) and a second literal in `apps/web/src/lib/groups/types.ts:20` (`OPENMEET_SPACE_TYPE = 'net.openmeet.group'`). Split is task T003; string itself is `om-yxmeg` (FR-013/FR-014 NEEDS CLARIFICATION). |
| II. No public-path component behind the spaces adapter | ✅ | Only `declaration` must be anonymously readable, and it goes to the **public repo** (FR-003). Every space read in the iteration uses the group's own credential (`om-kp7ss.4`). |
| III. Records are truth, cache is rebuildable | ✅ by construction | FR-009 + SC-002/SC-005 make the drop-and-rebuild the acceptance test. D1 stays as the gate's synchronous lookup. |
| IV. One gated writer, authorize before transport | ✅ | `authorise()` at `apps/web/src/lib/groups/server/event-writer.ts:153` already runs before transport; new record writes reuse it and the `GroupRepoWriter` seam (`:74`). |
| V. Releasable on the alpha | ✅ | `om-6kci0` deploys `apps/web` only; `apps/api` is excluded precisely because it drags the contrail pin and a placeholder D1 id. |
| VI. Claims carry a SHA | ✅ | See Base-branch fact; all citations at `1d34134`. |

## Project Structure

### Documentation (this feature)

```text
specs/001-standard-shaped-group/
├── spec.md              # what must be true (this iteration's contract)
├── plan.md              # this file
├── data-model.md         # record shapes ↔ D1 projection (to write with /speckit.plan phase 1)
├── contracts/            # the record JSON shapes + space policy payloads
└── tasks.md              # bead-linked task list
```

### Source Code (repository root, at `1d34134`)

```text
apps/web/src/lib/groups/
├── types.ts                  # GroupRow etc. — the columns FR-004/005/006 demote (:23-43)
├── permissions.ts            # 17-name vocabulary + 5 seeded role bundles (:29, :41, :121)
├── access.ts                 # canSeeGroup/canSeeMembers/canSeeGroupEvents (:21,:28,:34) — read-side gate
├── event-record.ts           # community.lexicon.calendar.event shaping
├── groups.remote.ts          # SvelteKit remote functions the routes call
└── server/
    ├── credentials.ts        # GROUP_CREDENTIALS map; AUTO_MINT_GROUP_DID = false (:96)
    ├── session.ts            # password-session custody (interim transport)
    ├── event-writer.ts       # authorise() (:153) + GroupRepoWriter seam (:74)
    ├── events-read.ts        # public-repo listRecords reader (:35-49)
    ├── repo.ts / schema.ts    # D1 access + migration helpers
    └── *.test.ts             # existing unit coverage to keep green

apps/web/src/routes/(app)/groups/
├── +page.server.ts           # browse
├── create/+page.server.ts    # create → will mint + provision + write records
└── [slug]/{,events,members}/+page.server.ts   # the three pages FR-010 rewires

apps/web/migrations/0001_groups.sql   # groups, roles, role_permissions, memberships, join_requests
apps/api/src/spaces.ts                # GROUP_SPACE_TYPE (:29), SPACES_NAMESPACE (:38) — fork-local
```

**Structure Decision**: web-worker-only. `apps/api` is touched for the NSID split (T003) but is not
deployed; the iteration's deploy surface is `apps/web` against `pds.opnmt.net`.

## Phasing (maps 1:1 to `iter:groups-1` beads)

| Phase | Bead | Component | Deliverable |
|---|---|---|---|
| 0 | — | — | NSID split + record-shape contracts (unblocks everything, decides nothing) |
| 1 | `om-kp7ss.1` | G1 | mint the group DID at create (retire `AUTO_MINT_GROUP_DID = false`) |
| 2 | `om-kp7ss.2` | G2 | provision `about` + `members` spaces; space write transport behind the existing seam |
| 3 | `om-fkpvi` | G4 | `declaration` in the public repo |
| 4 | `om-kp7ss.3` | G4 | `profile` + `rule` in `about` |
| 5 | `om-i92w3` | G4 | `role` + `permissions` in `members`; resolver reads records |
| 6 | `om-ypwkc` | G4 | authority `membership` + `access` in `members` |
| 7 | `om-kp7ss.4` | G4 | the space reader + documented D1 rebuild |
| 8 | `om-nyre2` | G8 | every group route renders from the reader; create writes the records |
| 9 | `om-6kci0` | deploy | testnet worker + browser walkthrough |

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| Two NSID literals today (`spaces.ts:38`, `types.ts:20`) | Pre-existing; the iteration cannot land records without touching both | Leaving them is worse: the string is expected to change (`om-yxmeg`), and two literals guarantee a silent split-brain |
| Password-session custody retained | Group-host OAuth does not exist anywhere yet (`om-jc4lh`, OQ-C) | Waiting blocks every row; the interim is blaine's recommended "micro-centralized" stage with a named exit |
| D1 kept alongside records | The gate needs a synchronous, trusted role lookup | Reading roles from the PDS on every authorization check adds a network hop to the write path |

## Risks

- **The space type is unresolved** (FR-014). Minting a *production* group DID under the wrong type
  is the one irreversible step; the alpha is disposable, which is why this iteration is alpha-only.
- **Record placement diverges from our own 08-09 ruling** deliberately (OQ-A, decided 09-14). If the
  draft moves again, `profile`/`rule` placement moves with it — keep the writer table-driven.
- **Anonymous rendering of a group's name is still unanswered upstream** (#78 question 1): the
  declaration pointer alone does not let a peer render a name. The spec does not depend on it; do
  not let a UI promise it.
- **No space import**: recovery is a CAR replay. Do not build anything that assumes a space can be
  restored wholesale.
