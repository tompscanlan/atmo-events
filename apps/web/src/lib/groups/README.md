# Groups

A group is an AT Protocol account at an opensocial.group group host, which makes the account and
runs it. Its events are ordinary `community.lexicon.calendar.event` records in the group's public
repo, indexed and shown like any other account's. Everything else about the group is records in
its spaces; D1 holds a cache of them and a note of each join request sent from this site.

## Where a group's data lives

| what                                                     | where                                                     | who may read           |
| -------------------------------------------------------- | --------------------------------------------------------- | ---------------------- |
| events                                                   | the group's public repo                                   | anyone                 |
| declaration (makes the group findable)                   | the group's public repo, while it is public and listed    | anyone                 |
| profile, rules, access                                   | the meta space, `group.opensocial.meta`                   | the group's visibility |
| roles, permissions, membership, access                   | the members space, `group.opensocial.members`             | its `access` record    |
| join requests                                            | the group host                                            | the host decides       |
| a cache of the records above, and a note of each request | D1, `migrations/0001_groups.sql`                          | the app                |
| the group sessions people linked                         | the `OAUTH_SESSIONS` KV namespace, under `group:session:` | the app                |

Spaces are read with each caller's own access, so the host decides what each person sees. Sign-in
asks for `include:group.opensocial.participate` and falls back to the base scope when the PDS
refuses it with `invalid_scope`. When a record and a D1 row disagree, the record wins.

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

## What a group can and cannot do here

- One group host per deployment: this site changes only groups at its own host.
- A group's visibility is its meta space's `access.public`; join policy (open, approval, invite)
  is the profile's own setting, apart from visibility; a public group can be left unlisted.
- There is no owner. The creator is an ordinary `admin`, and the host's rules on demoting,
  removing and leaving apply to them as to anyone.
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
