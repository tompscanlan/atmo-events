-- Suspension is removed (TS 2026-09-23). It is in neither the
-- opensocial.community draft — whose actions include `eject`, not suspend, and
-- whose membership record carries no status — nor permissioned data, where a
-- member is added or removed and nothing in between. No requirement ever asked
-- for it; it entered with 0001's `memberships.status` CHECK. A moderator ejects.
--
-- THE COLUMN STAYS, and a trigger pins it to 'active'. Dropping it is a table
-- rebuild, and `ensureGroupsSchema` REPLAYS every statement in this directory
-- on each cold isolate — the same reason 0003 and 0004 give — so the rebuild
-- would run on every boot and take 0001's indexes with it. A BEFORE trigger on
-- each of INSERT and UPDATE is the invariant with none of that.
--
-- Every statement is idempotent, for that same replay.

-- A suspended member is treated as EJECTED. Suspension had already deleted
-- their membership record, so the row was the last thing that listed them.
-- The owner cannot be among them: `memberships_owner_immutable` refused it.
DELETE FROM memberships WHERE status <> 'active'
-- @statement
CREATE TRIGGER IF NOT EXISTS memberships_active_only_insert
BEFORE INSERT ON memberships
FOR EACH ROW
WHEN NEW.status <> 'active'
BEGIN
	SELECT RAISE(ABORT, 'memberships.status must be active: there is no suspension');
END
-- @statement
CREATE TRIGGER IF NOT EXISTS memberships_active_only_update
BEFORE UPDATE OF status ON memberships
FOR EACH ROW
WHEN NEW.status <> 'active'
BEGIN
	SELECT RAISE(ABORT, 'memberships.status must be active: there is no suspension');
END
