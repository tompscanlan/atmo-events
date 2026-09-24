-- Four location columns go (TS 2026-09-23). Nothing renders them: lat/lng were
-- INSERT-only and never updatable, and address/timezone were settable from the
-- create form but never reached a page. Only `location_name` does, and that one
-- is owned by the profile record (`profile.location.name`). Everything a page
-- shows has to come from a record so the group is portable, so a column no
-- record backs is deleted rather than excused.
--
-- SQLite has no `DROP COLUMN IF EXISTS`, and `ensureGroupsSchema` REPLAYS every
-- statement in this directory on each cold isolate. So a plain drop here would
-- fail on the second boot. The runner skips a drop whose column is already gone
-- (`alreadyApplied` in src/lib/groups/server/schema.ts). `wrangler d1
-- migrations apply` runs each file once and needs no guard. 0001 is left
-- untouched: it still creates these columns, so this drop always has something
-- to remove on a fresh database under either runner.
ALTER TABLE groups DROP COLUMN location_address
-- @statement
ALTER TABLE groups DROP COLUMN location_lat
-- @statement
ALTER TABLE groups DROP COLUMN location_lng
-- @statement
ALTER TABLE groups DROP COLUMN location_timezone
