# openmeet-atmo-api

One Cloudflare Worker serving both halves of an OpenMeet group's calendar data:

- a **public Contrail index** (`rsvp.atmo.*`) over `community.lexicon.calendar.*`
  records — including the public events a group account writes into its own
  public repo, which are anonymously readable and indexable; and
- a **Spaces provider** (`net.openmeet.group.*`) over the members-only slice of
  a group, read through AT Protocol Spaces.

A group is a custodial PDS account whose signing credential the app holds.
Roster, roles, and permissions are application rows, never protocol records, and
no membership Lexicon is invented here. Space records use the cross-app
`community.lexicon.calendar.*` Lexicons; the Space *type* `net.openmeet.group`
is a host-side kind.

The public/private split is deliberate: a Space is never anonymously readable —
not even under a `public` policy, which returns `401 AuthMissing` to an
anonymous caller — so public discovery can only come from the public repo.

## Service identity

Everything follows one origin, `PUBLIC_SERVICE_ENDPOINT`:

| derived value | example |
| --- | --- |
| service DID | `did:web:api.openmeet.test` |
| Contrail audience | `did:web:api.openmeet.test#contrail` |
| Spaces audience | `did:web:api.openmeet.test#spaces` |

The committed default is `https://api.openmeet.test` — `.test` is reserved by
RFC 6761, so no deployment domain is claimed from a checked-in file. Set the
real origin in `wrangler.jsonc` `vars` (or as a Worker secret) at deploy time;
the DID document, both audiences, and the manifest URLs follow automatically.

Secrets: `SPACES_CREDENTIAL_ENCRYPTION_KEY`, a 32-byte base64 AES-256-GCM key
wrapping stored Space credentials and DPoP private keys
(`wrangler secret put SPACES_CREDENTIAL_ENCRYPTION_KEY`). See
[`.dev.vars.example`](.dev.vars.example) for local runs.

## Request routing

Both runtimes answer `/.well-known/did.json` and `/lexicons`, so
`src/openmeet-worker.ts` dispatches explicitly rather than falling through — a
fallthrough would silently publish one service entry and hide the other. It is
the Worker's `main` in `wrangler.jsonc`; `src/worker.ts` stays upstream's
single-runtime entry, unedited, so it never conflicts on an upstream pull.

| path | handler |
| --- | --- |
| `GET /.well-known/did.json` | **merged**: both `#contrail` and `#spaces` service entries |
| `GET /lexicons` | **merged**: public bundle + Space provider bundle, deduped by NSID |
| `/.well-known/contrail-spaces-alpha` | Spaces |
| `/xrpc/com.atproto.space.*` | Spaces |
| `/xrpc/com.atproto.simplespace.*` | Spaces |
| `/xrpc/net.openmeet.group.*` | Spaces |
| everything else (`/`, `/status`, `/health`, `/.well-known/contrail`, `/lexicons/<digest>`, `/xrpc/rsvp.atmo.*`) | Contrail |

`/lexicons/<digest>` stays Contrail-only, so the digest published in
`/.well-known/contrail` still verifies against an unmerged bundle.

`scheduled()` fans out to both runtimes under one settled `waitUntil`: the
Jetstream drain is capped at half the cron window (`scheduledIngest.maxDrainMs`)
so it cannot starve the Space reconcile slice, which self-bounds at five Spaces
per tick. `queue()` belongs to the Spaces runtime (reconcile and repo-sync
jobs). Subscriptions are deliberately not configured, which is what keeps the
Durable Object out of this deployment.

## Public contract

Anonymous XRPC methods:

```text
rsvp.atmo.getCursor
rsvp.atmo.getProfile
rsvp.atmo.event.getRecord
rsvp.atmo.event.listRecords
rsvp.atmo.event.listDiscoverable
rsvp.atmo.event.listDiscoverableByUris
rsvp.atmo.event.listAuthored
rsvp.atmo.event.listTalks
rsvp.atmo.rsvp.getRecord
rsvp.atmo.rsvp.listRecords
```

