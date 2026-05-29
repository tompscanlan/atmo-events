-- rsvp.atmo.getProfile — resolve an actor's profile for host/attendee rendering.
-- atmo's getProfileFromContrail reads response.profiles[0]; getHostProfile and
-- buildAttendee read profile.value.displayName + profile.value.avatar (a raw blob,
-- which getProfileBlobUrl turns into a cdn.bsky.app URL) and profile.handle.
--
-- We return the indexed app.bsky.actor.profile record. NOTE (friction, see
-- NOTES.md): the Lua sandbox exposes no identity/handle resolver and the profile
-- record itself carries no handle, so `handle` is omitted — names fall back to
-- displayName (present) and profile links degrade to the DID. Profiles must be
-- separately ingested/backfilled (the event+rsvp ingest does not include them).

local PROFILE = "app.bsky.actor.profile"

local function did_of(uri) return uri:match("^at://([^/]+)") end
local function rkey_of(uri) return uri:match("([^/]+)$") end

function handle()
  local actor = params.actor
  if not actor then return { profiles = {} } end

  -- actor is a DID (atmo passes locals.did / event.did). Profile rkey is "self".
  local rows = db.raw(
    "SELECT uri, did, cid, record FROM records WHERE collection = $1 AND did = $2 LIMIT 1",
    { PROFILE, actor }
  )
  local row = rows and rows[1]
  if not row then return { profiles = {} } end

  return {
    profiles = {
      {
        did = row.did,
        uri = row.uri,
        cid = row.cid,
        rkey = rkey_of(row.uri),
        collection = PROFILE,
        value = json.decode(row.record),
      },
    },
  }
end
