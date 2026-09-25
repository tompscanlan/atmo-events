-- Writing credentials for the groups this deployment created.
--
-- WHY A TABLE. Group creation is self-service: the app creates the group's
-- did:plc during a form POST, and a Worker cannot write its own secrets. The PDS
-- also shows an app password only once. So the credential has to be stored when
-- it is created.
--
-- WHAT IS STORED IS AN APP PASSWORD, NOT THE ACCOUNT PASSWORD. Create uses a
-- random account password, creates one app password with it, and then discards
-- the account password. An app password can make every write a group needs
-- (repo putRecord, space putRecord and applyWrites, simplespace createSpace), but
-- it cannot change the account password or delete the account.
--
-- IT IS ENCRYPTED. `secret` is AES-GCM ciphertext under the GROUP_CREDENTIAL_KEY
-- Worker secret, with its own `iv` per row. A D1 read, a backup or
-- `wrangler d1 execute` yields nothing usable, and neither do the other bindings
-- that share this database. The alternatives were worse: plaintext means a read
-- lets anyone write as every group, the account password means a read is an
-- account takeover, and passwords derived from a key break every group on a
-- handle change or a key rotation.
--
-- ROTATION needs an admin action. An app-password session can revoke app
-- passwords but cannot create one, so re-issuing goes through
-- com.atproto.admin.updateAccountPassword. The owner does not depend on any of
-- this to leave: they hold the first PLC rotation key and can move the DID
-- without us.
--
-- One row per group DID, replaced on rotation. The DID is the identity;
-- `identifier` is the handle a session opens with, and a handle can change.
CREATE TABLE IF NOT EXISTS group_credentials (
	group_did TEXT PRIMARY KEY,
	-- PDS base URL, e.g. https://pds.example.com. Stored per row, not read from
	-- config, so a group keeps working after the deployment's default PDS moves.
	service TEXT NOT NULL,
	-- The handle (or DID) com.atproto.server.createSession is called with.
	identifier TEXT NOT NULL,
	-- AES-GCM ciphertext of the app password, base64. Never logged, never sent to
	-- a page, never put in an error message. The only reader is
	-- $lib/groups/server/credentials.ts.
	secret TEXT NOT NULL,
	-- Per-row AES-GCM nonce, base64. A new one on every write: reusing one under
	-- the same key leaks the relationship between plaintexts.
	iv TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
)
