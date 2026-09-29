-- Writing credentials for the groups this deployment created, stored because a Worker
-- cannot write its own secrets and the PDS shows an app password only once. `secret`
-- is an app password, never the account password, AES-GCM encrypted under the
-- GROUP_CREDENTIAL_KEY Worker secret, so a D1 read or backup yields nothing usable.
CREATE TABLE IF NOT EXISTS group_credentials (
	group_did TEXT PRIMARY KEY,
	-- Per row, so a group keeps working after the deployment's default PDS moves.
	service TEXT NOT NULL,
	identifier TEXT NOT NULL,
	secret TEXT NOT NULL,
	iv TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
