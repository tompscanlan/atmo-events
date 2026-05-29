-- rsvp.atmo.event.listRecords — public event feed (home / events / "my events").
-- Envelope per record: { uri, did, rkey, value=<event body>, rsvpsCount,
--   rsvpsGoingCount, rsvpsInterestedCount, rsvpsNotgoingCount, rsvps? }.
-- Helpers are inlined: HappyView runs each script in a fresh sandbox (no shared
-- globals). db.query records are the body with `uri` injected (no did/cid/.record
-- wrapper) so did/rkey are parsed from the uri; cid is omitted (atmo treats it as
-- optional). Counts are computed in ONE batched db.raw GROUP BY over the page's
-- event uris (not per-event), normalizing status via split_part(...,'#',-1) so both
-- bare ("going") and qualified ("...#going") forms are tallied.

local EVENT = "community.lexicon.calendar.event"
local RSVP = "community.lexicon.calendar.rsvp"
local PROFILE = "app.bsky.actor.profile"

local function did_of(uri) return uri:match("^at://([^/]+)") end
local function rkey_of(uri) return uri:match("([^/]+)$") end

-- Resolve indexed app.bsky.actor.profile records for a list of dids (deduped).
-- Profiles are a separately-ingested collection; handle is absent (no resolver in
-- the Lua sandbox), so consumers fall back to displayName/DID. See NOTES.md.
local function profiles_for(dids)
  local seen, list = {}, {}
  for _, d in ipairs(dids) do
    if d and not seen[d] then seen[d] = true; list[#list + 1] = d end
  end
  if #list == 0 then return {} end
  local ph = {}
  for i = 1, #list do ph[i] = "$" .. i end
  local rows = db.raw(
    "SELECT uri, did, cid, record FROM records WHERE collection = '" .. PROFILE ..
    "' AND did IN (" .. table.concat(ph, ",") .. ")", list)
  local out = {}
  for _, row in ipairs(rows or {}) do
    out[#out + 1] = {
      did = row.did, uri = row.uri, cid = row.cid,
      rkey = rkey_of(row.uri), collection = PROFILE, value = json.decode(row.record),
    }
  end
  return out
end

-- Gather every did referenced by an event envelope (host + grouped rsvp authors).
local function collect_dids(rec, acc)
  acc[#acc + 1] = rec.did
  if rec.rsvps then
    for _, bucket in pairs(rec.rsvps) do
      for _, r in ipairs(bucket) do acc[#acc + 1] = r.did end
    end
  end
end

-- One grouped query for all event uris on the page -> map uri -> count table.
local function counts_for(uris)
  local map = {}
  if #uris == 0 then return map end
  local ph = {}
  for i = 1, #uris do ph[i] = "$" .. i end
  local sql = "SELECT record::jsonb->'subject'->>'uri' AS ev, "
    .. "split_part(record::jsonb->>'status', '#', -1) AS s, count(*)::int AS n "
    .. "FROM records WHERE collection = '" .. RSVP .. "' "
    .. "AND record::jsonb->'subject'->>'uri' IN (" .. table.concat(ph, ",") .. ") "
    .. "GROUP BY 1, 2"
  local rows = db.raw(sql, uris)
  for _, row in ipairs(rows or {}) do
    local m = map[row.ev]
    if not m then m = { total = 0, going = 0, interested = 0, notgoing = 0 }; map[row.ev] = m end
    m.total = m.total + row.n
    if row.s == "going" then m.going = m.going + row.n
    elseif row.s == "interested" then m.interested = m.interested + row.n
    elseif row.s == "notgoing" then m.notgoing = m.notgoing + row.n end
  end
  return map
end

-- normalize status (bare "going" or qualified "...#going") to a bucket name.
local function status_bucket(s)
  local norm = s and (s:match("([^#]+)$") or s)
  if norm == "going" or norm == "interested" or norm == "notgoing" then return norm end
  return "other"
end

-- Up to n raw rsvp sub-records for an event, GROUPED by status. atmo's
-- buildEventAttendees reads rsvps.going / rsvps.interested, so the envelope must
-- be {going=[], interested=[], notgoing=[], other=[]} (NOT a flat array).
local function hydrate_rsvps(uri, n)
  local grouped = { going = {}, interested = {}, notgoing = {}, other = {} }
  local page = db.backlinks({ collection = RSVP, uri = uri, limit = n })
  for _, rec in ipairs(page.records or {}) do
    local g = grouped[status_bucket(rec.status)]
    g[#g + 1] = { uri = rec.uri, did = did_of(rec.uri), rkey = rkey_of(rec.uri), record = rec }
  end
  return grouped
end

function handle()
  local limit = tonumber(params.limit) or 50
  if limit > 200 then limit = 200 end

  local conds = {}
  if params.startsAtMin then conds[#conds + 1] = { field = "startsAt", op = ">=", value = params.startsAtMin } end
  if params.startsAtMax then conds[#conds + 1] = { field = "startsAt", op = "<=", value = params.startsAtMax } end
  if params.endsAtMin then conds[#conds + 1] = { field = "endsAt", op = ">=", value = params.endsAtMin } end
  if params.endsAtMax then conds[#conds + 1] = { field = "endsAt", op = "<=", value = params.endsAtMax } end

  local q = {
    collection = EVENT,
    sort = params.sort or "startsAt",
    sortDirection = (params.order == "asc") and "asc" or "desc",
    limit = limit,
  }
  if #conds > 0 then
    local filter = { combine = "and" }
    for i, c in ipairs(conds) do filter[i] = c end
    q.filter = filter
  end
  if params.cursor then q.cursor = params.cursor end
  -- actor filters by the repo did column (not a record-body field)
  if params.actor then q.did = params.actor end

  local page = db.query(q)
  local recs = page.records or {}

  local uris = {}
  for i, r in ipairs(recs) do uris[i] = r.uri end
  local counts = counts_for(uris)

  local hydrate = tonumber(params.hydrateRsvps)
  local out = {}
  for _, r in ipairs(recs) do
    local c = counts[r.uri] or { total = 0, going = 0, interested = 0, notgoing = 0 }
    out[#out + 1] = {
      uri = r.uri,
      did = did_of(r.uri),
      rkey = rkey_of(r.uri),
      value = r,
      rsvpsCount = c.total,
      rsvpsGoingCount = c.going,
      rsvpsInterestedCount = c.interested,
      rsvpsNotgoingCount = c.notgoing,
      rsvps = (hydrate and hydrate > 0) and hydrate_rsvps(r.uri, hydrate) or nil,
    }
  end

  local result = { records = out, cursor = page.cursor }
  if params.profiles then
    local dids = {}
    for _, rec in ipairs(out) do collect_dids(rec, dids) end
    result.profiles = profiles_for(dids)
  end
  return result
end
