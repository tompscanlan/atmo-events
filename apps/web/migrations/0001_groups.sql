-- Groups, roles, roster and join requests.
--
-- A group is a PDS account, `group_did`, whose writing credential the app holds
-- (see 0002). Its public events live in that account's public repo, where
-- anyone can read them and Contrail indexes them. Its control plane lives in
-- two spaces on the same account: `about_space_uri` (public read) and
-- `members_space_uri` (member-list read). A space is never anonymously
-- readable, even under a public policy, which is why there are two. The rows
-- here are a cache of those records that the app can query.
--
-- The invariants the app depends on are enforced here, not only in TypeScript:
--   * exactly one owner role per group: `groups_seed_owner_role` creates it,
--     `roles_one_owner_per_group` keeps it unique, `roles_owner_undeletable`
--     and `roles_owner_immutable` keep it alive and named.
--   * a membership's role belongs to the same group: the composite foreign key
--     `(role_id, group_id) -> roles (id, group_id)`.
--   * the owner cannot be demoted, removed or leave: the `memberships_owner_*`
--     triggers, plus `groups_identity_immutable` so the rule cannot be sidestepped
--     by rewriting `owner_did`.
--   * a private group requires approval to join: `groups_private_requires_approval_*`.
--   * one pending join request per (group, did): a partial unique index.
--
-- Statements are separated by the `-- @statement` marker, not by `;`. D1 runs one
-- statement per prepare(), and the triggers contain `;` inside BEGIN..END, so the
-- app-side runner ($lib/groups/server/schema.ts) splits on the marker. The marker
-- is a plain comment, so the file also runs as is:
--   wrangler d1 execute atmo-events-v5 --local  --file=migrations/0001_groups.sql
--   wrangler d1 execute atmo-events-v5 --remote --file=migrations/0001_groups.sql
--
-- The composite foreign key needs foreign keys ON. D1 enables them; a local
-- SQLite harness has to set the pragma itself.

CREATE TABLE IF NOT EXISTS groups (
	id TEXT PRIMARY KEY,
	-- The PDS account this group writes as.
	group_did TEXT NOT NULL UNIQUE,
	owner_did TEXT NOT NULL,
	name TEXT NOT NULL,
	-- There is no slug. A group's URL uses its DID, and the name it shows is its
	-- PDS handle, resolved like any other actor's. Registering the handle at
	-- create is what reserves the name.
	description TEXT,
	visibility TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'private')),
	require_approval INTEGER NOT NULL DEFAULT 1 CHECK (require_approval IN (0, 1)),
	-- The avatar as a blob ref in the group's repo: the three fields a
	-- `{$type:'blob'}` needs, so it can be rebuilt without a second fetch.
	image_cid TEXT,
	image_mime TEXT,
	image_size INTEGER,
	location_name TEXT,
	-- at://<group_did>/space/<type>/self for each of the two spaces, NULL until
	-- create provisions them. The space type is fixed per column
	-- (net.openmeet.space.about and .members), so it is not stored.
	about_space_uri TEXT,
	members_space_uri TEXT,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
)
-- @statement
CREATE INDEX IF NOT EXISTS groups_browse ON groups (visibility, created_at DESC)
-- @statement
-- `group_did` is where the group's writes go and `owner_did` anchors every
-- owner-protection trigger below. If either could be rewritten, one UPDATE would
-- undo the owner protection. There is no ownership transfer, so both are fixed.
CREATE TRIGGER IF NOT EXISTS groups_identity_immutable
BEFORE UPDATE ON groups
FOR EACH ROW
WHEN NEW.owner_did <> OLD.owner_did OR NEW.group_did <> OLD.group_did
BEGIN
	SELECT RAISE(ABORT, 'groups.owner_did and groups.group_did are immutable');
