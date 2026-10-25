-- Groups, their roster and join requests. The groups and memberships rows cache each
-- group's records at its host, and where they disagree the record wins. A join_requests
-- row is this site's note of a request it sent; the host keeps the request itself.
-- The app splits statements on `-- @statement`, since D1 runs one statement per prepare().

CREATE TABLE IF NOT EXISTS groups (
	id TEXT PRIMARY KEY,
	group_did TEXT NOT NULL UNIQUE,
	name TEXT NOT NULL,
	description TEXT,
	-- at://<group_did>/space/<type>/self, NULL until the create finishes.
	about_space_uri TEXT,
	members_space_uri TEXT,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
-- @statement
CREATE INDEX IF NOT EXISTS groups_browse ON groups (created_at DESC);
-- @statement
CREATE TABLE IF NOT EXISTS memberships (
	id TEXT PRIMARY KEY,
	group_id TEXT NOT NULL REFERENCES groups (id) ON DELETE CASCADE,
	did TEXT NOT NULL,
	role TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	UNIQUE (group_id, did)
);
-- @statement
CREATE INDEX IF NOT EXISTS memberships_by_did ON memberships (did);
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
