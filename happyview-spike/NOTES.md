# HappyView Read-Path Spike — Friction Notes

> Living doc. Task 0 (preflight) findings recorded below; later sections filled
> per task. The headline so far: the plan's HappyView API model was wrong in
> several structural ways — correcting it is itself the friction signal.

## Task 0 — runtime ground truth (HappyView HEAD e834a30, Postgres backend)

Confirmed by reading source (`~/openmeet/happyview/src`) + a throwaway probe script.

### Admin API — lexicon registration (plan was WRONG)
- `POST /admin/lexicons` body is `{ "lexicon_json": <full lexicon doc> }`, where
  the doc must be a real lexicon: `{ "lexicon": 1, "id": "...", "defs": { "main": {...} } }`
  and must parse via `ParsedLexicon::parse`. The plan's
  `{id, lexicon_type, script_type, source}` is rejected (`missing field 'lexicon_json'`).
- Upshot: we register atmo's OWN generated lexicon docs
  (`apps/web/lexicons/generated/rsvp/atmo/...`) verbatim → guarantees param
  coercion + output-schema parity with the @atcute client. We do NOT hand-write
  lexicon JSON for the endpoints that already have a generated doc.
  - Present in generated dir: `event/listRecords`, `event/getRecord`,
    `rsvp/listRecords`, `rsvp/getRecord`, `getProfile`.
  - NOT present (must hand-write a lexicon doc): `event.listDiscoverable`.
    => need to confirm atmo even calls listDiscoverable, or whether discovery
       uses getFeed/getOverview. (Resolve in Task 3.)

### XRPC auth/identification (plan was WRONG)
- `/xrpc/*` queries are PUBLIC (no DPoP/JWT required for reads), BUT every call
  must carry a rate-limit client identity: `X-Client-Key: <key>` header (or
  `?client_key=<key>`). Missing it → 401 "Missing client identification."
