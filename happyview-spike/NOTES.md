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
  hand-written-Lua friction Contrail's declarative filter config would not impose.
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

## RSVP counts (the materialization gap)
- (Task 7)

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
- **No handle resolution available to Lua.** The sandbox's atproto API exposes
  `resolve_service_endpoint`, `get_labels`, `sign`, `verify_signature`, spaces
  membership — but NO identity/handle resolver, and the profile record carries no
  handle. So `getProfile` returns `{did, uri, cid, rkey, collection, value=<profile
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
- (Task 7)

## Overall
- (Task 7)
