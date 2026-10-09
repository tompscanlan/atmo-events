# Groups

A group is an AT Protocol account that the app creates and runs for its owner. Its public events
are ordinary `community.lexicon.calendar.*` records in the group's own repo, so they are indexed and
shown like any other account's events. Its members-only events are the same records in the group's
calendar space, which only its members see. Everything else about the group is also records on the
group's PDS, except a pending join request, which only D1 holds. D1 also holds a cache of the
records that the app can query.

## Where a group's data lives

| what                                                | where                                                   | read policy            |
| --------------------------------------------------- | ------------------------------------------------------- | ---------------------- |
| public events                                       | the group's public repo                                 | anyone                 |
| declaration (makes the group findable)              | the group's public repo, only while the group is public | anyone                 |
| profile, rules, access                              | the about space, of type `group.opensocial.meta`        | the group's visibility |
| roles, permissions, membership, access, space index | the members space, of type `group.opensocial.members`   | member list            |
| members-only events, members' RSVPs to them, access | the calendar space, of type `rsvp.atmo.group.calendar`  | member list            |
| a cache of the records above, and join requests     | D1, `migrations/0001_groups.sql`                        | the app                |
| the session the owner linked                        | the sessions KV namespace, under `group:session:`       | the app                |

The app reads the group's spaces as the group, through the session the group's owner linked. A
space needs a login whatever its read policy.

## The records

The spaces and records are the ones the opensocial.group proposal drafts as `group.opensocial.*`, at
commit `bce2966` of `tangled.org/opensocial.group/proposal`, on its `lex-refactor` branch. The standard calls the about space
`meta`. The app keeps its own name for it, and so does D1's `about_space_uri` column.

The event actions are the one exception. The standard leaves who may create an event to the
modality's own lexicon and defines no record for it. The calendar space holds only members-only
events, while the two event actions cover public events too, so they stay in a record of the app's
own in the members space, `eventPermissions`, beside the standard's `permissions`.

Some records carry a field the standard does not declare. Each is one the app reads back:

- `profile.location`, where an events group meets;
- `createdAt` on the profile, which an edit keeps and a rebuild restores the group's date from;
- `createdAt` on a rule, which is kept when the rule moves and orders rules with the same `order`;
- `createdAt` on the declaration, which the declaration index sorts by.

A rule's required `title` is the first 64 graphemes of its line, and its `text` is the whole line.
A role's required `displayName` is its id with a capital, so `owner` shows as "Owner".

Each space has an `access` record, and it is the space's policy: whether anyone may read the space,
and which roles may. The standard has the host enforce it. A simplespace PDS enforces its own read
policy and member list instead and never reads the record, so the app derives both from it: the read
policy is public exactly when `access.public` is, and a member is on the space's list exactly when
one of their roles is granted `read` there. The app writes every role a reader in every space, and
the members and calendar spaces' records not public. No moment may find a space more open than its
record: a change that narrows a space moves the PDS first, and one that widens it writes the record
first. A group with a declaration must have an access record that says public, so the record is
written before a declaration is published and after one is withdrawn. The members space also holds
`space`, the standard's index of the group's spaces: one entry each for the about, members and
calendar spaces.
Its key is a TID, so a put cannot land on an existing entry. The writer lists the index and adds
only what is missing, and it deletes all but the oldest entry for a space that has several.

The group.opensocial lexicons do not resolve, so they cannot be pulled. Unchanged copies of the
ones the app writes are in `lexicons/reference/group/opensocial`, and `record-lexicons.test.ts`
checks every record builder against them, failing any field they do not declare and the list above
does not name. Codegen does not read those copies: `@atcute/lex-cli` rejects the proposal's
`space-ref` format. The declaration index needs the declaration's lexicon, so
`lexicons/custom/group/opensocial/declaration.json` is the proposal's with `meta` given the format
`uri`, and nothing else changed. Do not edit it: `pnpm generate` writes it from the reference copy
with `scripts/lexicon-shims.mjs`, then takes `group.opensocial.declaration` back out of the pull
list contrail-lex generate writes into `lex.config.js`, because the NSID does not resolve.
`lexicon-shims.test.ts` fails when the committed copy is not the script's output. The copy goes when
the lexicon tooling reads `space-ref`, and the pull-list step when the NSID resolves. Once both
hold, delete the copy, the script, its test and its two steps in `pnpm generate`.