END
-- @statement
-- A private group cannot be open-join. Its address is not a secret: the handle
-- of a did:plc is in the PLC directory's public log, so access cannot rest on
-- nobody knowing it. The app refuses too, but the create form, the settings form
-- and the join path are separate code paths, and the schema covers them all.
-- The error text is matched in $lib/groups/server/repo.ts.
CREATE TRIGGER IF NOT EXISTS groups_private_requires_approval_insert
BEFORE INSERT ON groups
FOR EACH ROW
WHEN NEW.visibility = 'private' AND NEW.require_approval = 0
BEGIN
	SELECT RAISE(ABORT, 'a private group must require approval to join');
END
-- @statement
CREATE TRIGGER IF NOT EXISTS groups_private_requires_approval_update
BEFORE UPDATE ON groups
FOR EACH ROW
WHEN NEW.visibility = 'private' AND NEW.require_approval = 0
BEGIN
	SELECT RAISE(ABORT, 'a private group must require approval to join');
END
-- @statement
CREATE TABLE IF NOT EXISTS roles (
	id TEXT PRIMARY KEY,
	group_id TEXT NOT NULL REFERENCES groups (id) ON DELETE CASCADE,
	name TEXT NOT NULL CHECK (name IN ('owner', 'admin', 'member')),
	is_owner INTEGER NOT NULL DEFAULT 0 CHECK (is_owner IN (0, 1)),
	-- `is_owner` is the machine-readable form of `name = 'owner'`. They cannot
	-- disagree, so the partial unique index below pins the owner role.
	CHECK ((is_owner = 1) = (name = 'owner')),
	UNIQUE (group_id, name),
	-- Parent key of the memberships composite foreign key, in this order.
	UNIQUE (id, group_id)
)
-- @statement
CREATE UNIQUE INDEX IF NOT EXISTS roles_one_owner_per_group ON roles (group_id) WHERE is_owner = 1
-- @statement
-- "Exactly one owner role" also needs "at least one", which no CHECK can say. So
-- inserting the group creates its owner role, and no caller can forget it. The
-- seeder inserts only the other roles.
CREATE TRIGGER IF NOT EXISTS groups_seed_owner_role
AFTER INSERT ON groups
FOR EACH ROW
BEGIN
	INSERT INTO roles (id, group_id, name, is_owner)
	VALUES (lower(hex(randomblob(16))), NEW.id, 'owner', 1);
END
-- @statement
-- The COUNT(*) guard lets a whole group be deleted: during ON DELETE CASCADE the
-- parent row is already gone, so the count is 0 and the owner role goes with it.
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
-- Permission names are a fixed vocabulary in code ($lib/groups/permissions.ts).
-- Which role holds which permission is data, seeded per group. There are no deny
-- rows: a member's permissions are the union of their role's rows.
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
	-- pending join_request, not a membership. There is no suspension, so the only
	-- status is `active`; removing someone deletes the row.
	status TEXT NOT NULL DEFAULT 'active' CHECK (status = 'active'),
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	UNIQUE (group_id, did),
	FOREIGN KEY (group_id) REFERENCES groups (id) ON DELETE CASCADE,
	-- "A membership's role belongs to the same group", as a constraint. group_id
	-- appears in both keys on purpose.
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
-- The mirror of the rule above: owner_did may hold only the owner role. Together
-- they make "exactly one owner" true of the roster, not just of the roles.
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
	SELECT RAISE(ABORT, 'the group owner cannot be demoted or reassigned');
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
-- Being removed and leaving are the same DELETE, so this covers both. The
-- COUNT(*) guard again lets the whole group be deleted.
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
-- One pending request per (group, did). Partial, so decided rows stay as a record
-- and a rejected applicant can ask again.
CREATE UNIQUE INDEX IF NOT EXISTS join_requests_one_pending
ON join_requests (group_id, did) WHERE status = 'pending'
-- @statement
CREATE INDEX IF NOT EXISTS join_requests_by_group ON join_requests (group_id, status, created_at)
