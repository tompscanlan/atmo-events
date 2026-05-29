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
- (filled per task)

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
- (Task 6)

## Latency
- (Task 7)

## Overall
- (Task 7)
