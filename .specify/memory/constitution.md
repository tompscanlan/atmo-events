# OpenMeet-on-atmo Groups Constitution

Scope: group/space work in this repo (`apps/web/src/lib/groups/**`, `apps/api/src/spaces.ts`,
`apps/web/src/routes/(app)/groups/**`). Every principle below is a ruling already recorded in the
knowledge base; this file is the machine-checkable restatement, not a new decision.

## Core Principles

### I. The vocabulary is community-owned, and the string is not ours

Record shapes come from the `community.opensocial.*` draft (dholms, 2026-08-18): `declaration`,
`profile`, `rule`, `role`, `permissions`, `membership`, `acceptance`, `access`. We adopt the
**shapes**, never a service (2026-04-02 ruling, re-confirmed 2026-09-14). The NSID string is
unsettled ("group" is beating "community"; Bluesky offered `opensocial.group`), therefore:

- Every NSID lives in exactly one exported constant per app. Today: `GROUP_SPACE_TYPE`
  (`apps/api/src/spaces.ts:29`), `OPENMEET_SPACE_TYPE` (`apps/web/src/lib/groups/types.ts:20`).
- The **space type** and the **XRPC prefix** are separate names. `SPACES_NAMESPACE =
  GROUP_SPACE_TYPE` (`apps/api/src/spaces.ts:38`) overloads one NSID as both and MUST be split
  (`om-yxmeg`).
- A vendor namespace under a domain we control (`net.openmeet.*`) is a stopgap that costs cross-app
  visibility, never a destination. Apps request space access **by type**.

### II. No public-path component sits behind the spaces adapter

Contrail ingests Jetstream + PDS backfill. **Spaces are not on Jetstream**, and a `publicPolicy`
space returns `401 AuthMissing` to an anonymous reader (2026-08-24 spike, finding 3). Therefore:

- Anything the anonymous web must read is a record in a **public repo** (`declaration`, public
  events, RSVPs), indexed for free.
- Anything in a space requires a credential, and reaching it at scale requires a sync engine.
  Fetching one authority-authored record does **not**: an account credential reads its own repo
  inside a space (`atproto-permissioned-data` @ `f4a1f5f8c`, `space/util.ts:106-124`; probed live
  against `pds.opnmt.net` 2026-09-13).
- A feature whose read path needs anonymous access MUST NOT be specced against a space.

### III. Records are the source of truth; D1 is a rebuildable cache

D1 has no boundary of its own — it is the write gate's cache. A group's name, rules, roles,
permissions and roster are records; D1 rows are a projection. Acceptance for any control-plane
change includes: **drop the rows, rebuild from records, lose nothing.** A field that exists only as
a D1 column is a portability bug (`types.ts:23-43` is the current instance of it).

### IV. Author identity is structural: one writer, gated before transport

Every space and repo write asserts `repo === authenticated DID`, so an admin cannot write as
themselves into the group's repo. The only legal shape is the app holding the **group's**
credential:

- Exactly one path produces a record under the group DID (`event-writer.ts`), and `authorise()`
  (`event-writer.ts:153`) runs **before** any PDS call.
- Transport is swappable behind the `GroupRepoWriter` seam (`event-writer.ts:74`); the gate is not.
- Custody today is a password session on the group account — the "micro-centralized" interim. It is
  a stage with a named exit (`om-jc4lh`: group-host OAuth), never the design.

### V. Releasable increments on a live alpha, never a big bang

"We need releasable things going out on a dev or test service and not wait until everything is
done. We need to develop as the spec develops" (TS, 2026-09-14). Each iteration MUST be
demonstrable in a browser against `pds.opnmt.net` and MUST NOT depend on an undecided question, a
sync engine, or an unmerged upstream PR.

### VI. Claims carry a SHA

Any capability claim in a spec, plan, or bead cites `path:line` **and** the commit it was read at,
or is marked unverified. Checkouts in this pod are not on `main`; a citation without a SHA rots
silently (`bd recall verify-before-asserting`).

## Repo Boundary

Users are moving off the legacy stack onto an atmo/contrail instance branded OpenMeet (TS,
2026-09-15). Therefore group work adds **no code to `openmeet-api` or `openmeet-platform`**, even
where legacy already implements the capability. Legacy implementations are read as **evidence**, not
reused. Contrail receives only protocol-neutral seams (the `isolated` projection scope and a spaces
source adapter); the product — group object, roles, membership, custody, events — lands in this repo.

## Development Workflow

- **Beads is the tracker of record.** Spec-kit artifacts (`spec.md`, `plan.md`, `tasks.md`) are the
  executable contract for one iteration; every task row names its bead id. `tasks.md` MUST NOT
  become a second backlog: if a task has no bead, file one.
- **Decision notes are upstream of specs.** A spec may not invent a ruling. Open questions are
  carried as `NEEDS CLARIFICATION` with the owning decision bead, never silently resolved.
- **Verification is a browser or a probe**, not a passing unit test alone. Iteration acceptance is
  judged by the observable outcome named in the spec's Success Criteria.
- `pnpm vue-tsc`/`tsc --noEmit` clean for touched files before commit; grade repo-wide against a
  stamped baseline, not against zero.

## Governance

This constitution supersedes convenience. A principle is amended only by a recorded decision (bead
+ vault note) naming what changed and why; the amendment lands here in the same session. Plans MUST
include a Constitution Check, and any violation MUST be justified in Complexity Tracking or the plan
is rejected.

**Version**: 1.0.0 | **Ratified**: 2026-09-15 | **Last Amended**: 2026-09-15
