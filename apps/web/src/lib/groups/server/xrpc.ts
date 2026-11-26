// What groups add to lib/spaces' XRPC: a blob upload as the group, and telling a refused session
// from an outage. The rest is lib/spaces'.
import { TokenInvalidError, TokenRefreshError, TokenRevokedError } from '@atcute/oauth-node-client';
import { GET_RECORD, isSpaceAccessDenied } from '#lib/spaces/server/space-credential.js';
import { answerError, readXrpc, XrpcError, type XrpcHandle } from '#lib/spaces/server/xrpc.js';

export * from '#lib/spaces/server/xrpc.js';

/** Throws `XrpcError` on any answer but 2xx. */
export async function xrpcBlob(
	handle: XrpcHandle,
	nsid: string,
	blob: Blob
): Promise<Record<string, unknown>> {
	const res = await handle(`/xrpc/${nsid}`, {
		method: 'POST',
		headers: { 'content-type': blob.type },
		body: blob
	});
	const answer = await readXrpc(res);
	if (answer.ok) return answer.data;
	throw answerError(nsid, answer);
}

/** A read with a space credential, not the session, was refused: a 401 that names the credential
 *  (the group host's `CredentialRevoked` once the grant ends or its member reads no more, or
 *  `MissingJwt` and the like), which signing in again would not change. */
function isCredentialRefused(e: unknown): boolean {
	return e instanceof XrpcError && e.status === 401 && e.nsid === GET_RECORD;
}

/** The session was revoked or expired at the PDS, so only signing in again fixes it. */
export function isAuthRefused(e: unknown): boolean {
	return e instanceof XrpcError && e.status === 401 && !isCredentialRefused(e);
}

/** Only linking again fixes these: the PDS refused the session, or it can no longer be refreshed.
 *  An outage at the group's PDS is not one of them. */
export function isLinkBroken(e: unknown): boolean {
	return (
		isAuthRefused(e) ||
		e instanceof TokenRefreshError ||
		e instanceof TokenRevokedError ||
		e instanceof TokenInvalidError
	);
}

// `ScopeMissingError` is the reference PDS's name for a scope the session lacks. A group host
// says `ScopeMissing`, and `NotAuthorized` from its space methods: its own names, not the spec's.
const ROLE_REFUSALS = new Set(['ScopeMissingError', 'ScopeMissing', 'Forbidden', 'NotAuthorized']);

/** The session is sound, but the roles it carries no longer allow the call, or no longer let it
 *  read a space: no credential for it (`SpaceAccessDenied`), or the one it bought refused. */
export function isRoleRefused(e: unknown): boolean {
	if (isSpaceAccessDenied(e) || isCredentialRefused(e)) return true;
	return e instanceof XrpcError && e.status === 403 && ROLE_REFUSALS.has(e.error ?? '');
}
