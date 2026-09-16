-- Groups, roles, roster and join requests for openmeet-atmo.
--
-- A GROUP is a custodial PDS account — `group_did` — whose signing credential
-- the app holds. Roster, roles and permissions are APPLICATION ROWS for now:
-- there is no membership Lexicon here, and inventing one before the standard
-- settles would be a guess we have to live with. The group's PUBLIC event slice
-- lives in the group DID's public repo (anonymously readable, indexable by
-- contrail); its CONTROL PLANE lives in two spaces on the same account —
-- `about_space_uri` (public read) and `members_space_uri` (member-list read) —
-- because a Spaces space is never anonymously readable, not even under a public
-- policy. The records that move into those spaces — profile, rules, roles,
-- membership, access — land in later changes.
--
-- Every invariant the app depends on is enforced HERE, not only in TypeScript:
--   * exactly one owner role per group  — `groups_seed_owner_role` creates it,
--     `roles_one_owner_per_group` keeps it unique, `roles_owner_undeletable` /
--     `roles_owner_immutable` keep it alive and named.
--   * a membership's role belongs to the same group — composite foreign key
--     `(role_id, group_id) -> roles (id, group_id)`. No trigger needed.
--   * the owner cannot be demoted, suspended, removed or leave —
--     `memberships_owner_*` triggers, plus `groups_identity_immutable` so the
--     protection cannot be sidestepped by rewriting `owner_did`.
--   * `require_approval` defaults 1.
--   * one PENDING join request per (group, did) — partial unique index.
--
-- Statement separator: the `-- @statement` marker, not `;`. The app-side runner
-- ($lib/groups/server/schema.ts) feeds D1 one statement per prepare() — D1
-- cannot execute a multi-statement string, and the triggers below contain `;`
-- inside BEGIN..END, so splitting on `;` would corrupt them. The marker is a
-- plain SQL comment, so this file stays runnable verbatim:
--   wrangler d1 execute atmo-events-v5 --local  --file=migrations/0001_groups.sql
--   wrangler d1 execute atmo-events-v5 --remote --file=migrations/0001_groups.sql
-- and `migrations/` is where `wrangler d1 migrations apply` looks by default.
--
-- Foreign keys must be ON for the composite role/group check to bite. D1 runs
-- with foreign keys enabled; a local SQLite harness must set the pragma itself.

CREATE TABLE IF NOT EXISTS groups (
	id TEXT PRIMARY KEY,
	-- The custodial PDS account this group writes as. Bound at creation from an
	-- existing DID; v1 never mints one (see $lib/groups/server/credentials.ts).
	group_did TEXT NOT NULL UNIQUE,
	owner_did TEXT NOT NULL,
	name TEXT NOT NULL,
	slug TEXT NOT NULL UNIQUE,
	description TEXT,
	status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'pending', 'published')),
	visibility TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'unlisted', 'private')),
	require_approval INTEGER NOT NULL DEFAULT 1 CHECK (require_approval IN (0, 1)),
	-- Group avatar as an atproto blob ref in the GROUP's repo: the three fields a
	-- `{$type:'blob'}` needs to be reconstructed without a second fetch.
	image_cid TEXT,
	image_mime TEXT,
	image_size INTEGER,
	location_name TEXT,
	location_address TEXT,
	location_lat REAL,
	location_lng REAL,
	location_timezone TEXT,
	-- at://<group_did>/space/<type>/<slug> for each of the group's two spaces,
	-- NULL until create provisions them. The `/space/` segment is part of the URI
	-- form, not a typo. No `space_type` column: a space URI already carries its
	-- type, and the type is now a constant per space
	-- (net.openmeet.space.about / .members) rather than a per-group value.
	--
	-- Edited in place rather than added as a second migration on purpose: this
	-- file is the single copy of the DDL (server/schema.ts imports it `?raw`),
	-- every statement is IF NOT EXISTS, and no deployment has this table yet.
	about_space_uri TEXT,
	members_space_uri TEXT,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
)
-- @statement
CREATE INDEX IF NOT EXISTS groups_browse ON groups (status, visibility, created_at DESC)
-- @statement
-- `group_did` is the write gate's target and `owner_did` is the anchor of every
-- owner-protection trigger below; letting either be rewritten would turn a
-- demotion-proof owner into a one-UPDATE bypass. Ownership transfer is not a v1
-- feature, so both are simply immutable.
CREATE TRIGGER IF NOT EXISTS groups_identity_immutable
BEFORE UPDATE ON groups
FOR EACH ROW
WHEN NEW.owner_did <> OLD.owner_did OR NEW.group_did <> OLD.group_did
BEGIN
	SELECT RAISE(ABORT, 'groups.owner_did and groups.group_did are immutable');
