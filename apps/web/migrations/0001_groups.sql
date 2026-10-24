-- Groups, roles, roster and join requests. The groups, roles and memberships rows cache
-- each group's records on its PDS: where they disagree the record wins, and
-- server/rebuild.ts restores the rows from the records. join_requests is not a cache: the
-- group host keeps each request, and a row is this site's note of one it sent.
-- There is no visibility column. Visibility is the about space's `access` record.
-- The app splits statements on `-- @statement`, not `;`, because D1 runs one statement
-- per prepare() and the trigger contains `;`. Each statement also ends in `;`, so the
-- file runs as is with `wrangler d1 execute --file` or `wrangler d1 migrations apply`.
-- The composite foreign key needs foreign keys ON.

CREATE TABLE IF NOT EXISTS groups (
	id TEXT PRIMARY KEY,
	group_did TEXT NOT NULL UNIQUE,
	owner_did TEXT NOT NULL,
	name TEXT NOT NULL,
	description TEXT,
	require_approval INTEGER NOT NULL DEFAULT 1 CHECK (require_approval IN (0, 1)),
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
-- `owner_did` is who created the group at this site, a record that grants nothing:
-- the creator is an ordinary admin, as at the group host. It is never rewritten.
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
	-- The group host's two roles. The creator is an ordinary admin, as at the host.
	name TEXT NOT NULL CHECK (name IN ('admin', 'member')),
	UNIQUE (group_id, name),
	-- Parent key of the memberships composite foreign key.
	UNIQUE (id, group_id)
);
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
	-- A row is a member. A pending request is a join_request, not a membership, and
	-- there is no suspension, so removing someone deletes the row.
	role_id TEXT NOT NULL,
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
CREATE INDEX IF NOT EXISTS memberships_by_group ON memberships (group_id);
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