A group's visibility is its about space's `access.public`, and a missing record means private. D1
has no column for it. The group pages read the record from the PDS, so every app sees the same
answer, and the about space's read policy follows it. A member on the roster is
let in without the question, and the page then asks only to show the visibility. When the members
space errors, nobody is on the roster for that read, whatever the D1 rows say, so until the space
answers a member is treated like anyone else. Anyone else gets the ordinary 404 when the group's
owner has not linked it, since then the PDS cannot be asked, and a 503 rather than a guess
when the PDS is asked and does not answer. Browse shows it from placement instead, with no PDS read
per group: a group the declaration index lists is public, and one the caller sees only through their
own groups is private. So browse's badge says whether the group is declared and the page's badge
what its access record says, and the two can differ: a save that changed the record but stopped
before the declaration leaves them apart until the next save or the repair aligns the declaration.
The repair moves each space's read policy and the declaration to what the access records say, never
the other way around.

The settings form sends the visibility it showed as well as the one chosen, and the save changes the
visibility only when the two differ, so a tab opened before someone else changed it cannot change it
back. A form that could not show one is refused if its choice differs from the record. A save that
leaves the group private closes the about space at the PDS, withdraws the declaration, and only then
has the record say private, all before the D1 row takes the new name and description, because browse
shows a declared group's text from that row. A save that leaves it public has the record say public,
opens the about space, writes the row, reads the record again, and declares the group only if it
still says public. A save also moves the about space's read policy when it disagrees with the record,
so saving again finishes one that stopped between the two. `update-group.ts` has the whole order and
what each failure leaves behind. There is no lock: the moment between that last read and the
declaration is the repair's to heal.

Each space's member list holds the members whose roles its access record grants `read`, read and
write, since reading a space and writing your own records in it are one grant. With the roles the
app writes, that is every member on all three lists. Joining or being admitted puts a member on
them, a role change moves them by the new role, and leaving or being removed takes them off, always
on the side of less access: the membership record is written before the list entries and removed
after them (`server/roster.ts`). Under a member-list read policy the lists are what let a member
read the group's face, its roster and its members-only events with their own credential, from any
app, and the PDS tracks the acceptance a member writes in the members space. The about space's list
does not depend on the visibility, so going private needs no backfill. A join requester is not a
member, so a request puts nothing on any list.

A member's acceptance is their own half of the membership: a record they write from their own
session into their repo in the members space, at an open join, or at a later sign-in that carries
the group's grant (`server/acceptance.ts`). A join request writes none. Leaving deletes it. It decides only whether the roster shows them confirmed. Access comes from the membership record
alone, so a member whose PDS serves no spaces can read the group and stays unconfirmed.

All three spaces use a member-list write policy and `open` app access. The write policy governs only
other users' writes, and the group always writes as the space owner. `open` leaves for later the
choice of which other apps may read a group.

The declaration is a pointer to the group, with no name or avatar, so no page should promise an
anonymous reader a group's name. The declaration index holds every declaration on the network, not
only this deployment's groups, and `listGroups` decides what each one may show. An index that was
running before the declaration collection was added to its config needs a one-time
`contrail backfill --only records` to pick up older declarations.

When a record and a D1 row disagree, the record wins. `server/rebuild.ts` can rebuild a group's
rows from its DID alone, and the settings page has a repair step for a group whose create was
interrupted (`server/repair.ts`). The repair writes what the create would have, the calendar
space's access record and index entry included, and an about space record that says private when
there is none. It also makes each space's member list and read policy, and the declaration, agree
with the access records. A rebuild restores nothing for the visibility, because nothing in D1 holds
it.

## Members-only events

A members-only event is the same `community.lexicon.calendar.event` record as a public one, written
into the group's calendar space instead of its public repo. Nothing on the record says which: the
container is the fact, because the host enforces it for every reader. The calendar space's read
policy is its member list whatever the group's visibility, and its list holds the members, so a
member can read it with their own credential. The app reads it as the group, and only for a caller
on the roster. The roster check runs before the read, so a non-member's visit costs the group's PDS
nothing (`server/calendar-read.ts`). The space's type is the app's own, not the standard's, and its
name is provisional.

Every event command takes the event's placement, `everyone` or `members`, and never a default
(`event-placement.ts`). Before a members-only write, the writer checks the calendar space's read
policy at the host and refuses when more than the members could read it (`server/event-writer.ts`).
An event cannot move between public and members-only yet.

A member's RSVP to a members-only event is a standard `community.lexicon.calendar.rsvp` that they
write from their own session into the calendar space, in their own repo there, under the event's
key. It never goes to their public repo, which would publish the event and who is going
(`server/member-rsvp.ts`). It takes the same per-group grant as their acceptance, which also lets
them read their RSVP back.

