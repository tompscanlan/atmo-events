-- rsvp.atmo.event.getRecord — single event by AT URI, for the event-detail page.
-- Envelope: { uri, did, rkey, collection, cid?, value=<event body>, rsvpsCount,
--   rsvpsGoingCount, rsvpsInterestedCount, rsvpsNotgoingCount, rsvps? }.
-- atmo's getEventRecordFromContrail returns this verbatim; flattenEventRecord reads
-- value/uri/did/rkey/cid, buildEventAttendees reads rsvps.going / rsvps.interested.
--
-- HappyView does NOT validate the Lua return against the lexicon output schema
-- (execute.rs converts the result straight to JSON), so the schema's required
-- time_us/collection are decorative — we emit only what the consumer reads.
--
-- One db.raw fetches the event body (TEXT `record` -> json.decode), its cid, and
-- all four rsvp counts via correlated subqueries, so there's a single round trip
-- for the scalar fields; hydrateRsvps adds one db.backlinks call when requested.
-- Status is normalized via split_part(...,'#',-1) so bare ("going") and qualified
-- ("...#going") forms both tally (see NOTES.md).

local EVENT = "community.lexicon.calendar.event"
local RSVP = "community.lexicon.calendar.rsvp"

local function did_of(uri) return uri:match("^at://([^/]+)") end
local function rkey_of(uri) return uri:match("([^/]+)$") end

local function status_bucket(s)
  local norm = s and (s:match("([^#]+)$") or s)
  if norm == "going" or norm == "interested" or norm == "notgoing" then return norm end
  return "other"
end

-- Up to n rsvp sub-records for the event, GROUPED by status.
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
  local uri = params.uri
  if not uri then return nil end

  local rows = db.raw([[
    SELECT e.cid AS cid, e.record AS record,
      (SELECT count(*)::int FROM records r
         WHERE r.collection = $2 AND r.record::jsonb->'subject'->>'uri' = $1) AS total,
      (SELECT count(*)::int FROM records r
         WHERE r.collection = $2 AND r.record::jsonb->'subject'->>'uri' = $1
           AND split_part(r.record::jsonb->>'status', '#', -1) = 'going') AS going,
      (SELECT count(*)::int FROM records r
         WHERE r.collection = $2 AND r.record::jsonb->'subject'->>'uri' = $1
           AND split_part(r.record::jsonb->>'status', '#', -1) = 'interested') AS interested,
      (SELECT count(*)::int FROM records r
         WHERE r.collection = $2 AND r.record::jsonb->'subject'->>'uri' = $1
           AND split_part(r.record::jsonb->>'status', '#', -1) = 'notgoing') AS notgoing
    FROM records e
    WHERE e.uri = $1 AND e.collection = $3
  ]], { uri, RSVP, EVENT })

  local row = rows and rows[1]
  if not row then return nil end

  local hydrate = tonumber(params.hydrateRsvps)
  return {
    uri = uri,
    did = did_of(uri),
    rkey = rkey_of(uri),
    collection = EVENT,
    cid = row.cid,
    value = json.decode(row.record),
    rsvpsCount = row.total,
    rsvpsGoingCount = row.going,
    rsvpsInterestedCount = row.interested,
    rsvpsNotgoingCount = row.notgoing,
    rsvps = (hydrate and hydrate > 0) and hydrate_rsvps(uri, hydrate) or nil,
  }
end
