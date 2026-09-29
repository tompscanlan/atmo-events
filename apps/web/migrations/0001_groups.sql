-- Groups, roles, roster and join requests: a cache of each group's records on its PDS.
-- There is no visibility column. Visibility is the about space's read policy at the host.
-- The app splits statements on `-- @statement`, not `;`, because D1 runs one statement
-- per prepare() and the triggers contain `;`. Each statement also ends in `;`, so the
-- file runs as is with `wrangler d1 execute --file` or `wrangler d1 migrations apply`.
-- The composite foreign key needs foreign keys ON.

CREATE TABLE IF NOT EXISTS groups (
	id TEXT PRIMARY KEY,
	group_did TEXT NOT NULL UNIQUE,
	owner_did TEXT NOT NULL,
	name TEXT NOT NULL,
	description TEXT,
	require_approval INTEGER NOT NULL DEFAULT 1 CHECK (require_approval IN (0, 1)),
	-- The avatar's blob ref: the three fields a `{$type:'blob'}` needs.
	image_cid TEXT,
	image_mime TEXT,
	image_size INTEGER,
	location_name TEXT,
	-- at://<group_did>/space/<type>/self, NULL until create provisions the spaces.
	about_space_uri TEXT,
	members_space_uri TEXT,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
-- @statement
CREATE INDEX IF NOT EXISTS groups_browse ON groups (created_at DESC);
-- @statement
-- `owner_did` anchors every owner trigger below, so rewriting it would undo them.
-- There is no ownership transfer.
CREATE TRIGGER IF NOT EXISTS groups_identity_immutable
BEFORE UPDATE ON groups
FOR EACH ROW
WHEN NEW.owner_did <> OLD.owner_did OR NEW.group_did <> OLD.group_did
BEGIN
	SELECT RAISE(ABORT, 'groups.owner_did and groups.group_did are immutable');
END;
-- @statement
CREATE TABLE IF NOT EXISTS roles (
	id TEXT PRIMARY KEY,
	group_id TEXT NOT NULL REFERENCES groups (id) ON DELETE CASCADE,
	name TEXT NOT NULL CHECK (name IN ('owner', 'admin', 'member')),
	is_owner INTEGER NOT NULL DEFAULT 0 CHECK (is_owner IN (0, 1)),
	-- `is_owner` mirrors `name = 'owner'`, for the partial unique index below.
	CHECK ((is_owner = 1) = (name = 'owner')),
	UNIQUE (group_id, name),
	-- Parent key of the memberships composite foreign key.
	UNIQUE (id, group_id)
);
-- @statement
CREATE UNIQUE INDEX IF NOT EXISTS roles_one_owner_per_group ON roles (group_id) WHERE is_owner = 1;
-- @statement
-- No CHECK can say "at least one owner role", so inserting a group creates it.
CREATE TRIGGER IF NOT EXISTS groups_seed_owner_role
AFTER INSERT ON groups
FOR EACH ROW
BEGIN
	INSERT INTO roles (id, group_id, name, is_owner)
	VALUES (lower(hex(randomblob(16))), NEW.id, 'owner', 1);
END;
-- @statement
-- During ON DELETE CASCADE the group row is already gone, so the COUNT(*) guard
-- lets a whole group be deleted.
CREATE TRIGGER IF NOT EXISTS roles_owner_undeletable
BEFORE DELETE ON roles
FOR EACH ROW
WHEN OLD.is_owner = 1
	AND (SELECT COUNT(*) FROM groups g WHERE g.id = OLD.group_id) > 0
BEGIN
	SELECT RAISE(ABORT, 'the owner role cannot be deleted while its group exists');
END;
-- @statement
CREATE TRIGGER IF NOT EXISTS roles_owner_immutable
BEFORE UPDATE ON roles
FOR EACH ROW
WHEN OLD.is_owner = 1
	AND (NEW.is_owner <> 1 OR NEW.name <> 'owner' OR NEW.group_id <> OLD.group_id)
BEGIN
	SELECT RAISE(ABORT, 'the owner role cannot be renamed, demoted or moved');
END;
-- @statement
CREATE TABLE IF NOT EXISTS role_permissions (
	role_id TEXT NOT NULL REFERENCES roles (id) ON DELETE CASCADE,
	permission TEXT NOT NULL,
	PRIMARY KEY (role_id, permission)
);
-- @statement
CREATE TABLE IF NOT EXISTS memberships (
	id TEXT PRIMARY KEY,
	group_id TEXT NOT NULL,
	did TEXT NOT NULL,
	role_id TEXT NOT NULL,
	-- A pending request is a join_request, not a membership. There is no suspension,
	-- so removing someone deletes the row.
	status TEXT NOT NULL DEFAULT 'active' CHECK (status = 'active'),
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	UNIQUE (group_id, did),
	FOREIGN KEY (group_id) REFERENCES groups (id) ON DELETE CASCADE,
	-- A membership's role must belong to the same group.
	FOREIGN KEY (role_id, group_id) REFERENCES roles (id, group_id) ON DELETE CASCADE
);
-- @statement
CREATE INDEX IF NOT EXISTS memberships_by_did ON memberships (did);
-- @statement
CREATE INDEX IF NOT EXISTS memberships_by_group ON memberships (group_id, status);
-- @statement
CREATE TRIGGER IF NOT EXISTS memberships_owner_role_reserved_insert
BEFORE INSERT ON memberships
FOR EACH ROW
WHEN (SELECT r.is_owner FROM roles r WHERE r.id = NEW.role_id) = 1
	AND NEW.did <> (SELECT g.owner_did FROM groups g WHERE g.id = NEW.group_id)
BEGIN
	SELECT RAISE(ABORT, 'the owner role is reserved for the group owner_did');
END;
-- @statement
-- The mirror of the rule above: owner_did may hold only the owner role.
CREATE TRIGGER IF NOT EXISTS memberships_owner_must_be_active_owner_insert
BEFORE INSERT ON memberships
FOR EACH ROW
WHEN NEW.did = (SELECT g.owner_did FROM groups g WHERE g.id = NEW.group_id)
	AND (NEW.status <> 'active' OR (SELECT r.is_owner FROM roles r WHERE r.id = NEW.role_id) <> 1)
BEGIN
	SELECT RAISE(ABORT, 'the group owner must hold an active owner membership');
END;
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
END;
-- @statement
CREATE TRIGGER IF NOT EXISTS memberships_owner_role_reserved_update
BEFORE UPDATE ON memberships
FOR EACH ROW
WHEN (SELECT r.is_owner FROM roles r WHERE r.id = NEW.role_id) = 1
	AND NEW.did <> (SELECT g.owner_did FROM groups g WHERE g.id = NEW.group_id)
BEGIN
	SELECT RAISE(ABORT, 'the owner role is reserved for the group owner_did');
END;
-- @statement
-- Covers both removal and leaving. The COUNT(*) guard again allows deleting the group.
CREATE TRIGGER IF NOT EXISTS memberships_owner_undeletable
BEFORE DELETE ON memberships
FOR EACH ROW
WHEN (SELECT COUNT(*) FROM groups g WHERE g.id = OLD.group_id AND g.owner_did = OLD.did) > 0
BEGIN
	SELECT RAISE(ABORT, 'the group owner cannot be removed and cannot leave');
END;
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
);
-- @statement
-- Partial, so decided rows stay and a rejected applicant can ask again.
CREATE UNIQUE INDEX IF NOT EXISTS join_requests_one_pending
ON join_requests (group_id, did) WHERE status = 'pending';
-- @statement
CREATE INDEX IF NOT EXISTS join_requests_by_group ON join_requests (group_id, status, created_at);
