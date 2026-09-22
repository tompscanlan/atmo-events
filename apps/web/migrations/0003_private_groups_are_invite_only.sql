-- A private group cannot be open-join. TS, 2026-09-17, closing om-5oxc8.
--
-- THE HOLE THIS SHUTS. `visibility` and `require_approval` were independent
-- columns with independent defaults (0001:55-56), and the join path never read
-- `visibility` at all. So `private` + `require_approval = 0` was a reachable
-- configuration in which anyone signed in who knew the group's address was
-- added to the roster outright — `requestJoin` fell straight through to
-- `addMember`.
--
-- WHY THE ADDRESS IS NOT A SECRET, which is what makes that a hole rather than
-- an edge case: a group is addressed by its DID, and its handle is its PDS
-- account handle (`<label>.group.opnmt.net`) — a did:plc's genesis operation,
-- handle included, is published in plc.directory's public audit log. A private
-- group's address is therefore enumerable by design. Access control can never
-- rest on nobody knowing it. (Spec: FR-001a for the handle-as-name rule,
-- FR-016 for invite-only private groups.)
--
-- WHY A TRIGGER RATHER THAN A CHECK. A cross-column CHECK cannot be added to an
-- existing SQLite table without rebuilding it, and a rebuild of `groups` would
-- have to re-create every trigger and index that references it — far more risk
-- than the rule is worth. A BEFORE trigger on each of INSERT and UPDATE is the
-- same invariant with none of that.
--
-- WHY IT IS AN INVARIANT AND NOT AN APP CHECK. The app refuses too
-- (`requestJoin` throws `invite-only`), but that refusal is one code path and
-- the settings form, the create form, a migration, an import and a future
-- invite-accept handler are five more. The schema is the only place the rule
-- cannot be forgotten — which is the same argument the owner-protection
-- triggers in 0001 already won.
--
-- THE BACKFILL RUNS FIRST, and is idempotent because `ensureGroupsSchema`
-- replays every statement on each cold isolate. Any row that already holds the
-- forbidden pair is closed rather than left to fail the next unrelated UPDATE.
UPDATE groups SET require_approval = 1, updated_at = unixepoch() * 1000
WHERE visibility = 'private' AND require_approval = 0
-- @statement
CREATE TRIGGER IF NOT EXISTS groups_private_requires_approval_insert
BEFORE INSERT ON groups
FOR EACH ROW
WHEN NEW.visibility = 'private' AND NEW.require_approval = 0
BEGIN
	SELECT RAISE(ABORT, 'a private group must require approval to join');
END
-- @statement
-- The mirror, so the rule cannot be reached by editing an existing group:
-- settings can turn approval off, or flip visibility to private, and either
-- order has to land on the same refusal.
CREATE TRIGGER IF NOT EXISTS groups_private_requires_approval_update
BEFORE UPDATE ON groups
FOR EACH ROW
WHEN NEW.visibility = 'private' AND NEW.require_approval = 0
BEGIN
	SELECT RAISE(ABORT, 'a private group must require approval to join');
END