END
-- @statement
CREATE TABLE IF NOT EXISTS roles (
	id TEXT PRIMARY KEY,
	group_id TEXT NOT NULL REFERENCES groups (id) ON DELETE CASCADE,
	name TEXT NOT NULL CHECK (name IN ('owner', 'admin', 'moderator', 'member', 'guest')),
	is_owner INTEGER NOT NULL DEFAULT 0 CHECK (is_owner IN (0, 1)),
	-- `is_owner` is the machine-readable half of `name = 'owner'`; they can never
	-- disagree, so the partial unique index below really does pin the owner ROLE.
	CHECK ((is_owner = 1) = (name = 'owner')),
	UNIQUE (group_id, name),
	-- Parent of the memberships composite FK: (id, group_id) in this order.
	UNIQUE (id, group_id)
)
-- @statement
CREATE UNIQUE INDEX IF NOT EXISTS roles_one_owner_per_group ON roles (group_id) WHERE is_owner = 1
-- @statement
-- "Exactly one owner role per group" needs an at-LEAST-one half that no CHECK
-- can express, so the owner role is created by the insert of the group itself.
-- It therefore cannot be forgotten by a caller, and the seeder (which inserts
-- the other four roles) uses ON CONFLICT DO NOTHING for this row.
CREATE TRIGGER IF NOT EXISTS groups_seed_owner_role
AFTER INSERT ON groups
FOR EACH ROW
BEGIN
	INSERT INTO roles (id, group_id, name, is_owner)
	VALUES (lower(hex(randomblob(16))), NEW.id, 'owner', 1);
END
-- @statement
-- The COUNT(*) guard is what lets a group be dropped: during an ON DELETE
-- CASCADE the parent `groups` row is already gone, so the count is 0 and the
-- owner role goes with it.
CREATE TRIGGER IF NOT EXISTS roles_owner_undeletable
BEFORE DELETE ON roles
FOR EACH ROW
WHEN OLD.is_owner = 1
	AND (SELECT COUNT(*) FROM groups g WHERE g.id = OLD.group_id) > 0
BEGIN
	SELECT RAISE(ABORT, 'the owner role cannot be deleted while its group exists');
END
-- @statement
CREATE TRIGGER IF NOT EXISTS roles_owner_immutable
BEFORE UPDATE ON roles
FOR EACH ROW
WHEN OLD.is_owner = 1
	AND (NEW.is_owner <> 1 OR NEW.name <> 'owner' OR NEW.group_id <> OLD.group_id)
BEGIN
	SELECT RAISE(ABORT, 'the owner role cannot be renamed, demoted or moved');