- `Authorization: Bearer <admin key>` does NOT satisfy this — using it (as the
  plan's parity.sh and client.ts do) yields 401.
- Therefore: parity.sh uses `-H "X-Client-Key: $KEY"`; the atmo HappyView client
  (Task 1) must send `X-Client-Key`, not a Bearer header.

### A query NSID → Lua script binding
- Dispatch: `/xrpc/<nsid>` runs the Lua script registered at trigger
  `xrpc.query:<nsid>` if one exists; otherwise falls back to a default
  list/get-record flow keyed off the lexicon's `target_collection`.
- Query params are auto-coerced to lexicon-declared types before the script runs
  (so `limit:integer` arrives as a number, not "50"). Declare param types in the
  lexicon and `params.limit` etc. are already typed in Lua.

### Lua sandbox / db.* API (plan's record shape was WRONG)
- Each script executes in a FRESH `create_sandbox()` — NO shared globals across
  scripts. Helpers (rsvp_counts, rkey_of, did_of, hydrate_rsvps, profile_for)
  must be INLINED in every script. There is no shared `_helpers.lua` mechanism.
- `db.query{collection, did?, limit?, cursor?, sort?, sortDirection?, filter?}`
  returns `{ records = [...], cursor? }`. Each record is **the record body with
  its fields at top level, plus an injected `uri`** — there is NO `.record`/
  `.value` wrapper, NO `.did`, NO `.cid`. Example record:
  `{ ["$type"]=..., name=..., startsAt=..., status=..., uri="at://did/coll/rkey" }`.
  - So: `value` (atmo envelope body) = the record table itself; `did` and `rkey`
    must be parsed from `uri`; `cid` is unavailable here.
- `db.get(uri)` → same top-level shape (body + injected uri) or nil.
- `db.backlinks{collection, uri, did?, limit?, cursor?}` → `{records, cursor?}`,
  same record shape; joins via `record_refs (source_uri -> target_uri)`.
- `db.count(collection, did?)` → integer.
- `db.raw(sql, params?)` runs SQL **verbatim** (NOT through adapt_sql): must be
  native Postgres (`$1,$2` placeholders). Columns map to Lua by type; a JSONB
  `record` column comes back **nil** unless cast — use `record::text AS record`
  then `json.decode(row.record)`. `db.raw` is the only way to get `cid`/`did`
  directly (SELECT them), so count-filtered discovery (Task 3) uses db.raw.
- `db.backend()` → "postgres" here.
- Filter format (db.query): a condition is `{field, op, value}` where `op` ∈
  `{"=","!=","<",">","<=",">=","LIKE","NOT LIKE"}` (NOT "eq"/"gte"). A group is
  `{combine="and"|"or", <child1>, <child2>, ...}` with children as POSITIONAL
  array elements (NOT `{op=..., conditions=[...]}`). Field paths support dot
  notation (`subject.uri`) and are translated to Postgres jsonb chains.

### atmo consumer requirements (what the envelope must carry)
- `flattenEventRecord` (src/lib/contrail.ts): body from `.value` (top-level) or
  `.record` (hydrated sub-record); reads `.uri .did .rkey` directly; `cid` is
  `record.cid ?? null` → **cid is OPTIONAL**. So list/get envelopes need
  `{uri, did, rkey, value}` (+ optional counts/rsvps); cid may be omitted.
  => simple list/get endpoints can use db.query (parse did/rkey from uri, no cid).
- `getProfileBlobUrl(did, blob)` builds `cdn.bsky.app/img/feed_thumbnail/plain/
  <did>/<blobCid>@webp` from a blob's `ref.$link` or `cid`. So getProfile should
  return the avatar as the raw blob object (atmo derives the URL), not a string.

### Data scale (for count-latency measurement, Task 7)
- 15,614 records: 10,560 `community.lexicon.calendar.event` + 5,054
  `community.lexicon.calendar.rsvp`. From prod Jetstream.

## Lua authoring effort
- **A Lua array cannot hold `nil` in a middle slot.** The natural "static SQL +
  positional NULL-guards" pattern — `WHERE ($2 IS NULL OR col=$2)` with
  `db.raw(sql, { a, params.maybe, c })` — silently breaks when an optional middle
  param is absent: the array collapses/misaligns and Postgres gets the wrong arg
  count → 500. It only *appears* to work when the sole optional param is the LAST
  positional one (as in listDiscoverable, whose only nil-able arg, startsAtMin, was
  always supplied in tests — a latent trap). rsvp.listRecords has up to 5 optional
  filters, so it must build the WHERE clause dynamically, appending a placeholder +
  arg only when a filter is present, keeping the args array dense. This is real
  endpoint-specific-Lua friction Contrail's declarative filter config would not impose.
- Per-script helper duplication continues: did_of/rkey_of/norm_status/status_bucket
  are copy-pasted into every script (fresh sandbox, no shared module). Four scripts
  so far, each re-declaring the same ~6 lines.

## Response-shape fidelity
- **HappyView does NOT validate a query script's return against the lexicon's
  declared `output` schema.** `execute_query_script` (execute.rs:865-971) calls
  `handle()`, runs `lua.from_value(result)`, and returns that JSON verbatim — no
  schema check. So `output.required` (e.g. getRecord's `time_us`, `collection`)
  is decorative for scripts; every response field is hand-assembled in Lua and
  unchecked. Parity is driven entirely by what atmo's *consumer* reads, not by the
  lexicon. (Friction: the lexicon buys param coercion only, not response safety;
  a typo'd field name fails silently downstream, not at the appview.)
- **`rsvps` hydration must be a GROUPED object, not a flat array.** atmo's
  `buildEventAttendees` (contrail.ts) reads `rsvps.going` / `rsvps.interested`, and
  `EventRsvps` is shared across listRecords + getRecord. So all three event
  endpoints return `rsvps = {going:[], interested:[], notgoing:[], other:[]}` where
  each entry is `{uri, did, rkey, record=<rsvp body>}` (sub-record body keyed
  `record`, matching the lexicon's `#hydrateRsvpsRecord`, not `value`). Caught only
  by reading the consumer — the first cut returned flat arrays and the lexicon's
  non-validation would have shipped it; the discover-feed avatar stacks
  (`rsvps.going`) would have silently been empty. Status bucketed via the same
  split_part normalization used for counts.
- getRecord: a single `db.raw` returns the event body (TEXT `record` → json.decode),
  `cid`, and all four counts via correlated subqueries — one round trip for scalars;
  `hydrateRsvps` adds one `db.backlinks`. Returns `value` SINGULAR (not `records`).
- **Empty Lua table → JSON `{}`, never `[]` — and it broke a real page.** The
  `json` global exposes only encode/decode (no array sentinel), and `lua.from_value`
  serializes an empty table as a JSON object. So a grouped-rsvps envelope that
  pre-created `{going={}, interested={}, ...}` emitted `"going": {}` for empty
  buckets. The consumer's guard is `(rsvps?.going ?? []).map(...)` — `?? []` only
  catches `undefined`, so `{}` sails through and `.map` throws. This surfaced as a
  hard 500 on the **calendar page** (`event.listRecords` + hydrateRsvps), NOT in
  parity.sh — because the test event had non-empty buckets. Fix: build buckets
  lazily and OMIT empties, so the key is absent and `?? []` applies. Same hazard for
  empty `profiles` (`{}` → `profiles?.find` throws), fixed by omitting when empty.
  This is the sharpest finding of the spike: the appview can't express "empty
  array," the lexicon doesn't validate output, and parity.sh missed it — only
  rendering a real page with sparse data caught it. Endpoint-specific Lua scripts put
  the entire empty-collection contract on the script author. (Throughout this doc,
  "endpoint-specific Lua scripts" = the custom Lua query handler maintained per XRPC
  endpoint, as contrasted with Contrail's declarative config/codegen path.)

## RSVP counts (the materialization gap)
- HappyView stores no materialized counts. Every event's rsvpsCount /
  going/interested/notgoing is computed at QUERY TIME by scanning the rsvp
  collection: `event.listRecords` does one batched `GROUP BY subject.uri, status`
  over the page's event uris; `listDiscoverable` LEFT JOINs a grouped counts
  subquery; `getRecord` uses four correlated subqueries. All normalize status with
  `split_part(status,'#',-1)` because the data mixes bare (`going`) and qualified
  (`...#going`) forms.
- Consequence: count cost scales with rsvp volume per query, not O(1). At spike
  scale (5,070 rsvps) it's fine; at real scale this is the kind of thing Contrail's
  declarative relation/aggregation config would materialize once. The
  endpoint-specific Lua scripts re-derive counts on every read, and get the status
  normalization right by hand (the first cut mis-tallied because `"notgoing"`
  contains `"going"`).

## Scope note: the global HAPPYVIEW_URL switch (NOT counted as friction)
- The flag is a single switch inside `getServerClient` (contrail/index.ts:34): set
  `HAPPYVIEW_URL` and every server-side read routes to HappyView. The `getServerClient`
  surface spans 22 `rsvp.atmo.*` nsids (`space.*` ×10, `notifyOfUpdate`, `getFeed`,
  `permissionSet`, `invite.*` ×4, plus the read endpoints); the spike implemented 5.
- As a spike instrument this is fine — we exercised only the in-scope public read
  pages (discover/events/calendar/event-detail), which use only the implemented
  endpoints. Recorded here just so the blast radius is documented.
- This is explicitly NOT a friction point: making the switch per-endpoint (route the
  implemented nsids to HappyView, leave the rest in-process) is a small, well-understood
  change, not a structural obstacle.

## Profiles
- **Profiles are a THIRD collection that the event+rsvp ingest does not include.**
  The seeded DB had 10,574 events + 5,070 rsvps and ZERO `app.bsky.actor.profile`
  records. Serving host/attendee names+avatars requires separately registering the
  profile record lexicon and populating it — so "serve the read path" is really
  three ingest streams, not one. (Same in kind for in-process Contrail, but the
  spike makes the dependency explicit.)
- **No `app.bsky.actor.profile` lexicon ships with atmo** (atmo only generates its
  own `rsvp.atmo.*` + `community.lexicon.*`). Had to hand-write a minimal record
  lexicon doc (`happyview-spike/lexicons/app.bsky.actor.profile.json`) to make the
  collection ingestable + backfill-eligible. Friction: one more hand-maintained
  lexicon, and it's a Bluesky-owned schema we're now vendoring a partial copy of.
- **No handle resolution anywhere in HappyView.** The sandbox's atproto API exposes
  `resolve_service_endpoint`, `get_labels`, `sign`, `verify_signature`, spaces
  membership — but NO identity/handle resolver; the profile record carries no handle;
  and HappyView's Postgres schema has NO identities/handle table at all (verified
  against its migrations). Contrail, by contrast, maintains an `identities` table
  (1,280 DID↔handle rows after backfill) — so handle resolution is a built-in part
  of its index that HappyView simply lacks. So `getProfile` returns `{did, uri, cid, rkey, collection, value=<profile
  body>}` with NO `handle`. Consumer impact (verified against contrail.ts): names
  fall back displayName → handle → DID (displayName covers it); `getHostProfile`
  handle is undefined so profile-link hrefs degrade to the DID. Acceptable for the
  spike; a real cutover would need a handle store or an identity-resolver Lua hook.
- **Backfill is single-DID per job** (`POST /admin/backfill {collection, did}`).
  Omitting `did` triggers relay-wide discovery via
  `com.atproto.sync.listReposByCollection` (millions of repos) — not viable for a
  targeted populate. So populating profiles for the feed meant deriving the distinct
  host+attendee DIDs from the discover feed (21 of them) and POSTing 21 jobs. Each
  job resolves the DID's PDS and pulls its repo over the network — external,
  rate-limitable, and O(distinct authors). Registering the collection ALSO turned on
  live jetstream ingest (count climbed past the 21 backfilled to 63), which is the
  steady-state mechanism; backfill is only for history.
- **`profiles=true` plumbing is hand-rolled per script.** Each of the four event/rsvp
  scripts now re-declares `profiles_for(dids)` (a deduped `IN (...)` db.raw over the
  profile collection) plus a did-collection pass over its own envelope shape. That's
  the consumer contract — `getHostProfile(did, profiles)` and
  `buildAttendee(did, status, profiles)` look profiles up by DID — re-implemented
  four times because there are no shared helpers and no declarative "hydrate author
  profiles" relation. Contrail expresses this as config; here it's ~25 lines copied
  into every endpoint that takes `profiles`.
- Avatar fidelity confirmed: profile `value.avatar` comes back as a raw blob object
  (`{$type:'blob', ref:{$link:<cid>}, mimeType, size}`), which is exactly what
  `getProfileBlobUrl(did, blob)` consumes (reads `ref.$link` || `cid`) to build the
  `cdn.bsky.app/.../<did>/<blobCid>@webp` URL. No transformation needed in Lua.

## Latency
HappyView XRPC, local, warm, single-shot (Postgres on `:5433`, 10.5k events /
5.1k rsvps / 63 profiles):

| endpoint (params) | ~latency |
|---|---|
| getProfile | 11–14 ms |
| rsvp.listRecords (attendees, limit 200, profiles) | 19–24 ms |
| getRecord (hydrate 10, profiles) | 50–58 ms |
| event.listRecords (actor, limit 100, hydrate 5, profiles) | 55–72 ms |
| event.listDiscoverable (limit 20, hydrate 5, profiles) | **170–240 ms** |

- `listDiscoverable` is 3–4× the others — and it's the home/discover landing query.
  Its cost is the materialization gap made visible: a `GROUP BY` count-join across
  the ENTIRE rsvp collection + a per-event `db.backlinks` hydrate (N+1, one round
  trip per card) + a profiles `IN (...)` lookup. The batched-count `listRecords` is
  much cheaper because counts are one grouped query over just the page's uris.
- These are local/warm numbers with no network hop; a real deployment adds the
  HappyView HTTP round trip on top of every call (vs in-process Contrail's zero-hop
  D1 access). Not a fair head-to-head here (different datasets/backends), but the
  relative shape — discover-feed hydration is the hot path to optimize — is real.

## Render parity (A/B, real dev server)
Ran atmo's `vite dev` twice against the SAME build: flag ON (`HAPPYVIEW_URL` set →
HappyView/Postgres) and flag OFF (in-process Contrail → local D1). To give the
flag-OFF side real data, `contrail backfill` populated local D1 (~21k records from
1,281 discovered users). NOTE: the two datasets are NOT identical (HappyView = 15.6k
prod-jetstream records + 21 hand-backfilled profiles; Contrail D1 = its own backfill
universe), so this is STRUCTURAL/render parity, not a byte diff.

Harness friction worth recording: `vite dev` would not boot at all until I changed
the D1 binding from `"remote": true` to `false` in `wrangler.jsonc` — the cloudflare
adapter's dev proxy tries to bind the remote D1 against the authenticated CF account
(which lacks that database) and every request hung/500'd. (Temporary, uncommitted
harness edit; reverted after.) The loaders read `platform.env.DB` even on the
flag-ON path, so the binding must resolve regardless of the flag.

Results:
- **/events** — flag ON: 20 event cards rendered from HappyView; flag OFF: 6 cards
  from Contrail. Both 200, no errors. (Card-count differs purely by dataset +
  discover-filter population.)
- **event-detail, SAME event** (`.../e/3mgy7ekssju2y`, "PublicSpaces Conference
  2026") — structurally identical across backends: title rendered ×4, `og:title` ×2,
  iCal links ×17 on BOTH. Only delta: attendee avatars (2 flag-ON vs 8 flag-OFF) =
  dataset/profile-backfill difference, not a render divergence.
- **calendar** (`.../e/calendar`) — flag ON: valid `BEGIN:VCALENDAR` iCal feed (200)
  after the empty-bucket fix; this is the page that exposed the empty-table→`{}` bug.
- **flag OFF baseline** (empty D1, before backfill) — pages rendered 200 with clean
  empty-state, no errors: the fallback path runs unchanged when the flag is unset.

Conclusion: the real atmo SvelteKit loaders + Svelte components consume the
HappyView envelopes and render the public read path with parity to in-process
Contrail. The differences observed are data, not structure.

### Backfill count + schema asymmetry (the two indexes are NOT the same shape)
Post-backfill record counts, measured directly:

| collection | HappyView (Postgres) | Contrail (local D1) |
|---|---|---|
| events | 10,606 | 1,302 |
| rsvps | 5,073 | 1,822 |
| profiles | 3,681 | 604 |
| follows | 0 (not ingested) | 19,874 |
| identities (DID↔handle) | — (none) | 1,280 |

Why so different, and why it matters:
- **Different discovery universes.** HappyView was seeded from a prod **Jetstream
  firehose capture** (a network-wide time window) → 10.6k events. Contrail's
  `backfill` does **per-user repo discovery** (found 1,281 repos) and pulls only
  those repos' records → 1.3k events. So a data-identical A/B was never possible;
  this is exactly why /events rendered 20 cards flag-ON vs 6 flag-OFF. Structural
  parity is the right (and achieved) bar.
- **Contrail has an `identities` table (1,280 DID↔handle rows) — it RESOLVES
  HANDLES.** This is precisely the gap called out for HappyView, whose Lua sandbox
  exposes no handle resolver, so `getProfile` drops `handle`. Concrete config-vs-Lua
  win for Contrail: handle resolution is built into the index; on HappyView it's
  unsolved.
- **Different schemas.** Contrail uses TYPED per-collection tables
  (`records_event` / `records_rsvp` / `records_profile` / `records_follow`), an
  `identities` table, FTS search tables, and a parallel `spaces_records_*` set for
  permissioned spaces. HappyView uses ONE generic `records` table with a JSON
  `record` column. This is the root reason the endpoint-specific Lua is
  Postgres-jsonb-coupled (`record::jsonb->...`) and must compute counts per query
  (no typed indexes), where Contrail's typed tables/relations express them
  declaratively.
- **Live vs snapshot.** HappyView profiles climbed 63 → 3,681 during the spike purely
  from LIVE jetstream ingest (registering the collection opened a continuous stream);
  Contrail's D1 is a static backfill snapshot (604 profiles). Steady-state vs
  one-shot population is another operational difference.

## Overall

### The configuration difference is sharper than "the host changed"
The spike's framing question was "how much friction is hand-maintained lexicons +
Lua vs Contrail's declarative config." Having built the read path both ways, the gap
is structural, not cosmetic:

| | In-process Contrail (flag OFF) | HappyView (flag ON) |
|---|---|---|
| Deployment | embedded in the SvelteKit worker | external HTTP service, selected by `HAPPYVIEW_URL` |
| Storage | D1 (Cloudflare, declarative bindings) | Postgres (separate process, `:5433`) |
| Auth | in-process, none | `X-Client-Key` per XRPC call |
| Schema/logic | declarative Contrail config | runtime-uploaded lexicons + bespoke Lua per endpoint |
| Query portability | abstracted by Contrail | Postgres-specific: `record::jsonb`, `$N` placeholders, `split_part` |
| Response safety | Contrail enforces shape | none — Lua return is emitted verbatim, lexicon output unchecked |

### What endpoint-specific Lua + reused-lexicons actually cost (the friction tally)
- You DON'T hand-write lexicons for endpoints atmo already generates (reuse buys
  param coercion) — but you DO hand-write one for anything atmo doesn't ship
  (`listDiscoverable`, `app.bsky.actor.profile`).
- Every endpoint is bespoke Lua against a fresh sandbox: helpers copy-pasted 5×, no
  shared module, Postgres-specific SQL, manual envelope assembly.
- The lexicon gives you NO response-shape safety (output unvalidated). Three distinct
  shape bugs (flat-vs-grouped rsvps, empty-table→`{}`, empty-profiles→`{}`) all got
  past both the lexicon and parity.sh; two only surfaced by rendering a real page.
- Counts/relations/profile-hydration are re-derived per query in the Lua scripts'
  SQL where Contrail materializes/declares them.

### Go / no-go (read path)
- **Feasible:** all 5 in-scope read endpoints render the real atmo pages
  (discover/events/calendar/event-detail) against HappyView with correct data,
  counts, grouped attendees, and profile avatars. The seam is clean (one env flag,
  reversible by `git revert` + deleting `happyview-spike/`).
- **But the friction is real and front-loaded:** ~8 runtime-model corrections + 3
  silent shape bugs + per-script duplication + Postgres-coupled SQL, for 5 of 22
  endpoints. Extrapolating to the full surface (spaces, invites, feeds, writes) is a
  large, hand-maintained, untyped-at-the-boundary surface.
- **Recommendation: NO-GO on a near-term cutover; the spike's value is the friction
  map, not a migration.** The read path is provably feasible (5/5 endpoints render
  the real pages with structural parity to Contrail), but the cost to get there for
  just the read slice was high and front-loaded, and three of the bugs were silent
  (lexicon doesn't validate output; parity.sh missed two). Extending this to the full
  22-endpoint surface — spaces, invites, feeds, and especially WRITES (out of spike
  scope entirely) — means a large body of endpoint-specific, Postgres-coupled Lua
  with no boundary type-safety, plus a profile/handle ingestion story that isn't
  solved. If HappyView is pursued, prerequisites are: (1) an output-shape
  contract/validation layer so empty-collection and field-name bugs fail loudly,
  (2) shared Lua helpers or codegen to kill the 5× duplication, (3) a handle/identity
  resolution path. Until those exist, Contrail's declarative config is the
  lower-friction option for atmo's read path. The latency shape (discover-feed hydration is the hot path) is the first
  thing to optimize in either world.
