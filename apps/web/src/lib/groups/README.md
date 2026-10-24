# Groups

A group is an AT Protocol account at an opensocial.group group host, which makes the account and
runs it. Its public events are ordinary `community.lexicon.calendar.*` records in the group's own
repo, so they are indexed and shown like any other account's events. Its members-only events are the
same records in the group's calendar space, which only its members see. Everything else about the
group is also records in its spaces. The host keeps the group's join requests and decides who may
read each space. D1 holds a cache of the records that the app can query, and a note of each join
request sent from this site.

## Where a group's data lives

| what                                                       | where                                                     | who may read           |
| ---------------------------------------------------------- | --------------------------------------------------------- | ---------------------- |
| public events                                              | the group's public repo                                   | anyone                 |
| declaration (makes the group findable)                     | the group's public repo, only while the group is public   | anyone                 |
| profile, rules, access                                     | the about space, of type `group.opensocial.meta`          | the group's visibility |
| roles, permissions, `eventPermissions`, membership, access | the members space, of type `group.opensocial.members`     | its `access` record    |
| members-only events, members' RSVPs to them, access        | the calendar space, of type `rsvp.atmo.group.calendar`    | `admin` and `member`   |
| join requests                                              | the group host                                            | the host decides       |
| a cache of the records above, and a note of each request   | D1, `migrations/0001_groups.sql`                          | the app                |
| the group sessions people linked                           | the `OAUTH_SESSIONS` KV namespace, under `group:session:` | the app                |

The app reads the group's spaces with each caller's own access: a space credential from their own
sign-in, so the host decides what each person sees (`server/about-read.ts`,
`server/route-context.ts`). A signed-out visitor reads no space, since a space needs a login
whatever its policy.

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

Each space has an `access` record, and it is the space's policy: whether anyone may read the space,
and which roles may. The host enforces it for every app, so this site writes no read policy and no
member list (`server/spaces.ts`). The host writes the about and members spaces' records when it
makes the group. This site changes only the about record's `public`, keeping its grants
(`server/about-writer.ts`), and writes the calendar space's when it makes that space. A group with a
declaration must have an about `access` record that says public, so the record is written before a
declaration is published and after one is withdrawn.

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

A group's visibility is its about space's `access.public`, and a missing record means private
(`server/spaces.ts`). D1 has no column for it. The host decides every read of the about space from
that record, so every app sees the same answer. A member on the roster is let in without the
question. When the members space errors, nobody is on the roster for that read, whatever the D1
rows say, so until the space answers a member is treated like anyone else. Anyone else gets the
ordinary 404 when the record says private or the host will not let them read it, and a 503 rather
than a guess when the host does not answer. A caller with no reader sees the group only while it is
declared, and gets the 503 when the declaration cannot be read. Browse shows it from placement
instead, with no space read per group: a group the declaration index lists is public, and one the
caller sees only through their own groups is private. So browse's badge says whether the group is
declared and the page's badge what its access record says, and the two can differ: a save that
changed the record but stopped before the declaration leaves them apart until the next save.

The settings form sends the visibility it showed as well as the one chosen, and the save changes the
visibility only when the two differ, so a tab opened before someone else changed it cannot change it
back. A form that could not show one is refused if its choice differs from the record. Every read
comes before the first write. A save that leaves the group private withdraws the declaration and
only then has the record say private, both before the D1 row takes the new name and description,
because browse shows a declared group's text from that row. The profile and rules come last. A save
that leaves it public has the record say public, writes the row, reads the record again, declares
the group only if it still says public, and then writes the profile and rules. Saving again finishes
one that stopped part way. `update-group.ts` has the whole order and what each failure leaves
behind. There is no lock between that last read and the declaration.

A roster act goes to the host (`server/host.ts`, `server/real-host.ts`). Joining, cancelling a
request and leaving are sent through the person's own PDS. Approving, adding, ejecting and changing
a role are `membership` writes on the acting person's own group session. D1's roster rows follow
each act the host accepted, and its `join_requests` rows are only a note that a person asked: no
method reads a member's own request back, so the note is how a page knows to offer a cancel.

A member's acceptance is their own half of the membership: a record they write from their own
session into their repo in the members space, at an open join, or at a later sign-in that carries
the group's grant (`server/acceptance.ts`). A join request writes none. Leaving deletes it before
the host drops the member (`server/roster.ts`). It decides only whether the roster shows them
confirmed, not what they may do.

The declaration is a pointer to the group, with no name or avatar, so no page should promise an
anonymous reader a group's name. The declaration index holds every declaration on the network, not
only this deployment's groups, and `listGroups` decides what each one may show. An index that was
running before the declaration collection was added to its config needs a one-time
`contrail backfill --only records` to pick up older declarations.

When a record and a D1 row disagree, the record wins. `server/rebuild.ts` rebuilds a group's rows
from its records, and the settings page's "Refresh from the group host" runs it
(`server/refresh.ts`), reading with the caller's own access and writing nothing at the host. It adds
and updates rows but deletes none, so a member who left through another app keeps their row. A
group with no row left is restored from its records: its row from the profile, its roles from the
role and permission records, and its roster from the `membership` records, with the earliest
`admin` recorded as `owner_did`. The restore refuses, before any write, a group with no profile, no
`membership` granting `admin` (as when the last admin has left, which the host allows), or no role
and permission records. A rebuild restores nothing for
the visibility, because nothing in D1 holds it.

## Members-only events

A members-only event is the same `community.lexicon.calendar.event` record as a public one, written
into the group's calendar space instead of its public repo. Nothing on the record says which: the
container is the fact, because the host enforces it for every reader. The calendar space's `access`
record is not public and grants `admin` and `member` a read there, whatever the group's visibility
(`create-at-host.ts`). The app reads the space with the caller's own access, and only for a caller
on the roster. The roster check runs before the read, so a non-member's visit costs the host nothing
(`server/calendar-read.ts`). The space's type is the app's own, not the standard's, and renaming it
would strand what was written under the old name.

