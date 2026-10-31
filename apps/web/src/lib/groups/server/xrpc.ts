// One way to send an XRPC call as a group and read its answer. A PDS's error message is
// never kept, since it can carry what a user typed: callers match on the error's name.

export type XrpcHandle = (pathname: string, init: RequestInit) => Promise<Response>;

export type XrpcRequest =
	{ body: Record<string, unknown> } | { blob: Blob } | { query: Record<string, string> };

export class XrpcError extends Error {
	constructor(
		readonly nsid: string,
		readonly status: number,
		/** The protocol's error name, such as `RecordNotFound`; null when the body had none. */
		readonly error: string | null
	) {
		super(`${nsid} failed: ${status}${error ? ` ${error}` : ''}`);
		this.name = 'XrpcError';
	}
}

/** Throws `XrpcError` on any answer but 2xx. A body that is not JSON reads as empty. */
export async function xrpc(
	handle: XrpcHandle,
	nsid: string,
	request: XrpcRequest
): Promise<Record<string, unknown>> {
	let res: Response;
	if ('query' in request) {
		res = await handle(`/xrpc/${nsid}?${new URLSearchParams(request.query)}`, { method: 'GET' });
	} else {
		const sent =
			'blob' in request
				? { headers: { 'content-type': request.blob.type }, body: request.blob }
				: { headers: { 'content-type': 'application/json' }, body: JSON.stringify(request.body) };
		res = await handle(`/xrpc/${nsid}`, { method: 'POST', ...sent });
	}
	const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
	if (res.ok) return data ?? {};
	throw new XrpcError(nsid, res.status, typeof data?.error === 'string' ? data.error : null);
}

/** The only answer that proves a record absent; a 5xx is not "absent". */
export function isRecordNotFound(e: unknown): boolean {
	return e instanceof XrpcError && e.status === 400 && e.error === 'RecordNotFound';
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
