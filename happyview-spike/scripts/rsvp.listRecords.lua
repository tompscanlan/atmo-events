-- rsvp.atmo.rsvp.listRecords — list RSVP records. Powers three atmo callers:
--   * getViewerRsvp        (actor + subjectUri, limit 1)         -> records[0].value.status
--   * listEventAttendees   (subjectUri + status, profiles, 200)  -> records[].did (+ profiles)
--   * listAttendingEvents  (actor + hydrateEvent, 100)           -> records[].event, .value.status
-- Per-record envelope: { uri, did, rkey, collection, cid?, value=<rsvp body>,
--   event? } where event (#refEventRecord) is { uri, did, rkey, collection, cid?,
--   record=<event body> } — note the embedded event body is keyed `record`, which
--   flattenEventRecord accepts (it reads value||record).
--
-- db.raw (not db.query) because the `status` filter must be suffix-normalized:
-- callers pass the qualified token ("community.lexicon.calendar.rsvp#going") but the
-- data holds both bare ("going") and qualified forms, so we compare
-- split_part(status,'#',-1) on both sides (see NOTES.md). actor matches the repo
-- `did` column (assumed a DID, consistent with event.listRecords).

local RSVP = "community.lexicon.calendar.rsvp"
local EVENT = "community.lexicon.calendar.event"
local PROFILE = "app.bsky.actor.profile"

local function did_of(uri) return uri:match("^at://([^/]+)") end
local function rkey_of(uri) return uri:match("([^/]+)$") end
local function norm_status(s) return s and (s:match("([^#]+)$") or s) or nil end

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

-- Embed the event an rsvp points at (hydrateEvent). db.get yields body+uri; the
-- envelope keys the body `record` per the lexicon's #refEventRecord.
local function hydrate_event(subject_uri)
  if not subject_uri then return nil end
  local ev = db.get(subject_uri)
  if not ev then return nil end
  return {
    uri = ev.uri,
    did = did_of(ev.uri),
    rkey = rkey_of(ev.uri),
    collection = EVENT,
    record = ev,
  }
end

function handle()
  local limit = tonumber(params.limit) or 50
  if limit > 200 then limit = 200 end
  local offset = tonumber(params.cursor) or 0
  local dir = (params.order == "asc") and "ASC" or "DESC"

  -- Build WHERE dynamically: a Lua array cannot hold nil in a middle slot (it
  -- collapses and misaligns positional binds), so we only append a placeholder +
  -- arg for filters that are actually present, keeping `args` dense.
  local where = { "collection = $1" }
  local args = { RSVP }
  local function add(tpl, val)
    args[#args + 1] = val
    where[#where + 1] = tpl:gsub("%$%?", "$" .. #args)
  end
  if params.actor then add("did = $?", params.actor) end
  if params.subjectUri then add("record::jsonb->'subject'->>'uri' = $?", params.subjectUri) end
  local ns = norm_status(params.status)
  if ns then add("split_part(record::jsonb->>'status', '#', -1) = $?", ns) end
  if params.createdAtMin then add("(record::jsonb->>'createdAt') >= $?", params.createdAtMin) end
  if params.createdAtMax then add("(record::jsonb->>'createdAt') <= $?", params.createdAtMax) end

  local lim_idx = #args + 1
  local off_idx = #args + 2
  args[lim_idx] = limit
  args[off_idx] = offset

  local sql = "SELECT uri, did, cid, record FROM records WHERE "
    .. table.concat(where, " AND ")
    .. " ORDER BY (record::jsonb->>'createdAt') " .. dir .. " NULLS LAST"
    .. " LIMIT $" .. lim_idx .. " OFFSET $" .. off_idx
  local rows = db.raw(sql, args)

  local hydrate = params.hydrateEvent
  local out = {}
  for _, row in ipairs(rows or {}) do
    local body = json.decode(row.record)
    local rec = {
      uri = row.uri,
      did = row.did,
      rkey = rkey_of(row.uri),
      collection = RSVP,
      cid = row.cid,
      value = body,
    }
    if hydrate then
      local subj = body.subject and body.subject.uri
      rec.event = hydrate_event(subj)
    end
    out[#out + 1] = rec
  end

  local cursor = nil
  if #out == limit then cursor = tostring(offset + limit) end

  local result = { records = out, cursor = cursor }
  if params.profiles then
    local dids = {}
    for _, rec in ipairs(out) do dids[#dids + 1] = rec.did end
    local profs = profiles_for(dids)
    if #profs > 0 then result.profiles = profs end -- omit empty: {} would break .find
  end
  return result
end
