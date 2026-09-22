-- Writing credentials for groups this deployment MINTED — which, since
-- 2026-09-19, is every group. This table is the ONLY source.
--
-- WHY A TABLE AT ALL: group creation is self-service, so the app mints a did:plc
-- during a form POST — and a Worker cannot write its own secret. A secret
-- therefore cannot hold a credential that comes into existence at runtime, and
-- the PDS shows an app password exactly once. (Spec: FR-001, FR-001f.)
--
-- WHAT IS STORED IS NOT THE ACCOUNT PASSWORD. The mint uses a random master
-- password, creates ONE app password with it (com.atproto.server.createAppPassword,
-- which needs ACCESS_FULL and so can only be called with that master session),
-- and then discards the master. An app password can do every write a group needs
-- — space putRecord/applyWrites, simplespace createSpace and repo putRecord all
-- take authVerifier.authorization()'s default scopes = ACCESS_STANDARD, which
-- includes AuthScope.AppPass (atproto-permissioned-data, read 2026-09-17) — but
-- it CANNOT change the account password or delete the account (deleteAccount
-- needs the master plus a token mailed to the account address).
--
-- AND IT IS ENCRYPTED. `secret` holds AES-GCM ciphertext under the
-- GROUP_CREDENTIAL_KEY Worker secret, with its own per-row `iv`. So a D1 read, a
-- backup, or `wrangler d1 execute` yields nothing usable: the bindings that share
-- this database (contrail's ingest, the geocode drip, the search sink) cannot
-- decrypt it either. Decided 2026-09-17 (TS) over three alternatives: plaintext
-- in D1 (a read is write-as-every-group), the master password instead of an app
-- password (a read is account takeover), and HMAC-derived passwords (nothing at
-- rest, but a handle change or key rotation breaks every group).
--
-- NO SECRET OVERRIDE ANY MORE (TS, 2026-09-19, `om-dnwi7`): *"if we don't need
-- that var, drop it. it's confusing."* `resolveGroupCredential` used to read a
-- GROUP_CREDENTIALS Worker secret FIRST and this table second, so an operator
-- could override a stored row. The secret predated the mint, was never set on
-- the deployed worker, and no live group ever read it. Repointing a group at
-- another PDS is now a row write.
--
-- ROTATION COSTS AN ADMIN ACTION, and that is accepted rather than hidden: an
-- app-password session can revoke app passwords but cannot mint a replacement
-- (createAppPassword is ACCESS_FULL), so re-issuing runs through
-- com.atproto.admin.updateAccountPassword. The exit from the whole arrangement is
-- group-host OAuth (om-jc4lh); the owner's portability does NOT depend on any of
-- this, because the owner holds the first PLC rotation key from the genesis
-- operation and can move the DID without us. (Spec: FR-001g.)
--
-- NOT AN AUDIT LOG. One row per group DID, replaced on rotation. The DID is the
-- identity; `identifier` is the handle a session opens with, and a handle is a
-- mutable alias that no column of ours owns (the group row has none — see
-- `0001_groups.sql`).
CREATE TABLE IF NOT EXISTS group_credentials (
	group_did TEXT PRIMARY KEY,
	-- PDS base URL, e.g. https://pds.opnmt.net. Stored per row rather than read
	-- from config so a group minted against one host keeps working after the
	-- deployment's default moves.
	service TEXT NOT NULL,
	-- The handle (or DID) com.atproto.server.createSession is called with.
	identifier TEXT NOT NULL,
	-- AES-GCM ciphertext of the app password, base64. Never logged, never returned
	-- to a page, never in an error message. The only reader is
	-- $lib/groups/server/credentials.ts.
	secret TEXT NOT NULL,
	-- Per-row AES-GCM nonce, base64. Distinct per write; reusing one under the
	-- same key would leak plaintext relationships.
	iv TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
)
