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

local function did_of(uri) return uri:match("^at://([^/]+)") end
local function rkey_of(uri) return uri:match("([^/]+)$") end

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

-- Up to n raw rsvp sub-records for an event (hydrateRsvps).
local function hydrate_rsvps(uri, n)
  local out = {}
  local page = db.backlinks({ collection = RSVP, uri = uri, limit = n })
  for _, rec in ipairs(page.records or {}) do
    out[#out + 1] = { uri = rec.uri, did = did_of(rec.uri), rkey = rkey_of(rec.uri), value = rec }
  end
  return out
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

  return { records = out, cursor = page.cursor }
end
