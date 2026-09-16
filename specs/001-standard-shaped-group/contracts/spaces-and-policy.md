# Space types, policy, and the host surface

## Space types (source's table)

| Space type | skey | Purpose | Iter 1 |
|---|---|---|---|
| `community.opensocial.about` | `self` | The community's public face. Profile, rules, how to get in. Often readable by anyone, though may be private to members. | ✅ provision |
| `community.opensocial.members` | `self` | Roles, who holds them, the authz config, the space index. Usually gated to members. | ✅ provision |
| `community.opensocial.invites` | `self` | **Hosted by each user, not by communities.** Where invites arrive. | ⏸ |
| modality spaces | any | `com.atmoboards.forum`, `community.lexicon.calendar.events`, … "Not specified here." | ⏸ (events are public-repo this iteration) |

## Our `createSpace` policy mapping (simplespace alpha)

`createSpace` takes `readPolicy`, `writePolicy` and `appAccess` **separately**
(`lexicons/com/atproto/simplespace/createSpace.json`). Iteration 1 sets:

| Space | readPolicy | writePolicy | appAccess |
|---|---|---|---|
| about | public-to-authenticated (`publicPolicy`) | authority only | our OAuth client id |
| members | member list | authority only | our OAuth client id |

Three facts that constrain those choices, each verified:

1. **`publicPolicy` is not anonymous.** A space returns `401 AuthMissing` to a credential-free
   reader even when the read policy is public (2026-08-24 spike, finding 3). "Public" means any
   authenticated AT user. This is exactly why `declaration` is a public-repo record.
2. **An account credential reads its own repo inside a space** (`space/util.ts:106-124`; live probe
   2026-09-13: own-repo `getRecord` over Bearer → 200, another repo → 400). That is what makes the
   iteration-1 reader cheap — the authority reads its own authority-authored records.
3. **`managingApp` is singular; the app perimeter is a list.** `managingAppPolicy.managingApp` names
   one service identifier while `allowList.allowed` is a list of OAuth client ids. So one space can
   serve two app instances for reads and writes, but if admission is decided by callback, exactly one
   of them decides. Open, and it is #78 question 2 (FR-015).

Also: **`assertSpaceScope` only skips the scope check for non-OAuth credentials** (`util.ts:89`), so
an OAuth client needs a `space:` scope for the space **type** — which cannot be issued until the type
resolves as a published lexicon. Iteration 1 stays on a password session partly for this reason.

## Emulation boundary (read before claiming standard compliance)

The proposal says opensocial.community is a **peer** to simplespace and "does not layer on top of
simplespaces" — it expects a community-aware space host. We have a stock alpha PDS. So:

- What we can do faithfully: **record placement** (which record, which space, which author, which
  key) and the RBAC model.
- What we are emulating: the **host**. Of bnewbold's four host functions we run the PDS host and the
  space host; the OAuth authorization server for the community DID does not exist anywhere, and the
  opensocial API server (the method table below) is unimplemented.
- Therefore no artifact from this iteration may claim "opensocial.community compliant". The claim is:
  *the standard's record placement, proven on the simplespace alpha, by the managing app.*

## Host method surface — serve none in iteration 1

The source specifies 25 methods. We implement **zero** of them; every iteration-1 write is a direct
authority write through our own gate. Listed so the gap is explicit rather than forgotten:

| Group | Methods | Requires |
|---|---|---|
| Presence | `updateProfile`, `uploadImage`, `putRule`, `deleteRule` | `community.configure` |
| Roles/authz | `putRole`, `deleteRole`, `assignRoles` | `community.configure` / `role.assign` |
| Spaces | `createSpace`, `updateSpace`, `deleteSpace` | `space.create` / `space.configure` / `space.delete` |
| Joining | `requestJoin`, `cancelJoinRequest`, `leaveCommunity`, `listJoinRequests`, `admitMember` | — / `admit` |
| Invites | `createInvite`, `listInvites`, `revokeInvite` | `invite` |
| Membership | `ejectMember` | `eject`, bounded by assignable |
| Moderation | `listSubjects`, `getSubjectHistory`, `resolveSubject`, `applyLabel`, `negateLabel` | `mod.*` / `label` / `takedown` |

`deleteSpace` "refuses on the two well-known ones" — worth mirroring in our provisioning code as an
invariant even without the method.

**Where this bites us next**: joining is a method, not a record (OQ-B). Our `join_requests` table
has no standard equivalent, so a second app cannot admit a member. That is iteration 2's real
question, and the honest interim is that our API worker — which already serves the space callbacks —
would serve those methods, i.e. the managing app emulating a host.

## The standard's own open questions (do not answer them in our spec)

Quoted, because two of them are ours to contribute to rather than to decide:

1. Smoothing the UX of the OAuth flow for writing as a community DID (this is OQ-C / `om-jc4lh`; we
   hold the only working co-edit implementation, so this is the contribution opening).
2. Whether actions should be NSIDs or permission sets.
3. Which methods should collapse into plain record writes (e.g. `updateProfile`) — relevant to us,
   since iteration 1 *is* the record-write form of several of them.
4. The invites space needs open writes with owner-only reads; not configurable in the current alpha,
   and an inbound spam vector. Our unverified item: whether `defs.json`'s `open` policy is that
   `openWrites` mechanism (`om-jqplt`).