## Roles and permissions

There are three roles: `owner`, `admin` and `member`. What a role may do is data, written as records
in the members space, and a member may do the union of what their roles are granted. The owner
cannot be demoted, removed or leave; the schema enforces that as well as the code. The published
`permissions` record says so too: each role lists the roles it may assign and eject, and only the
owner's list holds `owner`. A new member gets `member`, the role whose record says `default`.

A role's grant is OAuth scopes on the group DID, in `permissions` and in each space's `access`
record, as the standard has it. Every write as the group is checked against them before it is sent
(`scopes.ts`, `grants.ts`, and the gate in `server/group-write.ts`), the way a group host would check
it. A permission set named with `include:` is expanded from its lexicon, copied into
`lexicons/reference`. A `membership` write also needs every role it adds or removes, and every role
of a member it ejects, to be one the writer's roles may assign. The group DID itself may do anything,
with no record, which is how a group with no admin left recovers: sign in as the group's account.

The pages ask by name, from a fixed vocabulary in `permissions.ts`: `MANAGE_GROUP`, `ADMIT_MEMBERS`,
`EJECT_MEMBERS`, `ASSIGN_ROLES`, `MANAGE_EVENTS` and `CREATE_EVENT`. The first four are questions
asked of the scopes: settings are writing the profile and the about space's `access`, and the roster
acts are creating, deleting and updating a `membership`. The two event names are granted by
`eventPermissions`. atmo still publishes its own roles' scopes from bundles of these names, through
one table in `permissions.ts`. Each space's `access` record grants every role `read` there.

Permissions are read from the members space once per request: every write a request makes shares
that request's reader, and the write gate keeps the caller's standing for it. Nothing is kept
across requests. Another space's `access` record is read only for a write there that `permissions`
does not already allow. A members space that cannot be read grants nothing. D1's `role_permissions`
is a copy of atmo's bundles, which a repair can republish, and never decides what anyone may do: a
group with no permission records, or no members space, grants nothing to anyone but itself.

A private group is invite-only. That is derived, not stored: whatever the profile's join policy or
D1's approval flag says, a group whose PDS reads it as private, or cannot be asked, shows
invite-only and refuses a self-service join. D1's `require_approval` is a plain cache of the
profile's join policy. The create and the settings save also refuse a private group with approval
off, before any write. There is no suspension: removing someone deletes their membership record.
A pending join request is not published as a record.

## Hosting

Creating a group creates a new `did:plc` account on a PDS the deployment chooses. The creator holds
the account: they type its email and password on the create form, and the app passes the password
to the PDS once and keeps neither. Password reset mail for the group goes to the creator. A PDS holds
one account per email, so a creator with several groups plus-addresses their own address. The owner
also receives the account's first PLC rotation key, so they can move the group to another host
without the app.

The app writes as the group only through an OAuth session the owner grants: they sign in at the
group's PDS as the group and approve this app (`server/group-link.ts`), and can revoke it there.
The session asks only for the group's public-repo records, its own spaces and image uploads
(`server/session.ts`). Until the owner links, every write as the group fails and the group
page asks the owner to link. The one exception is the create itself: it sets the new group up with
the session `createAccount` returns, inside that request, and keeps nothing.

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

| name                    | kind   | meaning                                             |
| ----------------------- | ------ | --------------------------------------------------- |
| `GROUP_PDS_SERVICE`     | var    | PDS that new group accounts are created on          |
| `GROUP_HANDLE_DOMAIN`   | var    | handle suffix for groups, e.g. `groups.example.com` |
| `GROUP_PDS_INVITE_CODE` | secret | invite code, when the PDS requires one              |

Linking also needs the deployment's own OAuth client metadata (`OAUTH_PUBLIC_URL` and
`CLIENT_ASSERTION_KEY`) and the `OAUTH_SESSIONS` store. A deployment without them cannot create a
group: the create page shows no form and the server refuses.

- Groups get their own handle domain, so a group handle never competes with a person's handle on
  the same PDS.
- Accounts that share an invite code share its use count, and deleting an account does not give a
  use back.

For a local run, set these in `apps/web/.env` with the app's other local settings. `.env.example`
has them commented out.

## Checks against a live PDS

Unit tests run with `vitest` and need no network. An end-to-end run of the same code against PDSes on
a local atproto-devnet sandbox needs that sandbox's hosts and accounts, so it is kept out of this
repository, on the `test/groups-e2e` branch of `tompscanlan/atmo-events`.
