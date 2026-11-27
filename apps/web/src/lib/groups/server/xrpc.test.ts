import { describe, expect, it, vi } from 'vitest';
import { isAuthRefused, isRoleRefused, xrpc, xrpcBlob, type XrpcHandle } from './xrpc';

const answering = (status: number, body: unknown) =>
	vi.fn<XrpcHandle>(async () => new Response(JSON.stringify(body), { status }));

const refusal = (status: number, error: string) =>
	xrpc(answering(status, { error }), 'x.y', { query: {} }).catch((e: unknown) => e);

describe('xrpcBlob', () => {
	it('posts the blob as its own body, with its type', async () => {
		const handle = answering(200, { blob: { ref: { $link: 'bafy' } } });
		const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });
		expect(await xrpcBlob(handle, 'com.atproto.repo.uploadBlob', blob)).toEqual({
			blob: { ref: { $link: 'bafy' } }
		});
		const [path, init] = handle.mock.calls[0];
		expect(path).toBe('/xrpc/com.atproto.repo.uploadBlob');
		expect(init).toMatchObject({ method: 'POST', headers: { 'content-type': 'image/png' } });
		expect(init.body).toBe(blob);
	});
});

describe('telling a refused session from an outage', () => {
	it('reads a missing scope or Forbidden as roles that no longer allow it', async () => {
		expect(isRoleRefused(await refusal(403, 'ScopeMissingError'))).toBe(true);
		expect(isRoleRefused(await refusal(403, 'Forbidden'))).toBe(true);
		expect(isAuthRefused(await refusal(403, 'Forbidden'))).toBe(false);
	});

	it("reads a group host's own names for a missing scope or role the same way", async () => {
		for (const name of ['ScopeMissing', 'NotAuthorized']) {
			expect(isRoleRefused(await refusal(403, name))).toBe(true);
			expect(isAuthRefused(await refusal(403, name))).toBe(false);
		}
	});

	it('reads neither into an outage or another 403', async () => {
		for (const failure of [await refusal(502, 'UpstreamFailure'), await refusal(403, 'Other')]) {
			expect(isAuthRefused(failure)).toBe(false);
			expect(isRoleRefused(failure)).toBe(false);
		}
		expect(isAuthRefused(new Error('network'))).toBe(false);
	});
});
