---
description: "Task list for iteration 1 — a standard-shaped group, live on the public alpha"
---

# Tasks: A standard-shaped group, live on the public alpha

**Input**: `specs/001-standard-shaped-group/{spec.md,plan.md}`

**Tracker**: beads is authoritative. Every task names its bead; a task with no bead is a defect in
this file, not a licence to track work here. Labels: `iter:groups-1`, parent `om-kp7ss`.

## Format: `[ID] [P?] [Story] [bead] Description`

- **[P]**: can run in parallel (different files, no dependency)
- **[Story]**: US1 discovery · US2 renders-from-records · US3 admin co-edit · US4 live on alpha
- Paths are as of `1d34134` (groups branch rebased onto `upstream/main` @ `ed2fb42`)

---

## Phase 1: Setup

- [ ] T001 `[om-jjagw]` Confirm the branch base: `openmeet/groups-iter1` = archive branch rebased on
  `upstream/main`; record the tip SHA in the bead so later citations are anchorable.
- [ ] T002 [P] Stamp the TypeScript baseline for the touched packages (`pnpm -C apps/web check`)
  and record the error count — grading is against the stamp, not zero.

---

## Phase 2: Foundational (blocks every story)

**⚠️ No story work starts until T003–T005 land.**

- [ ] T003 `[om-yxmeg]` Split the space type from the XRPC prefix: make `SPACES_NAMESPACE`
  independent of `GROUP_SPACE_TYPE` in `apps/api/src/spaces.ts:29,38`, and make
  `apps/web/src/lib/groups/types.ts:20` re-export the one constant instead of declaring a second
  literal. No string change — the value stays whatever it is today; only the number of declarations
  drops to one. (FR-011)
- [ ] T004 [P] `[om-kp7ss.3]` Write `specs/001-standard-shaped-group/contracts/` — the JSON shapes
  for `declaration`, `profile`, `rule`, `role`, `permissions`, `membership`, `access`, transcribed
  from the draft proposal, plus the `createSpace` policy payloads for `about` and `members`. Shapes
  only; the collection strings resolve from T003's constant.
- [ ] T005 [P] `[om-kp7ss.4]` Write `data-model.md`: each record class → the D1 columns it demotes
  (`types.ts:23-43`, `migrations/0001_groups.sql`) → the rebuild direction. This table is what
  SC-005's rebuild command is generated from.

**Checkpoint**: one NSID constant, contracts on disk, rebuild mapping written.

---

## Phase 3: User Story 1 — anonymous discovery (P1) 🎯 MVP

**Goal**: an app with no credential can tell the DID is a group and find its public face.

**Independent Test**: `curl` the declaration on the group DID with no auth header; then ingest with a
credential-free contrail.

- [ ] T006 `[om-kp7ss.1]` Mint the group DID at create: replace the config-bound path
  (`AUTO_MINT_GROUP_DID = false`, `apps/web/src/lib/groups/server/credentials.ts:96`) with an
  unauthenticated `com.atproto.server.createAccount` against the configured PDS, storing the
  credential DID-keyed. Create copy must **not** imply owner custody — the rotation key is
  deliberately out (`om-bhj4y`/`om-nzmfj`). (FR-001)
- [ ] T007 `[om-fkpvi]` Write the `declaration` record to the group's **public repo** through the
  existing gate/seam (`event-writer.ts:74,153`), pointing at the group's `about` space URI. (FR-003)
- [ ] T008 [P] `[om-fkpvi]` Prove it anonymously: a script under `scripts/` that fetches the record
  with no `Authorization` header and asserts the pointer resolves. Keep it as the regression for
  SC-001 — it fails today by construction.
- [ ] T009 `[om-fkpvi]` Demonstrate credential-free indexing: ingest the group DID's public repo in
  a contrail instance with no space config and assert the declaration lands in the index.

**Checkpoint**: US1 is independently demonstrable — cross-app discovery works with nothing else built.

---

## Phase 4: User Story 2 — the page renders from records (P1)

**Goal**: name, description, rules, roles, access come from records; the cache is droppable.

**Independent Test**: delete the group's D1 rows, run the rebuild, diff the render.

- [ ] T010 `[om-kp7ss.2]` Provision `about` (public read) and `members` (member-list read,
  authority-only write) at group create; persist their URIs. Creation must be resumable: a mint that
  succeeds with a failed provision finishes on retry rather than orphaning the DID. (FR-002)
- [ ] T011 `[om-kp7ss.2]` Add the space write transport behind `GroupRepoWriter`
  (`event-writer.ts:74`) — `com.atproto.space.*` put/create — leaving `authorise()` (`:153`)
  untouched and still first. (FR-008)
