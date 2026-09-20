# atmo.rsvp

events for the open social web, built on atproto.

https://atmo.rsvp

uses `community.lexicon.calendar.event` and `community.lexicon.calendar.rsvp`.

features:

- event creation
- rsvp to events
- add your events to any ical compatible calendar
  (go to calendar/ when signed in and click "Add to your calendar")
- post your events/rsvps to bluesky or anywhere else with nice open-graph images
- display comments
- show what events your bsky follows are going to

## development

clone repo

```
pnpm install
```

set remote to false in `wrangler.jsonc` L22:

```
"remote": false
```

optionally if you want all current events to be displayed run this: (will take a few minutes)

```
pnpm backfill
```

start dev server:

```
pnpm run dev
```

## search (optional)

text search and "near me" are an opt-in feature backed by [meilisearch](https://www.meilisearch.com/). when it's not configured the app falls back to a d1 `LIKE` query for search and hides near-me, so you can skip this entirely.

to enable it locally, run a meili instance:

```
docker run -p 7700:7700 getmeili/meilisearch:v1.10
```

then set the search vars in `.env` (see `.env.example`):

- `SEARCH_URL` / `SEARCH_API_KEY` — the read path (search + near-me). use a read-only key. `SEARCH_INDEX` defaults to `events` and is the single index var shared by both paths.
- `SEARCH_SINK_URL` / `SEARCH_SINK_API_KEY` — the write path; the cron ingest forwards event records into the index. use the admin key. the index is `SEARCH_INDEX` (the sink writes the same index the read path reads).

the read and write keys are kept separate on purpose so the browser-facing read path never holds the admin key. the index is populated by the same cron ingest that fills d1, so once configured a `pnpm backfill` (or normal ingest) will fill it.

**rollout order on an existing deployment.** the sink only indexes records applied _after_ it's enabled, so don't turn on the read path first or existing upcoming events vanish from search until they're next touched. instead: (1) set the write vars and let the sink arm, (2) populate the index (see below) and confirm the meili `events` index count looks right, then (3) set the read vars (`SEARCH_URL` / `SEARCH_API_KEY`). until step 3 the app keeps using the d1 fallback, so search stays working throughout.

**populating the index.** backfill and refresh now feed the sink, so `pnpm backfill` fills meili as it walks each user's pds. on an existing deployment the event records are usually already in d1, so `pnpm meili:reindex` is faster: it replays the stored `community.lexicon.calendar.event` rows straight from d1 into the index with no network walk and no d1 writes. both paths apply the same discoverable filter as live ingest, and the sink applies the index settings on its first write, so a fresh index gets the right filterable fields and re-running either is idempotent. `pnpm meili:reindex:remote` targets the deployed d1 and needs the same wrangler `env.production` that `pnpm backfill:remote` uses.

### Near-me geocoding (optional)

Many events carry only a street address, no coordinates — so they never surface in near-me, which filters on the Meilisearch document's `_geo`. This resolves those addresses to coordinates and writes `_geo` back into the same index, making address-only events near-me-visible. It layers on top of the sink above: no extra service — it rides the existing cron and writes the same index. Leave it untouched and it runs keyless against public [Nominatim](https://nominatim.org/) at a safe trickle; until an address resolves, that event simply stays out of near-me.

**How it runs.** The cron already calls a geocode "drip" every minute; it self-throttles to once per ~30 min via a D1 marker, resolves up to 50 new addresses per run (25 on public Nominatim), and `PATCH`es `_geo` into Meilisearch. Every result is cached — including negative results, so an ungeocodable address isn't retried every run. There is nothing to set up: like the app's other D1 tables, the geocode cache and its cadence marker are defined in code and self-heal on first run. The drip no-ops entirely until the **write sink** above is configured, so enabling search is the only switch.

**Picking a geocoder.** The default is keyless public OSM Nominatim — fine for the steady-state drip's low volume. Set `GEOCODER_USER_AGENT` to a string identifying your deployment (Nominatim's [usage policy](https://operations.osmfoundation.org/policies/nominatim/) requires a real contact; on the public host the per-run cap is held to 25 and the throttle floored to ≥1 req/s). For real volume — and for the bulk backfill below — use [LocationIQ](https://locationiq.com/) (an API-compatible hosted Nominatim): set `GEOCODER_URL=https://us1.locationiq.com/v1/search` and `GEOCODER_KEY`, which lifts the per-run cap to 50 and honors your `GEOCODE_SLEEP_MS` (minimum ms between calls, default 1100). A key with an unset or public `GEOCODER_URL` is *ignored* — you stay on public Nominatim — so always set the URL too.

**Backfilling an existing corpus.** The drip only trickles, so to resolve a backlog run the off-Cloudflare CLI against the deployed D1: `pnpm -C apps/web geocode:backfill --limit 50`. It reaches D1 over the REST API, so it needs `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_API_TOKEN` / `D1_DATABASE_ID` and `MEILI_URL` / `MEILI_KEY` (plus `SEARCH_INDEX` if not `events`), and a LocationIQ `GEOCODER_URL` / `GEOCODER_KEY`. It refuses a bulk or uncapped run against public Nominatim (keyless is capped to `--limit 1..25`). Useful flags: `--limit N` (`0` = no cap), `--dry-run`, `--retry-negative` (re-attempt negatively-cached addresses), and `--allow-public-nominatim` (override the public-host guard). Like search itself, geocoding only helps once the sink is feeding the index, so run this after the rollout steps above.

## Load-more pagination

Every paginated list — the home feed, a profile's hosting and past events, a topic, and search — is defined once in `queries.ts` and continued by one shared mechanism.

**One definition, two entry points.** Page 1 runs in a route's `load()`, which has `url`/`params`; load-more runs in a remote command, which has only a cursor. A keyset is specific to the query that produced it, so page 2 is adjacent to page 1 only while every filter, sort, bound and limit agrees. Both entry points therefore call the same definition, which also owns any post-filter and mints the envelope that continues it.

**The envelope.** The continuation cursor is an opaque `base64url(JSON { v, q, args?, raw })`. `q` names the server-side query (`events`, `hosting`, `past-events`, `topic`, `search-d1`, `search-meili`); `args` carries only public-safe scope (profile actor, topic slug, popular toggle); `raw` is the backend-native cursor — a D1 keyset, or a Meilisearch offset that `tagCursor` prefixes as `meili:<n>`. The client echoes the whole token back unchanged and supplies no filters of its own. Naming the query is what keeps a cursor with its backend: read a D1 keyset as a Meili offset and `Number(base64url)` is `NaN`, which collapses to offset 0 — page 1 again, silently.

**Why that's safe.** Every filter value lives in the query definition, so a tampered token can only name another already-public query or fail to decode; the unlisted-inclusive plain `listRecords` pipeline has no registry entry, so no cursor reaches it. `decodeCursor` never throws — anything malformed, including a pre-envelope `meili:`/`d1:` cursor, just ends pagination. A deep-linked `?cursor=` resumes only when the envelope was minted for the same `q` **and** the same scope, since a `/topics/ai` keyset indexes a different result set than a `/topics/technology` one. Search never resumes a deep link at all: its term rides `?q=`, not the envelope, so an inbound cursor can't be proven to match the route's term.

**The pieces.** `queries.ts` defines each list and mints its envelope. `cursor.ts` encodes/decodes envelopes and tags backend cursors. `events-load-more.ts` holds the resumer registry: it validates a decoded envelope's args and names which query to continue. Each route's `+page.server.ts` calls its query for page 1 and adds whatever else that page renders; `EventList.svelte` echoes the token on "load more" — keyed on the cursor, not on the page having events, since a query with a post-filter (`past-events`) can return a short or empty page while more pages remain. Adding a list means defining its query and registering it.

## Live end-to-end proofs

Two scripts run the two halves of the group model against the **dev fixture PDS** `https://pds.opnmt.net` (never production). Both print `PASS`/`FAIL` per check, end in `SUMMARY: N passed, M failed`, exit non-zero on failure, and delete every record they write — except the `self`- and role-keyed control-plane records, whose fixed keys a re-run overwrites rather than accumulates.

```bash
node apps/web/scripts/groups-e2e.mjs    # the group: roster, roles, custodial authorship
node apps/api/scripts/spaces-e2e.mjs    # the members-only slice: Spaces delegation and projection
```

**What the groups proof shows (18 checks).** A group bound to the existing custodial DID `did:plc:jcwgw6fcnb5vyoid7nz7sl26` gets exactly one active owner membership and the three seeded roles with their pared bundles (owner 6 / admin 6 / member 0); a join under `require_approval` lands as a PENDING request and not on the roster; approval then promotion to admin adds `MANAGE_EVENTS`; the owner's event is persisted **authored by the group DID**; an admin who did not create that event edits it and the record is *still* the group's, with no copy in the admin's own repo — the co-editing-by-custody requirement, and the one legacy openmeet gets wrong by writing as the admin; a non-member's identical edit is refused; a member can leave and the owner cannot; a location with no country is written without an address entry rather than refused. Then the control plane, as records: the `profile` and `rule` records read back out of the about space, an edit to one rule leaving the other two rules' URIs byte-identical, a corrupted cache rebuilt from records; the roster as `membership` records keyed by member DID with the space's own member list left empty; the **authz config** as one `role` record per role plus two binding records — the community four published under the standard's identifiers (`community.configure` / `admit` / `eject` / `role.assign`), the event two under ours — with a role's effective grant the union of both; and finally that dropping the roster's D1 rows loses nothing, that a suspension revokes the membership record, and that a DID with no such record has no access.

Every authorship claim is re-read from the PDS with an unauthenticated `com.atproto.repo.getRecord` / `listRecords`, so it does not rest on the writer's return value.

**What the Spaces proof shows (9 checks).** The group writes a record into its Space as its own custodian, a member's delegation token is exchanged for a DPoP-bound Space credential, the Space is synced and projected into the isolated tables, the member reads the record back, and both a non-member holding a valid service-auth token and an anonymous caller are refused.

**How they run.** Both boot the real Worker code in-process on workerd via Miniflare and address it with `dispatchFetch` — `wrangler dev` and Miniflare's `getD1Database` magic proxy both accept the connection and never answer in the dev container, so neither script uses them. The groups script bundles `apps/web/scripts/groups-e2e.worker.ts` with Vite (a JSON door onto `$lib/groups/**`, holding no rule of its own) and runs the group layer on a scratch D1 that is deleted on exit; the Spaces script runs the bundle `wrangler deploy --dry-run` produces.

**Credentials.** Fixture app passwords are read from `$HOME/.spaces-alpha-creds.env` (written by `infra/spaces-alpha/seed.sh`), never printed, and handed to the Worker as the same `GROUP_CREDENTIALS` secret production uses. A `401` from `createSession` means they are stale — re-run `infra/spaces-alpha/seed.sh --apply --reset-passwords`. Overrides: `GROUPS_E2E_PDS`, and `SPACES_E2E_PDS` / `SPACES_E2E_ENDPOINT` for the Spaces script.

## contributing

open for contributions by all :)
