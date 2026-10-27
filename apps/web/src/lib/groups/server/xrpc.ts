// One way to send an XRPC call and read its answer. A PDS's error message is never put
// in the wording, since it can carry what a user typed.

export type XrpcHandle = (pathname: string, init: RequestInit) => Promise<Response>;

export type XrpcAnswer =
	| { ok: true; status: number; data: Record<string, unknown> }
	| { ok: false; status: number; error: string | null; message: string | null };

export type XrpcRequest =
	| { body: Record<string, unknown> }
	| { blob: Blob }
	| { query: Record<string, string> };

/** A body that is not JSON reads as empty. */
export async function readXrpc(res: Response): Promise<XrpcAnswer> {
	const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
	if (res.ok) return { ok: true, status: res.status, data: data ?? {} };
	return {
		ok: false,
		status: res.status,
		error: typeof data?.error === 'string' ? data.error : null,
		message: typeof data?.message === 'string' ? data.message : null
	};
}

export async function xrpc(
	handle: XrpcHandle,
	nsid: string,
	request: XrpcRequest
): Promise<XrpcAnswer> {
	if ('query' in request) {
		const query = new URLSearchParams(request.query);
		return readXrpc(await handle(`/xrpc/${nsid}?${query}`, { method: 'GET' }));
	}
	const sent =
		'blob' in request
			? { headers: { 'content-type': request.blob.type }, body: request.blob }
			: { headers: { 'content-type': 'application/json' }, body: JSON.stringify(request.body) };
	return readXrpc(await handle(`/xrpc/${nsid}`, { method: 'POST', ...sent }));
}

export function describeFailure(answer: { status: number; error: string | null }): string {
	return `${answer.status}${answer.error ? ` ${answer.error}` : ''}`;
}

export function xrpcError(nsid: string, answer: { status: number; error: string | null }): Error {
	return new Error(`${nsid} failed: ${describeFailure(answer)}`);
}

/** The only answer that proves a record absent; a 5xx is not "absent". */
export function isRecordNotFound(answer: XrpcAnswer): boolean {
	return !answer.ok && answer.status === 400 && answer.error === 'RecordNotFound';
}

/** Any answer but the record or `RecordNotFound` throws. */
export async function repoRecordExists(
	handle: XrpcHandle,
	repo: string,
	collection: string,
	rkey: string
): Promise<boolean> {
	const nsid = 'com.atproto.repo.getRecord';
	const answer = await xrpc(handle, nsid, { query: { repo, collection, rkey } });
	if (answer.ok) return true;
	if (isRecordNotFound(answer)) return false;
	throw xrpcError(nsid, answer);
}