END
-- @statement
-- Permission NAMES are vocabulary fixed in code ($lib/groups/permissions.ts);
-- the BUNDLES are data, seeded per group so an operator can retune one group's
-- roles without a deploy. No deny rows: resolution is a union.
CREATE TABLE IF NOT EXISTS role_permissions (
	role_id TEXT NOT NULL REFERENCES roles (id) ON DELETE CASCADE,
	permission TEXT NOT NULL,
	PRIMARY KEY (role_id, permission)
)
-- @statement
CREATE TABLE IF NOT EXISTS memberships (
	id TEXT PRIMARY KEY,
	group_id TEXT NOT NULL,
	did TEXT NOT NULL,
	role_id TEXT NOT NULL,
	-- A membership row means "on the roster". A request awaiting approval is a
	-- PENDING join_request, not a membership, so there is exactly one row per
	-- fact (v1 narrowing of legacy's approval flags).
	status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	UNIQUE (group_id, did),
	FOREIGN KEY (group_id) REFERENCES groups (id) ON DELETE CASCADE,
	-- The invariant "a membership's role must belong to the same group", as a
	-- constraint rather than a trigger. group_id appears in both keys on purpose.
	FOREIGN KEY (role_id, group_id) REFERENCES roles (id, group_id) ON DELETE CASCADE
)
-- @statement
CREATE INDEX IF NOT EXISTS memberships_by_did ON memberships (did)
-- @statement
CREATE INDEX IF NOT EXISTS memberships_by_group ON memberships (group_id, status)
-- @statement
CREATE TRIGGER IF NOT EXISTS memberships_owner_role_reserved_insert
BEFORE INSERT ON memberships
FOR EACH ROW
WHEN (SELECT r.is_owner FROM roles r WHERE r.id = NEW.role_id) = 1
	AND NEW.did <> (SELECT g.owner_did FROM groups g WHERE g.id = NEW.group_id)
BEGIN
	SELECT RAISE(ABORT, 'the owner role is reserved for the group owner_did');
END
-- @statement
-- The mirror of the rule above: owner_did may hold ONLY the owner role, and
-- only actively. Together they make "exactly one owner" true of the roster too,
-- not just of the role table.
CREATE TRIGGER IF NOT EXISTS memberships_owner_must_be_active_owner_insert
BEFORE INSERT ON memberships
FOR EACH ROW
WHEN NEW.did = (SELECT g.owner_did FROM groups g WHERE g.id = NEW.group_id)
	AND (NEW.status <> 'active' OR (SELECT r.is_owner FROM roles r WHERE r.id = NEW.role_id) <> 1)
BEGIN
	SELECT RAISE(ABORT, 'the group owner must hold an active owner membership');
END
-- @statement
CREATE TRIGGER IF NOT EXISTS memberships_owner_immutable
BEFORE UPDATE ON memberships
FOR EACH ROW
WHEN OLD.did = (SELECT g.owner_did FROM groups g WHERE g.id = OLD.group_id)
	AND (
		NEW.role_id <> OLD.role_id
		OR NEW.status <> 'active'
		OR NEW.did <> OLD.did
		OR NEW.group_id <> OLD.group_id
	)
BEGIN
	SELECT RAISE(ABORT, 'the group owner cannot be demoted, suspended or reassigned');
END
-- @statement
CREATE TRIGGER IF NOT EXISTS memberships_owner_role_reserved_update
BEFORE UPDATE ON memberships
FOR EACH ROW
WHEN (SELECT r.is_owner FROM roles r WHERE r.id = NEW.role_id) = 1
	AND NEW.did <> (SELECT g.owner_did FROM groups g WHERE g.id = NEW.group_id)
BEGIN
	SELECT RAISE(ABORT, 'the owner role is reserved for the group owner_did');
END
-- @statement
-- Covers both "removed by an admin" and "left voluntarily" — they are the same
-- DELETE. The COUNT(*) guard again lets the whole group be dropped.
CREATE TRIGGER IF NOT EXISTS memberships_owner_undeletable
BEFORE DELETE ON memberships
FOR EACH ROW
WHEN (SELECT COUNT(*) FROM groups g WHERE g.id = OLD.group_id AND g.owner_did = OLD.did) > 0
BEGIN
	SELECT RAISE(ABORT, 'the group owner cannot be removed and cannot leave');
END
-- @statement
CREATE TABLE IF NOT EXISTS join_requests (
	id TEXT PRIMARY KEY,
	group_id TEXT NOT NULL REFERENCES groups (id) ON DELETE CASCADE,
	did TEXT NOT NULL,
	status TEXT NOT NULL DEFAULT 'pending'
		CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn')),
	message TEXT,
	decided_by_did TEXT,
	decided_at INTEGER,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
)
-- @statement
-- One PENDING request per (group, did) — partial, so the decided rows stay as
-- an audit trail and a rejected applicant may ask again.
CREATE UNIQUE INDEX IF NOT EXISTS join_requests_one_pending
ON join_requests (group_id, did) WHERE status = 'pending'
-- @statement
CREATE INDEX IF NOT EXISTS join_requests_by_group ON join_requests (group_id, status, created_at)