Every event command takes the event's placement, `everyone` or `members`, and never a default
(`event-placement.ts`). Before a members-only write, the writer reads the calendar space at the host
and refuses when the space is missing or its policy lets more than the members read it
(`server/event-writer.ts`). An event cannot move between public and members-only yet.

A member's RSVP to a members-only event is a standard `community.lexicon.calendar.rsvp` that they
write from their own session into the calendar space, in their own repo there, under the event's
key. It never goes to their public repo, which would publish the event and who is going
(`server/member-rsvp.ts`). It takes the same per-group grant as their acceptance, which also lets
them read their RSVP back.

## Roles and permissions

A group host makes two roles, `admin` and `member`, and the creator's membership is `admin`. What a
role may do is data, written as records in the members space: scopes on the group DID in
`permissions` and in each space's `access` record, as the standard has it, and the event actions in
`eventPermissions`. A member may do the union of what their roles are granted.

The host checks every write as the group. It cuts each group session to its person's current roles,
and on a `membership` write it checks that every role the write adds or removes is one the writer's
roles may assign. Its refusal is the one a form shows (`server/group-write.ts`). This site's gate
refuses only an anonymous caller for those writes. It checks the caller's scopes itself only for a
write to its own D1 rows, which the host never sees: the settings save's copy of the group and the
refresh (`appOnly`, with `scopes.ts` and `grants.ts`). A permission set named with `include:` is
expanded from its lexicon, copied into `lexicons/reference`.

There is no owner. The creator is an ordinary `admin`, as at the group host:
another admin may demote or remove them, and they may leave, even as the last admin. Those are the
host's rules, and its refusal is the one a form shows; this site adds none of its own
(`server/real-host.ts`). D1 keeps the same two roles. `groups.owner_did` records who created the
group here, is never rewritten, and grants nothing: the group page shows it as "Organized by" to whoever may see the roster, even
after the creator has left.

The pages ask by name, from a fixed vocabulary in `permissions.ts`: `MANAGE_GROUP`, `ADMIT_MEMBERS`,
`EJECT_MEMBERS`, `ASSIGN_ROLES`, `MANAGE_EVENTS` and `CREATE_EVENT`. The first four are questions
asked of the scopes: settings are writing the profile and the about space's `access`, and the roster
acts are creating, deleting and updating a `membership` (`grants.ts`). The two event names are
granted by `eventPermissions`, which the create writes for the host's roles from this site's
default bundles.

Permissions are read from the members space once per request: every check a request makes shares
that request's reader, and nothing is kept across requests. Another space's `access` record is read
only for a write there that `permissions` does not already allow. A members space that cannot be
read grants nothing. D1's `role_permissions` is a copy of this site's default bundles, and never
decides what anyone may do: a group with no permission records, or no members space, grants nothing
to anyone but itself.

A private group is invite-only. That is derived, not stored: whatever the profile's join policy or
D1's approval flag says, a group whose visibility was not read as public shows invite-only
(`about-record.ts`). D1's `require_approval` is a plain cache of the profile's join policy. The
create and the settings save also refuse a private group with approval off, before any write. A join
is the host's to decide, and its `JoinClosed` refusal shows as invite-only. There is no suspension:
removing someone deletes their membership record.

## Hosting

A group lives at an opensocial.group group host (`GROUP_HOST_URL`). Creating a group starts the
app's OAuth flow at the host with `prompt=create` (`create-at-host.ts`): the host signs the creator
in through their own PDS, makes the group's account, its meta and members spaces and their records
(the `admin` and `member` roles, `permissions`, the creator's `admin` membership), and hands this
app a group session the creator approved. No login, no recovery key and no member list passes
through the app: the host keeps all three. Nobody holds a password for the group; the creator acts
for it as themselves, as its first admin.

What the app adds after that is its own: the row, the calendar space (made through the host), the
event bindings for the host's roles, the profile and rules as the form gave them, the meta space's
`public`, and the declaration of a public group. Before it sends the creator to the host, the create
runs its real D1 batch and rolls it back (`rehearseCreateGroup`), so schema drift fails before the
host has made anything.

The app writes as the group only through a group session the acting person linked from the host,
cut to their roles (`server/group-link.ts`, `server/session.ts`). Someone who has linked none cannot
write as the group through this app. A group not at this site's group host is refused before any
write: the roster acts by `groupHost` (`server/host.ts`), event writes and the settings save by
`hostGroupWriter` (`server/group-write.ts`), a link by `startGroupLink`, and a create's callback
when the account that came back is not at the host.

## Configuration

Set on the web Worker. With `GROUP_HOST_URL` unset, the app hides its groups link.

| name             | kind | meaning                                                        |
| ---------------- | ---- | -------------------------------------------------------------- |
| `GROUP_HOST_URL` | var  | the group host groups are made at, e.g. `https://host.example` |

Creating and linking also need the deployment's own OAuth client metadata (`OAUTH_PUBLIC_URL` and
`CLIENT_ASSERTION_KEY`) and the `OAUTH_SESSIONS` store. A deployment without them cannot create a
group: the create page shows no form and the server refuses.

For a local run, set it in `apps/web/.env` with the app's other local settings. `.env.example` has
it commented out.

## Checks against a live group host

Unit tests run with `vitest` and need no network. An end-to-end run of the same code against a live
group host, with real sign-ins, needs a local test network with its own hosts and accounts, so it is
kept out of this repository, on the `test/groups-host-e2e` branch of `tompscanlan/atmo-events`.
