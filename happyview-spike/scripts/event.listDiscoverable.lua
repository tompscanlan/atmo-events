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
local PROFILE = "app.bsky.actor.profile"

local function did_of(uri) return uri:match("^at://([^/]+)") end
local function rkey_of(uri) return uri:match("([^/]+)$") end

-- Resolve indexed profiles for dids (deduped); handle absent (see NOTES.md).
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

local function collect_dids(rec, acc)
  acc[#acc + 1] = rec.did
  if rec.rsvps then
    for _, bucket in pairs(rec.rsvps) do
      for _, r in ipairs(bucket) do acc[#acc + 1] = r.did end
    end
  end
end

local function status_bucket(s)
  local norm = s and (s:match("([^#]+)$") or s)
  if norm == "going" or norm == "interested" or norm == "notgoing" then return norm end
  return "other"
end

-- Grouped by status: atmo's buildEventAttendees reads rsvps.going / .interested.
local function hydrate_rsvps(uri, n)
  -- Lazy, omit-empty buckets: an empty Lua table serializes to JSON `{}` (not
  -- `[]`), which slips past the consumer's `rsvps?.going ?? []` and breaks `.map`.
  local grouped = {}
  local page = db.backlinks({ collection = RSVP, uri = uri, limit = n })
  for _, rec in ipairs(page.records or {}) do
    local b = status_bucket(rec.status)
    local g = grouped[b]
    if not g then g = {}; grouped[b] = g end
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

  local result = { records = out, cursor = cursor }
  if params.profiles then
    local dids = {}
    for _, rec in ipairs(out) do collect_dids(rec, dids) end
    local profs = profiles_for(dids)
    if #profs > 0 then result.profiles = profs end -- omit empty: {} would break .find
  end
  return result
end