- [ ] T012 `[om-kp7ss.3]` Write `profile` + `rule` into `about` on create and on edit; stop treating
  `groups.name`/`description` as truth. (FR-004)
- [ ] T013 `[om-i92w3]` Write `role` + `permissions` into `members` from the existing vocabulary and
  five seeded bundles (`permissions.ts:29,41,121`) — location moves, model does not. (FR-005)
- [ ] T014 `[om-ypwkc]` Write authority `membership` (keyed by member DID) + `access` into
  `members`. Member-authored `acceptance` is iteration 2 — ignore it if present, never crash. (FR-006)
- [ ] T015 `[om-kp7ss.4]` Add the space reader beside the public-repo reader
  (`server/events-read.ts:35-49`): `com.atproto.space.getRecord`/`listRecords` over the group's own
  session. No sync engine, no peer credential. (FR-007)
- [ ] T016 `[om-kp7ss.4]` Make the resolver read records (through the reader + cache) rather than
  `role_permissions` rows, preserving union-with-no-precedence semantics; keep
  `permissions.test.ts` green. (FR-005)
- [ ] T017 `[om-kp7ss.4]` Implement and document the rebuild: drop a group's cache rows, replay from
  records, render identical. One command. (FR-009, SC-005)
- [ ] T018 `[om-nyre2]` Rewire the four route loaders — `groups/+page.server.ts`,
  `[slug]/+page.server.ts`, `[slug]/events/+page.server.ts`, `[slug]/members/+page.server.ts` — to
  the reader; make `create/+page.server.ts` write T007/T012/T013/T014's records. Degrade cleanly
  when a record is missing (no 500 on an empty `about`). (FR-010)

**Checkpoint**: SC-002 and SC-005 observable locally.

---

## Phase 5: User Story 3 — admin co-edit, stranger refused (P2)

**Goal**: authorization comes from records; the author stays the group.

**Independent Test**: two accounts, one event, one refusal.

- [ ] T019 `[om-i92w3]` Point the read-side gate — `canSeeGroup` (`access.ts:21`), `canSeeMembers`
  (`:28`), `canSeeGroupEvents` (`:34`) — at the record-backed resolver so a role change in records
  changes the decision with no deploy. **Note:** the vault notes call this gate `checkUserAccess`;
  no such symbol exists on this branch (`grep -rn checkUserAccess apps/web/src` → 0 hits at
  `1d34134`). Correct the notes, do not invent the function. (SC-003)
- [ ] T020 [P] `[om-3e5i]` Keep the refusal ahead of transport: extend
  `server/event-writer.test.ts` so a non-member's edit asserts **no** PDS call is attempted, not
  merely that it throws. (SC-004)
- [ ] T021 `[om-3e5i]` Live two-account proof on the alpha: admin B edits A's event, record author
  reads back as the group DID; report on the bead with both account DIDs. (SC-003)

---

## Phase 6: User Story 4 — live on the alpha (P3)

- [ ] T022 `[om-6kci0]` Deploy **`apps/web` only** to the testnet worker against `pds.opnmt.net`
  (`apps/api` stays out: contrail pin + placeholder D1 id). (FR-012)
- [ ] T023 `[om-6kci0]` Browser walkthrough: create → browse → open → edit as second admin → refused
  as stranger → drop cache → rebuild → identical render. Record SC-001…SC-006 on the bead.

---

## Phase 7: Close-out

- [ ] T024 Update `2026-09-14-group-component-decomposition.md` §8 with what actually shipped and
  what moved to iteration 2; the spec is not the record of what happened.
- [ ] T025 Answer or re-file the three `NEEDS CLARIFICATION` items (FR-013 `om-yxmeg`, FR-014 space
  type, FR-015 managing-app list) — FR-015 is question 2 of the #78 design post, so its answer may
  arrive from the WG rather than from us.

---

## Dependencies

- T003 blocks every record write (T007, T012, T013, T014).
- T006 blocks T010 (no DID, no spaces); T010 blocks T011–T015.
- T011 blocks T012/T013/T014 (they need the space transport).
- T015 blocks T016/T017/T018.
- US1 (T006–T009) is deliverable without any of Phase 4 — that is what makes it the MVP slice.
- US3 needs T013+T015 (records + reader) but not T017/T018.
- T022 needs Phase 4; T023 needs T021.

## Parallel opportunities

- T004 ‖ T005 (both are documents).
- T008 ‖ T009 once T007 lands.
- T013 ‖ T014 (different record classes, same space, distinct writers).
- T020 can be written before T019 (it is the failing assertion T019 must keep true).
