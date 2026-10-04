-- This deployment no longer keeps a password for any group account. A group writes
-- only through the OAuth session its owner links, so the app passwords that
-- 0002_group_credentials.sql stored, encrypted under GROUP_CREDENTIAL_KEY, go with
-- their table. Each one also still exists at its PDS until revoked there.
DROP TABLE IF EXISTS group_credentials;
