# Feature Specification: A standard-shaped group, live on the public alpha

**Feature Branch**: `001-standard-shaped-group`

**Created**: 2026-09-15

**Status**: Draft

**Input**: Iteration 1 as named by TS 2026-09-15 — §8 of
`obsidian/Spaces/Projects/OpenMeet/2026-09-14-group-component-decomposition.md`. Requirements R1–R7
from `2026-09-14-opensocial-group-standard-landscape.md` §9. Public framing:
`flo-bit/atmo-events#78`.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A stranger's app finds the group without a credential (Priority: P1)

An app that has never heard of us — another events client, an AppView, a feed builder — sees that a
DID is a group and can follow a pointer to its public face, with no account, no token, and no
cooperation from us.

**Why this priority**: it is the one capability that makes the group portable, and it is the only
iteration-1 read an anonymous reader can perform at all. Everything else in the group's control
plane sits in a space, which refuses anonymous reads. Without this the group exists only inside our
app, which is the thing we are migrating away from.

**Independent Test**: create a group, then `GET com.atproto.repo.getRecord` for the declaration
collection on the group DID with no `Authorization` header, from a machine that holds no credential.
Delivers cross-app discovery on its own, even if no other story ships.

**Acceptance Scenarios**:

1. **Given** a group created in the app, **When** an unauthenticated client fetches the group DID's
   declaration record, **Then** it resolves 200 and contains a pointer to the group's `about` space.
2. **Given** that record exists, **When** a contrail instance ingests Jetstream with no credential
   configured, **Then** the record appears in its index.
3. **Given** the NSID constant is changed, **When** the app writes a new declaration, **Then** the
   new collection is used everywhere and no second string exists in the tree.

---

### User Story 2 - A group page renders from records, not from our database (Priority: P1)

A visitor opens a group page. Its name, description, rules, roles and access list are read out of
the group's own records. If our database is wiped, the page still renders once the cache is rebuilt
from those records.

