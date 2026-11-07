// What groups add to lib/spaces' XRPC: a blob upload as the group, and telling a refused session
// from an outage. The rest is lib/spaces'.
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

/** The session was revoked or expired at the PDS, so only signing in again fixes it. */
export function isAuthRefused(e: unknown): boolean {
	return e instanceof XrpcError && e.status === 401;
}

/** The session is sound, but the roles it carries no longer allow the call. */
export function isRoleRefused(e: unknown): boolean {
	return (
		e instanceof XrpcError &&
		e.status === 403 &&
		(e.error === 'ScopeMissingError' || e.error === 'Forbidden')
	);
}