Protected AT Protocol service-auth methods (audience `<serviceDid>#contrail`):

```text
rsvp.atmo.getFeed
rsvp.atmo.notifyOfUpdate
```

`notifyOfUpdate` is an authenticated immediate-indexing hint. The public half
has no user sessions and never writes records to a user's PDS.

The checked-in custom query Lexicons intentionally mirror the generated event
`listRecords` response and parameters; `tests/lexicons.test.ts` detects drift if
the base event query contract changes.

## Members-only contract

Space methods are exact, method-bound AT Protocol service auth (audience
`<serviceDid>#spaces`): the web app owns OAuth and mints one token per call, so
this Worker holds no user sessions.

```text
net.openmeet.group.authorizeSpace          # delegation token -> Space credential
net.openmeet.group.syncSpace
net.openmeet.group.listSpaces
net.openmeet.group.event.listSpaceRecords
net.openmeet.group.event.getSpaceRecord
net.openmeet.group.rsvp.listSpaceRecords
net.openmeet.group.rsvp.getSpaceRecord
```

PDS callbacks: `com.atproto.space.notifyWrite`,
`com.atproto.space.notifySpaceDeleted`.

Read path: the user's session mints a delegation token at the authority PDS ->
`authorizeSpace` exchanges it for a DPoP-bound Space credential, stores it
encrypted, and queues a reconcile -> synced records land in Contrail's isolated
tables, keyed per Space generation -> `listSpaceRecords` serves them to callers
holding a live access lease. Space records are validated against the pinned
Lexicon bundle with CID verification (`validate: true`), unlike the permissive
public index.

Writes stay with the custodian: `com.atproto.space.createRecord` requires
`repo === ` the authenticated DID, so only the group's own credential can write
the group's Space records.

## Development

From the repository root:

```bash
pnpm --filter api lexicons:all
pnpm --filter api typecheck      # contrail lexicons check --public && tsc --noEmit
pnpm --filter api test
pnpm --filter api dev
pnpm --filter api deploy:dry-run
```

### Live Spaces end-to-end

```bash
node apps/api/scripts/spaces-e2e.mjs
```

Boots `wrangler dev` on a scratch persistence directory and runs the whole
members-only path against the live fixture PDS (`https://pds.opnmt.net`, Space
`at://did:plc:jcwgw6fcnb5vyoid7nz7sl26/space/net.openmeet.group/kona`): the
group writes a Space record as its own custodian, a member's delegation token is
exchanged for a Space credential, the Space is synced and projected, the member
reads the record back, and both a non-member (with a valid service-auth token)
and an anonymous caller are refused. It prints a PASS/FAIL summary and exits
non-zero on failure.

Fixture app passwords are read from `$HOME/.spaces-alpha-creds.env` (written by
`infra/spaces-alpha/seed.sh`), falling back to
`/workspaces/scratch/spaces-alpha-pds/spike-creds.env`, and are never printed. A
`401` from `createSession` means those passwords are stale — re-run
`infra/spaces-alpha/seed.sh --apply --reset-passwords`.

Overrides: `SPACES_E2E_PORT`, `SPACES_E2E_ENDPOINT`, `SPACES_E2E_PDS`.

## Deployment preparation

`wrangler.jsonc` deliberately contains a placeholder D1 generation and claims no
route. Before activating:

1. set `PUBLIC_SERVICE_ENDPOINT` to the real origin and attach the route or
   custom domain for it;
2. create a fresh immutable D1 generation and replace the placeholder binding —
   do not attach the web app's existing Contrail database;
3. create the `openmeet-atmo-spaces` queue and put the
   `SPACES_CREDENTIAL_ENCRYPTION_KEY` secret;
4. backfill and replay into that generation;
5. verify record, FTS, relation, cursor, discovery, CORS, and service-auth
   behavior, plus the Space authorize/sync/read path; and
6. activate the Worker, queue, and D1 binding together, retaining the previous
   generation for rollback.
