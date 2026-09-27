# Groups

A group is an AT Protocol account that the app creates and runs for its owner. Its events are
ordinary `community.lexicon.calendar.*` records in the group's own repo, so they are indexed and
shown like any other account's events. Everything else about the group is also records on the
group's PDS. D1 holds a cache of them that the app can query.

## Where a group's data lives

| what                                   | where                                                   | read policy            |
| -------------------------------------- | ------------------------------------------------------- | ---------------------- |
| public events                          | the group's public repo                                 | anyone                 |
| declaration (makes the group findable) | the group's public repo, only while the group is public | anyone                 |
| profile and rules                      | the `net.openmeet.space.about` space                    | the group's visibility |
| roles, permissions, membership, access | the `net.openmeet.space.members` space                  | member list            |
| a cache of the records above           | D1, `migrations/0001_groups.sql`                        | the app                |
| the group's writing credential         | D1, encrypted, `migrations/0002_group_credentials.sql`  | the app                |

The app reads both spaces as the group, with the group's own credential. A space needs a login
whatever its read policy.

A group's visibility is its about space's read policy: public, or the member list for a private
group. D1 has no column for it. The group pages ask the PDS for it
(`com.atproto.simplespace.getSpace`), so every app sees the same answer. A member on the roster is
let in without the question, and the page then asks only to show the visibility. Anyone else gets
the ordinary 404 when the deployment holds no credential for the group, since then the PDS cannot
be asked, and a 503 rather than a guess when the PDS is asked and does not answer. Browse shows it
from placement instead, with no PDS read per group: a group the declaration index lists is public,
and one the caller sees only through their own groups is private. So browse's badge says whether
the group is declared and the page's badge what its host enforces, and the two can differ: a save
that changed the host but stopped before the declaration leaves them apart until the next save or
the repair aligns the declaration. The settings save changes the read policy before anything else,
and the repair aligns the declaration to it, never the other way round.

The about space's member list mirrors the roster. Joining or being admitted puts a member on it,
and leaving or being removed takes them off, always on the side of less access: the membership
record is written before the list entry and removed after it (`server/roster.ts`). Under a
member-list read policy that list is what lets a member read the group's face with their own
credential, from any app. The members space's own list stays empty, because a DID on it could read
the whole roster from the PDS.

When a record and a D1 row disagree, the record wins. `server/rebuild.ts` can rebuild a group's
rows from its DID alone, and the settings page has a repair step for a group whose create was
interrupted (`server/repair.ts`). The repair also makes the about space's member list equal the
membership records, and the declaration agree with the about space's read policy. A rebuild
restores nothing for the visibility, because nothing in D1 holds it.

## Roles and permissions

There are three roles: `owner`, `admin` and `member`. Permission names are a fixed vocabulary in
`permissions.ts`: `MANAGE_GROUP`, `ADMIT_MEMBERS`, `EJECT_MEMBERS`, `ASSIGN_ROLES`, `MANAGE_EVENTS`
and `CREATE_EVENT`. Which role holds which permission is data, written as records in the members
space, and a member's permissions are the union of what their role holds. The owner cannot be
demoted, removed or leave; the schema enforces that as well as the code.

A private group is invite-only. That is derived, not stored: whatever the profile's join policy or
D1's approval flag says, a group whose PDS reads it as private, or cannot be asked, shows
invite-only and refuses a self-service join. D1's `require_approval` is a plain cache of the
profile's join policy. The create and the settings save also refuse a private group with approval
off, before any write. There is no suspension: removing someone deletes their membership record.

## Hosting

Creating a group creates a new `did:plc` account on a PDS the deployment chooses. The app keeps an
app password for that account (never the account password) so it can write as the group. The owner
receives the account's first PLC rotation key, so they can move the group to another host without
the app. Owning the account outright from the start is not offered yet.

The create flow (`create-group.ts`) refuses everything it can before it creates the DID, because a
DID is permanent. The handle registration is the name reservation, so a taken name fails before
anything is written.

## Configuration

Set on the web Worker. `/groups/create` refuses to run when any of them is missing.

| name                    | kind   | meaning                                                             |
| ----------------------- | ------ | ------------------------------------------------------------------- |
| `GROUP_PDS_SERVICE`     | var    | PDS that new group accounts are created on                          |
| `GROUP_HANDLE_DOMAIN`   | var    | handle suffix for groups, e.g. `groups.example.com`                 |
| `GROUP_ACCOUNT_EMAIL`   | var    | email the accounts are created with; each group gets a plus address |
| `GROUP_PDS_INVITE_CODE` | secret | invite code, when the PDS requires one                              |
| `GROUP_CREDENTIAL_KEY`  | secret | base64 32-byte AES-GCM key that encrypts the stored app passwords   |

`apps/web/.dev.vars.example` lists the secrets for local runs.

## Checks against a live PDS

Unit tests run with `vitest` and need no network. These scripts run the real code against a real
PDS and delete what they write:

```bash
node apps/web/scripts/groups-e2e.mjs            # the group flow, 26 checks
node apps/api/scripts/spaces-e2e.mjs            # the members-only Spaces read path
node apps/web/scripts/group-declaration.mjs <origin>   # every public group is declared, no private one is
node apps/web/scripts/inherited-surface.mjs <origin>   # the app's existing pages still answer
```

The two e2e scripts read their fixture accounts from the environment (`E2E_PDS`, `E2E_GROUP_DID`,
`E2E_GROUP_HANDLE` and others). The header of each script lists what it needs. The last two scripts
are read-only and need no credentials.
