# Groups

A group is an AT Protocol account at an opensocial.group group host, which makes the account and
runs it. Its events are ordinary `community.lexicon.calendar.event` records in the group's public
repo, indexed and shown like any other account's. Everything else about the group is records in
its spaces; D1 holds a cache of them and a note of each join request sent from this site.

## Where a group's data lives

| what                                                     | where                                                     | who may read           |
| -------------------------------------------------------- | --------------------------------------------------------- | ---------------------- |
| events                                                   | the group's public repo                                   | anyone                 |
| members-only events, and members' RSVPs to them          | the calendar space, `rsvp.atmo.group.calendar`            | members                |
| declaration (makes the group findable)                   | the group's public repo, while it is public and listed    | anyone                 |
| profile, rules, access                                   | the meta space, `group.opensocial.meta`                   | the group's visibility |
| roles, permissions, membership, access                   | the members space, `group.opensocial.members`             | its `access` record    |
| each member's acceptance                                 | the member's own repo in the members space                | its `access` record    |
| join requests                                            | the group host                                            | the host decides       |
| a cache of the records above, and a note of each request | D1, `migrations/0001_groups.sql`                          | the app                |
| the group sessions people linked                         | the `OAUTH_SESSIONS` KV namespace, under `group:session:` | the app                |

Spaces are read with each caller's own access, so the host decides what each person sees. Sign-in
asks for `include:group.opensocial.participate` and a grant for RSVPs in any group's calendar space,
and asks for less (the set alone, then the base scope) when the PDS refuses with `invalid_scope`.
When a record and a D1 row disagree, the record wins.

## The records

The records are the ones the opensocial.group proposal drafts as `group.opensocial.*`; this code
calls the meta space the about space, as D1's `about_space_uri` column does. Unchanged copies of
the lexicons it writes are in `lexicons/reference/group/opensocial`, and `record-lexicons.test.ts`
checks every record builder against them.

`@atcute/lex-cli` rejects the proposal's `space-ref` format, so the declaration index reads
`lexicons/custom/group/opensocial/declaration.json`, the proposal's lexicon with `meta` given the
format `uri`. Do not edit it: `pnpm generate` writes it with `scripts/lexicon-shims.mjs` and takes
the NSID back out of the pull list, since it does not resolve. When the tooling reads `space-ref`
and the NSID resolves, delete the copy, the script, its test and its two steps in `pnpm generate`.

## Members-only events

A group's create also makes its calendar space, atmo's own space type, which every role may read
whatever the group's visibility. A members-only event is an ordinary event record placed there
instead of in the public repo, so the container is the only thing that says who may read it:

- The new-event page asks who can see the event before it shows the editor, with no default. An
  event cannot move between public and members-only later, since that would change its URI and
  strand its RSVPs; the writer refuses it, and refuses a write to a calendar space that is missing
  or readable by more than members.
- Members see them on the events tab and on their own page, read with their own access. The index
  never learns of one, so they are not in feeds, search or the public event page.
- A member's RSVP goes into their own repo in the calendar space, citing the event's space URI and
  its current CID. A sign-in without the grant is sent to sign in again once.
- No image is shown, and there are no recurring copies, until both can be done without a public
  link.

The space type has to be published where the group's PDS and its members' PDSes resolve it, as
the group sets are. Its declaration:

```json
{
	"lexicon": 1,
	"id": "rsvp.atmo.group.calendar",
	"defs": {
		"main": {
			"type": "space",
			"key": "literal:self",
			"name": "Group calendar",
			"collections": [
				"community.lexicon.calendar.event",
				"community.lexicon.calendar.rsvp",
				"group.opensocial.access"
			]
		}
	}
}
```

## What a group can and cannot do here

- One group host per deployment: this site changes only groups at its own host.
- A group's visibility is its meta space's `access.public`; join policy (open, approval, invite)
  is the profile's own setting, apart from visibility; a public group can be left unlisted.
- There is no owner. The creator is an ordinary `admin`, and the host's rules on demoting,
  removing and leaving apply to them as to anyone.
- The roster lists a member while both their membership and their own acceptance exist; admins
  also see who was added and has not confirmed. atmo writes the acceptance with the member's own
  sign-in at an open join, at sign-in and on their next visit, never for a pending request, and
  deletes it when they leave. A PDS without spaces cannot hold one.
- Rules are set at create and shown on the group page; editing them is not in this version.
- The settings save writes in a fixed order, so saving again finishes one that stopped partway
  (`update-group.ts`). Browse lists declared groups newest first by when the index saw them.

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
kept out of this repository, on the `test/groups-host-e2e-2` branch of `tompscanlan/atmo-events`.
