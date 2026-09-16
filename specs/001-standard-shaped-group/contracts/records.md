# Record contracts

Transcribed from the proposal's "Record types" table (2026-08-18). Columns **Record / Space /
Author / Key / Purpose** are the source's own. **Fields** are provisional (see `README.md`).
**Iter 1** marks what this iteration writes.

Collection strings resolve from one constant per app (`om-yxmeg`); the table writes the draft's
`community.opensocial.*` names because that is what the source says, not because the string is
settled.

| Record | Space | Author | Key | Purpose | Iter 1 |
|---|---|---|---|---|---|
| `declaration` | **public repo** | authority | `self` | Marks a DID as a community. Points at the about space. Discovery only. | ✅ |
| `profile` | about | authority | `self` | Name, description, avatar, join policy. | ✅ |
| `rule` | about | authority | tid | One community rule, with a stable URI a mod action can cite. | ✅ |
| `permissions` | members | authority | `self` | The authz config. Binds roles to actions and bounds `role.assign`. | ✅ |
| `space` | members | authority | tid | One space under this community. The index of what exists. | ⏸ deferred |
| `role` | members | authority | role id | Declares that a role exists. | ✅ |
| `membership` | members | authority | member DID | Grants a member their roles. | ✅ |
| `acceptance` | members | **member** | `self` | The member's side of membership. Gates appearing in the roster, not access. | ⏸ iteration 2 |
| `access` | any space | authority | `self` | Who may read this space. | ✅ |
| `label` | any space | authority | tid | A moderation label, written into the space its subject lives in. | ⏸ |
| `invite` | invites (the **invitee's** own space) | inviting community | tid | An invitation, delivered into the invitee's own space. | ⏸ |

## Provisional field expectations

Derived from prose. Each MUST sit behind a builder function; none may be asserted as a schema.

- **declaration** — a pointer to the community's public `about` space. *Nothing else.* The proposal
  says "discovery only", so no name, no avatar. **Consequence** (this is #78 question 1): a peer app
  can find the community but cannot render its name without a credential, because the about space
  refuses anonymous reads. Do not design UI that assumes otherwise.
- **profile** — display name, description, avatar (blob), join policy.
- **rule** — one rule per record, addressable by URI so a moderation action can cite it. Ordering is
  not specified; if we need order, it is ours to add and must be declared as an extension.
- **role** — existence + identity of a role, keyed by role id. Carries no permissions itself.
- **permissions** — the binding: role → set of actions, plus the bound on `role.assign`/`eject`
  ("assignable"). One record per community (`self`). Union composition, no deny rules, no precedence.
- **membership** — keyed by the member's DID; grants that member a role set.
- **access** — which **roles** may read this space, and (per the proposal) the OAuth scopes each
  role may request for the community DID. Read access is enforced by the space host.
- **acceptance** — member-authored, `self`-keyed, in the community's members space. Gates roster
  appearance, not access. Independent write (atproto #5496, merged 2026-09-10).

## Mapping to our existing model

| Ours today (`1d34134`) | Becomes |
|---|---|
| `groups.name`, `groups.description` (`types.ts:23-43`) | `profile` in about; columns become cache |
| `GROUP_ROLES = ['owner','admin','moderator','member','guest']` (`permissions.ts:41`) | five `role` records in members |
| 17-name permission vocabulary + seeded bundles (`permissions.ts:29,121`) | `permissions` record binding roles → actions |
| `memberships` table (`migrations/0001_groups.sql`) | `membership` records keyed by member DID |
| `join_requests` table | **no record** — the standard makes joining a *method* (`requestJoin`/`admitMember`), and no host serves it (OQ-B). Table stays app-local this iteration. |
| `groups.visibility`, `require_approval` | `access` (read policy) + `profile.joinPolicy`; keep the columns as cache only |

## Vocabulary alignment check — do this before T013

Our 17 permission names were derived independently and land on the same model the proposal states
(flat RBAC, union, no precedence — verified near-verbatim in the 2026-09-14 landscape note §3). The
proposal's action list is **12 names** and is community-scoped, not events-scoped:

`mod.read` · `mod.resolve` · `label` · `takedown` · `invite` · `admit` · `eject` · `role.assign` ·
`space.create` · `space.configure` · `space.delete` · `community.configure`

Two of our names collide conceptually with modality concerns the standard explicitly leaves to the
app ("who can create an event … declared in the modality's own lexicon within the relevant space").
So the `permissions` record carries **community** actions, and event-authoring permissions stay in
our own modality declaration. T013 must not flatten those two sets into one record.
