# api.atmo.rsvp

One Cloudflare Worker with two runtimes:

- a public **Contrail** index (`rsvp.atmo.*`) of calendar events, RSVPs,
  profiles and personalized network feeds. It includes the public events a
  group account writes to its own public repo; and
- a **Spaces provider** (`net.openmeet.group.*`) for the members-only events and
  RSVPs of a group, read through AT Protocol Spaces.

A group is a PDS account whose writing credential the app holds. Its members-only
records live in the group's `net.openmeet.space.events` Space (key `self`), using
the same `community.lexicon.calendar.*` Lexicons as the public records. A Space
is never anonymously readable, not even under a `public` policy, so public
discovery can only come from the public repo.

## Service identity

Everything follows one origin, `PUBLIC_SERVICE_ENDPOINT`:

| derived value     | with `https://api.atmo.rsvp`     |
| ----------------- | -------------------------------- |
| service DID       | `did:web:api.atmo.rsvp`          |
| Contrail audience | `did:web:api.atmo.rsvp#contrail` |
| Spaces audience   | `did:web:api.atmo.rsvp#spaces`   |

`wrangler.jsonc` sets the origin in `vars`. When it is unset, the code falls back
to `https://api.atmo.test` (`.test` is reserved by RFC 6761). The DID document,
both audiences and the manifest URLs follow the origin.

Secret: `SPACES_CREDENTIAL_ENCRYPTION_KEY`, a 32-byte base64 AES-256-GCM key that
encrypts stored Space credentials and DPoP private keys
(`wrangler secret put SPACES_CREDENTIAL_ENCRYPTION_KEY`). See
[`.dev.vars.example`](.dev.vars.example) for local runs.

## Request routing

`src/dispatcher.ts` is the Worker's `main`. `src/worker.ts` is the
single-runtime Contrail entry and is not used by `wrangler.jsonc`.

| path                                 | handler                                                    |
| ------------------------------------ | ---------------------------------------------------------- |
| `GET /.well-known/did.json`          | merged: both the `#contrail` and `#spaces` service entries |
| `GET /lexicons`                      | merged: public bundle plus Spaces bundle, deduped by NSID  |
| `/.well-known/contrail-spaces-alpha` | Spaces                                                     |
| `/xrpc/com.atproto.space.*`          | Spaces                                                     |
| `/xrpc/com.atproto.simplespace.*`    | Spaces                                                     |
| `/xrpc/net.openmeet.group.*`         | Spaces                                                     |
| everything else                      | Contrail                                                   |

Contrail's paths include `/`, `/status`, `/health`, `/.well-known/contrail`,
`/lexicons/<digest>` and `/xrpc/rsvp.atmo.*`.

Both runtimes answer `/.well-known/did.json` and `/lexicons`, so the dispatcher
merges those two instead of falling through from one runtime to the other.
Non-GET requests to them go to Contrail, which owns the CORS policy.
`/lexicons/<digest>` stays Contrail-only, so the digest published in
`/.well-known/contrail` still matches its bundle.

The cron runs every minute. `scheduled()` runs both runtimes under one
`waitUntil`: the Contrail Jetstream drain is capped at half of a 24-second
window, and the Space reconcile limits itself to five Spaces per tick. `queue()`
belongs to the Spaces runtime (reconcile and repo-sync jobs). No Spaces
subscriptions are configured, so the deployment needs no Durable Object.

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

The generated least-privilege OAuth permission is:

```text
rpc?aud=did:web:api.atmo.rsvp%23contrail&lxm=rsvp.atmo.getFeed&lxm=rsvp.atmo.notifyOfUpdate
```

`notifyOfUpdate` is an authenticated hint to index a record now. The public half
has no user sessions and never writes records to a user's PDS.

The checked-in custom query Lexicons mirror the generated event `listRecords`
response and parameters on purpose. `tests/lexicons.test.ts` detects drift if
the base event query contract changes.

## Members-only contract

Spaces methods use exact, method-bound AT Protocol service auth (audience
`<serviceDid>#spaces`), so this Worker holds no user sessions.

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

Read path: a signed-in user gets a delegation token from the authority PDS.
`authorizeSpace` exchanges it for a DPoP-bound Space credential, stores it
encrypted and queues a reconcile. The synced records land in Contrail's isolated
tables, keyed per Space generation, and `listSpaceRecords` serves them to callers
that hold a live access lease. Unlike the public index, Space records are
validated against the bundled Lexicons with CID verification.

Writes stay with the group: `com.atproto.space.createRecord` requires `repo` to
be the authenticated DID, so only the group's own credential can write the
group's Space records.

## Development

From the repository root:

```bash
pnpm --filter api lexicons:all
pnpm --filter api typecheck      # contrail lexicons check --public && tsc --noEmit
pnpm --filter api test
pnpm --filter api dev
pnpm --filter api deploy:dry-run
```

### Spaces end-to-end check

```bash
pnpm --filter api e2e:spaces
```

The script builds the Worker with `wrangler deploy --dry-run`, runs the bundle
in-process on workerd through Miniflare with an empty D1, and drives the
members-only path against a live PDS. The group writes an event into its events
Space, a member's delegation token is exchanged for a Space credential, the
Space is synced and projected, and the member reads the record back. A
non-member with a valid service-auth token and an anonymous caller are both
refused. The script deletes the record it wrote, prints a PASS/FAIL summary and
exits non-zero on failure.

The fixture comes from the environment:

| variable                | meaning                                                                                                                                                      |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `E2E_PDS`               | PDS that hosts the fixture accounts                                                                                                                          |
| `E2E_GROUP_DID`         | the group account's DID; its `net.openmeet.space.events` Space must already exist                                                                            |
| `E2E_GROUP_HANDLE`      | the group's handle                                                                                                                                           |
| `E2E_MEMBER_HANDLE`     | an account on the Space's member list                                                                                                                        |
| `E2E_NON_MEMBER_HANDLE` | an account that is not on it                                                                                                                                 |
| `E2E_CREDENTIALS`       | env file with `SPIKE_GROUP_PASSWORD`, `SPIKE_ALICE_PASSWORD` (member) and `SPIKE_MALLORY_PASSWORD` (non-member); defaults to `$HOME/.spaces-alpha-creds.env` |
| `SPACES_E2E_ENDPOINT`   | optional origin the Worker advertises; defaults to `https://api.atmo.test`                                                                                   |

Passwords are never printed. A `401` from `createSession` means they are stale.

## Deployment preparation

`wrangler.jsonc` carries a placeholder D1 database id. Before activating:

1. check that `PUBLIC_SERVICE_ENDPOINT` and the custom-domain route name the
   origin you deploy;
2. create a fresh D1 database and replace the placeholder binding. Do not attach
   the web app's existing Contrail database;
3. create the `atmo-rsvp-spaces` queue and put the
   `SPACES_CREDENTIAL_ENCRYPTION_KEY` secret;
4. backfill and replay into the new database;
5. verify record, FTS, relation, cursor, discovery, CORS and service-auth
   behavior, plus the Space authorize, sync and read path; and
6. activate the Worker, queue and D1 binding together, keeping the previous
   database for rollback.
