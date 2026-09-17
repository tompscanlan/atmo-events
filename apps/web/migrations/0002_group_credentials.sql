-- Writing credentials for groups this deployment MINTED, as opposed to groups an
-- operator configured.
--
-- WHY A TABLE AT ALL: FR-001 makes group creation self-service, so the app mints
-- a did:plc during a form POST — and a Worker cannot write its own secret. The
-- GROUP_CREDENTIALS secret therefore cannot hold a credential that comes into
-- existence at runtime, and the PDS shows an app password exactly once.
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
-- rest, but a slug rename or key rotation breaks every group).
--
-- PRECEDENCE, deliberately: the SECRET WINS. `resolveGroupCredential` reads
-- GROUP_CREDENTIALS first and this table only as a fallback, so an operator can
-- always override a stored row — rotate a credential, repoint a group at another
-- PDS — with no migration and no delete.
--
-- ROTATION COSTS AN ADMIN ACTION, and that is accepted rather than hidden: an
-- app-password session can revoke app passwords but cannot mint a replacement
-- (createAppPassword is ACCESS_FULL), so re-issuing runs through
-- com.atproto.admin.updateAccountPassword. The exit from the whole arrangement is
-- group-host OAuth (om-jc4lh); the owner's portability does NOT depend on any of
-- this, because the owner holds rotationKeys[0] from the genesis operation
-- (FR-001g) and can move the DID without us.
--
-- NOT AN AUDIT LOG. One row per group DID, replaced on rotation. The DID is the
-- identity; `identifier` is the handle a session opens with and is a mutable
-- alias, exactly as `groups.slug` is.
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