**Why this priority**: this is the portability requirement TS made binding on 2026-09-14 ("whatever
we build needs to be portable to other atproto apps"), and it is what demotes D1 from source of
truth to cache. It is also the precondition for any other app ever managing the group.

**Independent Test**: point the reader at a group whose D1 rows have been deleted, run the
documented rebuild, and diff the rendered page against the pre-delete render.

**Acceptance Scenarios**:

1. **Given** a group, **When** the group page loads, **Then** name, description and rules come from
   `profile`/`rule` records in the `about` space and not from D1 columns.
2. **Given** a group with five roles, **When** the members tab loads, **Then** the roles and their
   permission bundles come from `role`/`permissions` records in the `members` space.
3. **Given** the D1 rows for a group are dropped, **When** the rebuild runs, **Then** every page
   renders identically and nothing is unrecoverable.
4. **Given** the group's own credential, **When** the reader fetches a record from its `about`
   space, **Then** the read succeeds without a sync engine or a peer credential.

---

### User Story 3 - A second admin edits the group's event; a non-member cannot (Priority: P2)

Two people run a group. Either can edit the group's events. The record stays authored by the group,
not by whoever clicked save. Someone with no role is refused.

**Why this priority**: it is sunset gate (b) — the gate a real organizer hits on day one — and it is
the capability legacy has that atmo structurally cannot do today. It is P2 only because it is
already demonstrated end-to-end on our alpha (2026-08-24, `om-qcufs` findings 4 and 5), so
iteration 1 moves its authorization data into records rather than inventing the mechanism.

**Independent Test**: two accounts, one event; the non-creating admin saves an edit and the record's
author is read back from the PDS.

**Acceptance Scenarios**:

1. **Given** an event created by admin A, **When** admin B edits it, **Then** the edit persists and
   the record's author DID is the **group's**, not B's.
2. **Given** a signed-in user with no role in the group, **When** they attempt the same edit,
   **Then** the write is refused before any PDS call is made.
3. **Given** a role's permission bundle is changed in records, **When** the same user retries,
   **Then** the new decision applies without a deploy.

---

### User Story 4 - The whole thing is live on the alpha and walkable in a browser (Priority: P3)

The iteration is deployed to a testnet worker against `pds.opnmt.net` and a human can walk it:
create a group, see it listed, open it, edit an event, be refused as a stranger.

**Why this priority**: the iteration's own definition of releasable (Constitution V). It is P3
because it has no product value of its own — it is how the other three stories are judged.

**Independent Test**: the walkthrough, performed in a browser against the deployed worker, recorded
on `om-6kci0`.

**Acceptance Scenarios**:

1. **Given** the deployed web worker, **When** a signed-in user creates a group, **Then** the group
   DID is minted at create time rather than bound from configuration.
2. **Given** the deployed worker, **When** the walkthrough is performed, **Then** each acceptance
   scenario in stories 1–3 is observed live and reported on the bead.

---

### Edge Cases

- A group whose `about` space exists but holds no `profile` record yet — the page must render a
  degraded but valid state, not 500.
- The NSID string changes while groups exist: records written under the old collection are
  unreadable by a reader compiled against the new constant. Migration is a replay, not a rename.
- A record written directly by an operator (not through the gate) — the resolver must treat records
  as authoritative, so an out-of-band record changes behavior. This is intended, and it is why the
  gate is the only *writer* rather than the only *reader*.
- Minting succeeds but space provisioning fails: the group DID exists with no spaces. Create must be
  idempotent enough to finish provisioning on retry rather than orphan a DID.
- A member-authored record arriving in the `members` space (`acceptance`) — out of scope this
  iteration; it must be ignored, not crashed on.
- Space writes are per-record and there is no space import. Recovery from a lost PDS is a CAR export
  replay (`getRepo`), not a migration.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST mint a new `did:plc` with a handle for each group at creation time, on
  the PDS the app is configured against, rather than binding a pre-provisioned DID from
  configuration. *(R1, identity half; `om-kp7ss.1`)*
- **FR-002**: The system MUST provision two spaces under the group DID at creation: an `about` space
  whose read policy is public-to-authenticated-readers, and a `members` space readable by the member
  list and writable only by the authority. *(R3/R6 substrate; `om-kp7ss.2`)*
- **FR-003**: The system MUST write a `declaration` record into the group DID's **public repo**,
  containing a pointer to the group's `about` space, readable with no credential. *(R2; `om-fkpvi`)*
- **FR-004**: The system MUST store the group's name, description and rules as `profile` and `rule`
  records in the `about` space, and MUST NOT treat the corresponding database columns as the source
  of truth. *(R3; `om-kp7ss.3`)*
- **FR-005**: The system MUST store roles and their permission bundles as `role` and `permissions`
  records in the `members` space, over the existing fixed permission vocabulary, resolved by union
  with no deny rules and no precedence. *(R6; `om-i92w3`)*
- **FR-006**: The system MUST store authority-authored `membership` (keyed by member DID) and
  `access` records in the `members` space. *(R7, authority half; `om-ypwkc`)*
- **FR-007**: The system MUST read every record above through the group's own credential against the
  space read methods, with no sync engine and no peer credential. *(`om-kp7ss.4`)*
- **FR-008**: The system MUST authorize every group-authored write against the resolved permission
  set **before** contacting the PDS, and MUST author the record as the group DID. *(R5; existing
  gate)*
- **FR-009**: The system MUST be able to rebuild its cache for a group from records alone, with a
  documented procedure, losing nothing that a page renders. *(Constitution III)*
- **FR-010**: Every group route MUST render from the record reader; group creation MUST write the
  records in FR-003 to FR-006. *(`om-nyre2`, re-scoped from "build the UI" to "rewire it")*
- **FR-011**: All NSIDs MUST resolve from one constant per app, and the space type MUST be separable
  from the XRPC prefix. *(`om-yxmeg`)*
- **FR-012**: The iteration MUST be deployed to a testnet worker against the alpha PDS and walked in
  a browser. *(`om-6kci0`)*
- **FR-013**: The group's record collection names MUST be [NEEDS CLARIFICATION: `community.opensocial.*`
  vs `opensocial.group.*` vs the interim vendor prefix — owned by `om-yxmeg`; shape is stable, string
  is not].
- **FR-014**: The group's calendar space type MUST be [NEEDS CLARIFICATION: atmo ships
  `tools.atmo.event.space`, our branch ships `net.openmeet.group`, and the portability argument says
  `community.lexicon.calendar.*`. Unresolved anywhere; recorded as a hard stop before the first
  production group DID is minted].
- **FR-015**: Write access for apps other than the managing app MUST be [NEEDS CLARIFICATION:
  `managingAppPolicy` names exactly one app while the app perimeter is already a list; a list of
  managing apps needs a combining rule (any-yes / all-yes). This is question 2 of the #78 design
  post and is not ours alone to answer].

