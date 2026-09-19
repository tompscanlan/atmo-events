-- The stored-state half of the 2026-09-19 paring. om-kp7ss.8 / T013b.
--
-- T013a pares the SEED, which is code. This is the DATA that seed already
-- wrote: create loops GROUP_ROLES and writes five `roles` rows per group with
-- their bundles, and a membership points at one of them. Dropping `moderator`
-- and `guest` from the code leaves orphaned role rows, memberships pointing at
-- roles that no longer exist in the model, and bundles full of names nothing
-- enforces. It MUST land before the first `role`/`permissions` record is
-- written into a members space (T013), or the records and the cache disagree
-- on day one.
--
-- THE MAPPING, lossy on purpose (FR-005c): moderator -> member, because with
-- the ten inert names gone a moderator and a member held the same bundle;
-- guest -> no membership at all, because the pending-approval state guest
-- encoded is already carried by a PENDING join_request (repo.ts pendingRequestId).
--
-- MANAGE_MEMBERS IS EXPANDED, NOT DROPPED. It is the one legacy name whose
-- removal would silently take a capability away: an existing admin holds it
-- and nothing else grants admit/eject/role-assign, so deleting it before
-- writing the three replacements would leave every deployed group unable to
-- manage its roster. Expansion runs first for that reason (FR-005b).
--
-- WHY TRIGGERS RATHER THAN A NEW CHECK on roles.name. The same argument 0003
-- made and for a second reason here: a CHECK cannot be changed without
-- rebuilding the table, `memberships` holds a composite FK into
-- roles (id, group_id), and `ensureGroupsSchema` REPLAYS every statement in
-- this directory on each cold isolate — so a DROP/RENAME rebuild would run
-- again on every boot and take 0001's indexes with it. A BEFORE trigger on
-- each of INSERT and UPDATE is the same invariant with none of that.
--
-- Every statement is idempotent, for that same replay.

-- A target for the remap. Every group the seeder touched already has one; this
-- is for a group whose `member` row was removed by hand, so the UPDATE below
-- can never find NULL.
INSERT INTO roles (id, group_id, name, is_owner)
SELECT lower(hex(randomblob(16))), g.id, 'member', 0
FROM groups g
WHERE NOT EXISTS (SELECT 1 FROM roles r WHERE r.group_id = g.id AND r.name = 'member')
-- @statement
-- Expand MANAGE_MEMBERS into the three grants that replaced it, for whichever
-- roles hold it, BEFORE any name is deleted.
INSERT INTO role_permissions (role_id, permission)
SELECT rp.role_id, j.value
FROM role_permissions rp, json_each('["ADMIT_MEMBERS","EJECT_MEMBERS","ASSIGN_ROLES"]') j
WHERE rp.permission = 'MANAGE_MEMBERS'
ON CONFLICT DO NOTHING
-- @statement
-- moderator -> member. `updated_at` moves because the row's meaning changed.
UPDATE memberships
SET role_id = (
		SELECT target.id FROM roles target
		WHERE target.group_id = memberships.group_id AND target.name = 'member'
	),
	updated_at = unixepoch() * 1000
WHERE role_id IN (SELECT id FROM roles WHERE name = 'moderator')
-- @statement
-- guest -> no membership. A pending applicant is a join request, not a roster
-- row, and `guest` granted nothing v1 acted on even before the paring.
DELETE FROM memberships WHERE role_id IN (SELECT id FROM roles WHERE name = 'guest')
-- @statement
-- The dropped roles themselves. role_permissions cascades on delete (0001:141).
DELETE FROM roles WHERE name IN ('moderator', 'guest')
-- @statement
-- Every stored name outside the pared vocabulary: the ten inert ones, the
-- three SEE_* read gates, and MANAGE_MEMBERS now that it has been expanded.
-- `resolvePermissions` already drops unknown names on read; this stops the
-- members page showing a bundle entry that means nothing.
DELETE FROM role_permissions
WHERE permission NOT IN (
	'MANAGE_GROUP',
	'ADMIT_MEMBERS',
	'EJECT_MEMBERS',
	'ASSIGN_ROLES',
	'MANAGE_EVENTS',
	'CREATE_EVENT'
)
-- @statement
CREATE TRIGGER IF NOT EXISTS roles_three_role_seed_insert
BEFORE INSERT ON roles
FOR EACH ROW
WHEN NEW.name NOT IN ('owner', 'admin', 'member')
BEGIN
	SELECT RAISE(ABORT, 'roles.name must be owner, admin or member');
END
-- @statement
-- The mirror, so the rule cannot be reached by renaming an existing role.
CREATE TRIGGER IF NOT EXISTS roles_three_role_seed_update
BEFORE UPDATE ON roles
FOR EACH ROW
WHEN NEW.name NOT IN ('owner', 'admin', 'member')
BEGIN
	SELECT RAISE(ABORT, 'roles.name must be owner, admin or member');
END
