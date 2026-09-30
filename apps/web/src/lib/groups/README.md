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
| profile and rules                      | the about space, of type `group.opensocial.meta`        | the group's visibility |
| roles, permissions, membership, access | the members space, of type `group.opensocial.members`   | member list            |
| a cache of the records above           | D1, `migrations/0001_groups.sql`                        | the app                |
| the group's writing credential         | D1, encrypted, `migrations/0002_group_credentials.sql`  | the app                |

The app reads both spaces as the group, with the group's own credential. A space needs a login
whatever its read policy.

## The records

The spaces and records are the ones the opensocial.group proposal drafts as `group.opensocial.*`, at
commit `d2c89a9` of `tangled.org/opensocial.group/proposal`. The standard calls the about space
`meta`. The app keeps its own name for it, and so does D1's `about_space_uri` column.

The event actions are the one exception. The standard puts a modality's authz in that modality's own
space, and a group has no events space yet, so the two event actions stay in a record of the app's
own in the members space, `eventPermissions`, beside the standard's `permissions`.

Some records carry a field the standard does not declare. Each is one the app reads back:

- `profile.location`, where an events group meets;
- `createdAt` on the profile, which an edit keeps and a rebuild restores the group's date from;
- `createdAt` on a rule, which is kept when the rule moves and orders rules with the same `order`;
- `createdAt` on the declaration, which the declaration index sorts by.

A rule's required `title` is the first 64 graphemes of its line, and its `text` is the whole line.
A role's required `displayName` is its id with a capital, so `owner` shows as "Owner".

The group.opensocial lexicons do not resolve, so they cannot be pulled. Unchanged copies of the
ones the app writes are in `lexicons/reference/group/opensocial`, and `record-lexicons.test.ts`
checks every record builder against them, failing any field they do not declare and the list above
does not name. Codegen does not read those copies: `@atcute/lex-cli` rejects the proposal's
`space-ref` format. The declaration index needs the declaration's lexicon, so
`lexicons/custom/group/opensocial/declaration.json` is the proposal's with `meta` given the format
`uri`, and nothing else changed. `pnpm generate` rewrites `lex.config.js` and adds
`group.opensocial.declaration` to its pull list. Take it out again: the NSID does not resolve, so
there is nothing to pull.

A group's visibility is its about space's read policy: public, or the member list for a private
group. D1 has no column for it. The group pages ask the PDS for it
(`com.atproto.simplespace.getSpace`), so every app sees the same answer. A member on the roster is
let in without the question, and the page then asks only to show the visibility. When the members
space errors, nobody is on the roster for that read, whatever the D1 rows say, so until the space
answers a member is treated like anyone else. Anyone else gets the ordinary 404 when the deployment
holds no credential for the group, since then the PDS cannot be asked, and a 503 rather than a guess
when the PDS is asked and does not answer. Browse shows it from placement instead, with no PDS read
per group: a group the declaration index lists is public, and one the caller sees only through their
own groups is private. So browse's badge says whether the group is declared and the page's badge
what its host enforces, and the two can differ: a save that changed the host but stopped before the
declaration leaves them apart until the next save or the repair aligns the declaration. The settings
save changes the read policy before anything else, and the repair aligns the declaration to it,
never the other way around.

The settings form sends the visibility it showed as well as the one chosen, and the save changes the
read policy only when the two differ, so a tab opened before someone else changed the visibility
cannot change it back. A form that could not show one is refused if its choice differs from the
PDS. After the read policy, a save that leaves the group private withdraws the declaration before
the D1 row takes the new name and description, because browse shows a declared group's text from
that row. A save that leaves it public writes the row, asks the PDS again, and declares the group
only if the answer is still public. `update-group.ts` has the whole order and what each failure
leaves behind. There is no lock: the moment between that last read and the declaration is the
repair's to heal.

The about space's member list mirrors the roster. Joining or being admitted puts a member on it,
and leaving or being removed takes them off, always on the side of less access: the membership
record is written before the list entry and removed after it (`server/roster.ts`). Under a
member-list read policy that list is what lets a member read the group's face with their own
credential, from any app. The members space's own list stays empty, because a DID on it could read
the whole roster from the PDS.

Both spaces use a member-list write policy and `open` app access. The write policy governs only
other users' writes, and the group always writes as the space owner. `open` leaves for later the
choice of which other apps may read a group.

The declaration is a pointer to the group, with no name or avatar, so no page should promise an
anonymous reader a group's name. The declaration index holds every declaration on the network, not
only this deployment's groups, and `listGroups` decides what each one may show. An index that was
running before the declaration collection was added to its config needs a one-time
`contrail backfill --only records` to pick up older declarations.

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
demoted, removed or leave; the schema enforces that as well as the code. The published
`permissions` record says so too: each role lists the roles it may assign and eject, and only the
owner's list holds `owner`. A new member gets `member`, the record's `defaultRoles`.