### Key Entities

- **Group**: a minted DID + handle whose repo and spaces hold every fact about the group. Identity,
  not a row.
- **declaration**: public-repo record marking the DID as a group and pointing at its `about` space.
  Discovery only; carries no authorization meaning.
- **profile / rule**: the group's public face — name, description, how to get in — in the `about`
  space.
- **role / permissions**: named roles and the actions each may take, in the `members` space; a flat
  RBAC with union resolution.
- **membership / access**: who is in the group (authority-authored) and who may read the space.
- **about space / members space**: the two permissioned containers under the group DID; policy is
  set per space at creation.
- **Cache**: a projection of the above for synchronous lookups. Droppable by definition.
- **space index record**: the standard's own index of which spaces exist under the community
  (`community.opensocial.space`, one per space, in `members`). Deferred this iteration — nothing in
  the protocol enumerates spaces, so until it exists, space URIs are carried by our own
  configuration and the `declaration` pointer (`om-pfodd`).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A machine holding no credential fetches a group's `declaration` and follows it to the
  `about` space pointer: 1 request, HTTP 200, no auth header.
- **SC-002**: A group page renders with **zero** reads of the cache for name, description, rules,
  roles and access — verified by deleting the group's cache rows and reloading after rebuild, with
  an identical rendered result.
- **SC-003**: A non-creating admin's edit to a group event persists and reads back with the **group
  DID** as author, in 2 of 2 attempts with two distinct real accounts.
- **SC-004**: A signed-in non-member attempting the same edit is refused with **no PDS write
  attempted** (observable: no record created, refusal before transport).
- **SC-005**: The rebuild procedure restores a group's full page state from records in a single
  documented command, with no manual data entry.
- **SC-006**: The iteration is reachable at a testnet URL and all of SC-001 to SC-005 are observed
  there, not only in tests.

## Assumptions

- The alpha PDS (`pds.opnmt.net`) is **disposable by policy**: no backup story, and the owner-held
  PLC rotation key is deliberately deferred to `om-bhj4y`/`om-nzmfj`. Create copy must not imply
  custody the alpha does not give.
- The standard is a **peer to simplespace, not a layer on it** — it expects a community-aware space
  host ("does not layer on top of simplespaces", proposal §Proposal). We run a stock alpha PDS, so
  iteration 1 follows the standard's **record placement** while the managing app emulates the host.
  No artifact from this iteration may claim opensocial.community compliance; see
  `contracts/spaces-and-policy.md` § Emulation boundary.
- `declaration` carries a pointer and nothing else ("discovery only"), so an anonymous peer can find
  a group but cannot render its **name**. The spec does not depend on anonymous name rendering and
  no UI may promise it; whether the declaration should carry more is #78 question 1, upstream.
- No field-level lexicon for `community.opensocial.*` is published anywhere. Every field name is
  provisional and lives behind a per-record builder (`contracts/README.md`).
- Custody transport stays a password session on the group account for this iteration; the exit to
  group-host OAuth is `om-jc4lh` and is explicitly out of scope.
- Member-authored `acceptance`, the roster gate, and join-from-a-second-app are **iteration 2**
  (`om-kp7ss.5`): they need an authority-minted DPoP credential, an alpha-PDS account per member,
  and a members-space write policy that is still open.
- No discovery **index** in this iteration: contrail declares no group collection and the API worker
  needs D1/queue/endpoint provisioning plus a contrail pin bump (`om-jjagw`, `om-23nap`). The group
  DID list stays configuration, so the cache remains rebuildable without it.
- Only `apps/web` is deployed; `apps/api` carries the contrail dependency and a placeholder D1 id.
- Events and RSVPs already work (R4 shipped). This iteration does not touch the public event path
  except through the shared gate.
- Anything requiring peer-app reads at scale, private events, or search needs the spaces source
  adapter (`om-5cxui`) and is out of scope by Constitution II.

## Out of Scope

Member-authored records · join from another app · invites · private/members-only events · the
spaces sync engine · a contrail group index · owner-held rotation keys · group-host OAuth · any code
in `openmeet-api` or `openmeet-platform` · the per-group sunset runbook (that is
`2026-09-05-groups-to-atmo-cutover-spec.md`, executed later).
