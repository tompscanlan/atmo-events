# Groups

A group is an AT Protocol account that the app creates and runs for its owner. Its events are
ordinary `community.lexicon.calendar.*` records in the group's own repo, so they are indexed and
shown like any other account's events. Everything else about the group is also records on the
group's PDS. D1 holds a cache of them that the app can query.

## Where a group's data lives

| what                                   | where                                                   | read policy                       |
| -------------------------------------- | ------------------------------------------------------- | --------------------------------- |
| public events                          | the group's public repo                                 | anyone                            |
| declaration (makes the group findable) | the group's public repo, only while the group is public | anyone                            |
| profile and rules                      | the `net.openmeet.space.about` space                    | public, but a space needs a login |
| roles, permissions, membership, access | the `net.openmeet.space.members` space                  | member list                       |
| a cache of the records above           | D1, `migrations/0001_groups.sql`                        | the app                           |
| the group's writing credential         | D1, encrypted, `migrations/0002_group_credentials.sql`  | the app                           |

The app reads both spaces as the group, with the group's own credential.

When a record and a D1 row disagree, the record wins. `server/rebuild.ts` can rebuild a group's
rows from its DID alone, and the settings page has a repair step for a group whose create was
interrupted (`server/repair.ts`).

## Roles and permissions

There are three roles: `owner`, `admin` and `member`. Permission names are a fixed vocabulary in
`permissions.ts`: `MANAGE_GROUP`, `ADMIT_MEMBERS`, `EJECT_MEMBERS`, `ASSIGN_ROLES`, `MANAGE_EVENTS`
and `CREATE_EVENT`. Which role holds which permission is data, written as records in the members
space, and a member's permissions are the union of what their role holds. The owner cannot be
demoted, removed or leave; the schema enforces that as well as the code.

A private group always requires approval to join. There is no suspension: removing someone deletes
their membership record.

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
node apps/web/scripts/groups-e2e.mjs            # the group flow, 24 checks
node apps/api/scripts/spaces-e2e.mjs            # the members-only Spaces read path
node apps/web/scripts/group-declaration.mjs <origin>   # every public group is declared, no private one is
node apps/web/scripts/inherited-surface.mjs <origin>   # the app's existing pages still answer
```

The two e2e scripts read their fixture accounts from the environment (`E2E_PDS`, `E2E_GROUP_DID`,
`E2E_GROUP_HANDLE` and others). The header of each script lists what it needs. The last two scripts
are read-only and need no credentials.