Permissions are read from the members space on every call, with no cache. A members space that
cannot be read grants nothing and does not fall back to D1. A group with no members space, or no
permission records in it, uses D1's `role_permissions`.

A private group is invite-only. That is derived, not stored: whatever the profile's join policy or
D1's approval flag says, a group whose PDS reads it as private, or cannot be asked, shows
invite-only and refuses a self-service join. D1's `require_approval` is a plain cache of the
profile's join policy. The create and the settings save also refuse a private group with approval
off, before any write. There is no suspension: removing someone deletes their membership record.
A pending join request is not published as a record.

## Hosting

Creating a group creates a new `did:plc` account on a PDS the deployment chooses. The app keeps an
app password for that account (never the account password) so it can write as the group. The owner
receives the account's first PLC rotation key, so they can move the group to another host without
the app. Owning the account outright from the start is not offered yet.

The app password is stored encrypted under a Worker secret. The alternatives were worse: in plain
text, one D1 read lets anyone write as every group; the account password would make one read an
account takeover; and passwords derived from a key break every group on a handle change or a key
rotation.

The create flow (`create-group.ts`) refuses everything it can before it creates the DID, because a
DID is permanent. The handle registration is the name reservation, so a taken name fails before
anything is written. Before the mint, the create also runs its real D1 batch and rolls it back
(`rehearseCreateGroup`), so schema drift fails before a permanent DID exists.

## Configuration

Set on the web Worker. With `GROUP_PDS_SERVICE` unset, the app hides its groups link.
`/groups/create` refuses to run when any of them is missing.

`GROUP_PDS_SERVICE` must be a PDS that serves Spaces (`com.atproto.simplespace.*`). A stock PDS does
not, and it cannot be told apart from one that does until a create has made the account. On such a
host the create stops after the account exists and says the PDS does not support Spaces.

| name                    | kind   | meaning                                                             |
| ----------------------- | ------ | ------------------------------------------------------------------- |
| `GROUP_PDS_SERVICE`     | var    | PDS that new group accounts are created on                          |
| `GROUP_HANDLE_DOMAIN`   | var    | handle suffix for groups, e.g. `groups.example.com`                 |
| `GROUP_ACCOUNT_EMAIL`   | var    | email the accounts are created with; each group gets a plus address |
| `GROUP_PDS_INVITE_CODE` | secret | invite code, when the PDS requires one                              |
| `GROUP_CREDENTIAL_KEY`  | secret | base64 32-byte AES-GCM key that encrypts the stored app passwords   |

- Groups get their own handle domain, so a group handle never competes with a person's handle on
  the same PDS.
- `GROUP_ACCOUNT_EMAIL` is the deployment's address, not the owner's, so password reset stays with
  the deployment. The PDS requires an email and matches it exactly, so each group gets a plus
  address, `groups+<label>@example.com`.
- Accounts that share an invite code share its use count, and deleting an account does not give a
  use back.
- Losing `GROUP_CREDENTIAL_KEY` loses the stored app passwords, which a PDS admin can issue again. It
  never loses a group, because the owner holds its first rotation key.

`apps/web/.dev.vars.example` lists the secrets for local runs.

## Checks against a live PDS

Unit tests run with `vitest` and need no network. The e2e script runs the real code against a real
PDS and deletes what it writes. The two probes only read a running deployment:

```bash
node apps/web/scripts/groups-e2e.mjs            # the group flow, 26 checks
node apps/web/scripts/group-declaration.mjs <origin>   # every public group is declared, no private one is
node apps/web/scripts/inherited-surface.mjs <origin>   # the app's existing pages still answer
```

The e2e script reads its accounts from the environment, and stops before any network call when one
is missing:

| name                 | meaning                                                  |
| -------------------- | -------------------------------------------------------- |
| `E2E_PDS`            | PDS that hosts the group account; it must serve Spaces   |
| `E2E_GROUP_DID`      | an existing group account's DID                          |
| `E2E_GROUP_HANDLE`   | that account's handle                                    |
| `E2E_GROUP_PASSWORD` | its app password                                         |
| `E2E_CREDENTIALS`    | instead of `E2E_GROUP_PASSWORD`, an env file that has it |
| `E2E_OWNER_DID`      | the person who owns the group                            |
| `E2E_ADMIN_DID`      | a person who joins and is promoted to admin              |
| `E2E_OUTSIDER_DID`   | a person who is never a member                           |

The other two scripts are read-only and need no credentials.
