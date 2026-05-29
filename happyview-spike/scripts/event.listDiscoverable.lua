-- rsvp.atmo.event.listDiscoverable — home discovery feed. Same envelope as
-- listRecords, but: excludes events with preferences.showInDiscovery == false
-- (missing => treated as discoverable), and filters/orders by RSVP counts.
-- That null-or-not-false predicate can't be expressed in db.query's filter API,
-- so this uses one db.raw join (counts subquery LEFT JOINed to events).
--
-- Postgres specifics (see NOTES.md): db.raw runs SQL verbatim (no adapt_sql), so
-- $N placeholders and native jsonb ops; the `record` column is TEXT (migrated
-- off JSONB), so cast `record::jsonb` for path access and decode the selected
-- `record` text with json.decode. status normalized via split_part(...,'#',-1).

local RSVP = "community.lexicon.calendar.rsvp"

local function did_of(uri) return uri:match("^at://([^/]+)") end
local function rkey_of(uri) return uri:match("([^/]+)$") end

local function status_bucket(s)
  local norm = s and (s:match("([^#]+)$") or s)
  if norm == "going" or norm == "interested" or norm == "notgoing" then return norm end
  return "other"
end

-- Grouped by status: atmo's buildEventAttendees reads rsvps.going / .interested.
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
  local limit = tonumber(params.limit) or 20
  if limit > 200 then limit = 200 end
  local minCount = tonumber(params.rsvpsCountMin) or 0
  local minGoing = tonumber(params.rsvpsGoingCountMin) or 0
  local dir = (params.order == "asc") and "ASC" or "DESC"
  local offset = tonumber(params.cursor) or 0

  local sql = [[
    SELECT e.uri AS uri, e.did AS did, e.cid AS cid, e.record AS record,
           COALESCE(c.total,0) AS total, COALESCE(c.going,0) AS going,
           COALESCE(c.interested,0) AS interested, COALESCE(c.notgoing,0) AS notgoing
    FROM records e
    LEFT JOIN (
      SELECT record::jsonb->'subject'->>'uri' AS ev,
             count(*)::int AS total,
             count(*) FILTER (WHERE split_part(record::jsonb->>'status','#',-1)='going')::int AS going,
             count(*) FILTER (WHERE split_part(record::jsonb->>'status','#',-1)='interested')::int AS interested,
             count(*) FILTER (WHERE split_part(record::jsonb->>'status','#',-1)='notgoing')::int AS notgoing
      FROM records WHERE collection = 'community.lexicon.calendar.rsvp'
      GROUP BY 1
    ) c ON c.ev = e.uri
    WHERE e.collection = 'community.lexicon.calendar.event'
      AND (e.record::jsonb->'preferences'->>'showInDiscovery' IS NULL
           OR e.record::jsonb->'preferences'->>'showInDiscovery' <> 'false')
      AND ($1::text IS NULL OR (e.record::jsonb->>'startsAt') >= $1)
      AND COALESCE(c.total,0) >= $2
      AND COALESCE(c.going,0) >= $3
    ORDER BY (e.record::jsonb->>'startsAt') ]] .. dir .. [[ NULLS LAST
    LIMIT $4 OFFSET $5
  ]]
  local rows = db.raw(sql, { params.startsAtMin, minCount, minGoing, limit, offset })

  local hydrate = tonumber(params.hydrateRsvps)
  local out = {}
  for _, row in ipairs(rows or {}) do
    out[#out + 1] = {
      uri = row.uri,
      did = row.did,
      rkey = rkey_of(row.uri),
      cid = row.cid,
      value = json.decode(row.record),
      rsvpsCount = row.total,
      rsvpsGoingCount = row.going,
      rsvpsInterestedCount = row.interested,
      rsvpsNotgoingCount = row.notgoing,
      rsvps = (hydrate and hydrate > 0) and hydrate_rsvps(row.uri, hydrate) or nil,
    }
  end

  local cursor = nil
  if #out == limit then cursor = tostring(offset + limit) end
  return { records = out, cursor = cursor }
end
