// A group's picture, read from meta with the viewer's own space credential.
// What matters: the read is the holder's own (signed for the group's repo), a
// blob the space does not hold reads as none, only an image the profile takes
// is ever served, and a spent credential is replaced once, as for every space read.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readGroupAvatar } from './avatar-read';
import { clearSpaceCredentials, type SpaceHolder, type SpaceHosts } from './space-credential';
import { spaceUri } from '../ids';
import { ABOUT_SPACE_TYPE } from '../types';

const GROUP_DID = 'did:plc:jcwgw6fcnb5vyoid7nz7sl26';
const VIEWER = 'did:plc:viewerviewerviewerviewer';
const META = spaceUri(GROUP_DID, ABOUT_SPACE_TYPE, 'self');
const CID = 'bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku';
const GROUP_HOST = 'https://grouphost.stub.test';
const group = { group_did: GROUP_DID, about_space_uri: META };
const hosts: SpaceHosts = {
	repoHost: async () => GROUP_HOST,
	spaceHost: async () => GROUP_HOST,
	// A blob read asks for no MAC, so no key is looked up.
	kemKey: async () => Promise.reject(new Error('a blob read asks for no MAC'))
};
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

function base64url(text: string): string {
	return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const json = (status: number, body: unknown) => Response.json(body, { status });

/** The viewer's PDS and the group host: a delegation token, a credential for
 *  it, and `getBlob` answered by `blob`. */
function network(blob: (credentialCount: number) => Response) {
	let issued = 0;
	const reads: { url: URL; headers: Headers }[] = [];
	const holder: SpaceHolder = {
		did: VIEWER,
		handle: async () => json(200, { token: `delegation-${VIEWER}` })
	};
	vi.stubGlobal('fetch', async (input: URL | string, init?: RequestInit) => {
		const url = new URL(String(input));
		if (url.pathname === '/xrpc/com.atproto.space.getSpaceCredential') {
			issued++;
			const exp = Math.floor(Date.now() / 1000) + 600;
			return json(200, {
				credential: `${base64url('{}')}.${base64url(JSON.stringify({ exp, n: issued }))}.c2ln`
			});
		}
		if (url.pathname === '/xrpc/com.atproto.space.getBlob') {
			reads.push({ url, headers: new Headers(init?.headers) });
			return blob(issued);
		}
		return json(404, { error: 'NotFound' });
	});
	return { holder, reads, issued: () => issued };
}

const image = (type: string, bytes: Uint8Array<ArrayBuffer> = PNG) =>
	new Response(bytes, { headers: { 'content-type': type } });

beforeEach(() => clearSpaceCredentials());
afterEach(() => vi.unstubAllGlobals());

describe('readGroupAvatar', () => {
	it("reads the blob from meta at the group's repo host, with the viewer's credential", async () => {
		const net = network(() => image('image/png'));

		const read = await readGroupAvatar(net.holder, group, CID, hosts);

		expect(read?.type).toBe('image/png');
		expect(new Uint8Array(read!.bytes)).toEqual(PNG);
		const [{ url, headers }] = net.reads;
		expect(url.origin).toBe(GROUP_HOST);
		expect(Object.fromEntries(url.searchParams)).toEqual({
			space: META,
			repo: GROUP_DID,
			cid: CID
		});
		expect(headers.get('authorization')).toMatch(/^Atproto-Space-Credential /);
		expect(headers.get('atproto-space-audience')).toBe(GROUP_DID);
	});

	it('reads a blob the space does not hold as none', async () => {
		const net = network(() => json(400, { error: 'BlobNotFound', message: 'Blob not found' }));

		expect(await readGroupAvatar(net.holder, group, CID, hosts)).toBeNull();
	});

	// The route serves the bytes under the type the host sent, so only the
	// profile's image types pass, whatever another app put in meta.
	it('serves nothing that is not an image the profile takes', async () => {
		for (const type of ['image/svg+xml', 'text/html', '']) {
			const net = network(() => image(type));
			expect(await readGroupAvatar(net.holder, group, CID, hosts), type).toBeNull();
		}
		const net = network(() => image('image/webp', new Uint8Array(2_000_001)));
		expect(await readGroupAvatar(net.holder, group, CID, hosts)).toBeNull();
	});

	it('replaces a spent credential once, then reads', async () => {
		const net = network((n) =>
			n === 1 ? json(400, { error: 'JwtExpired', message: 'expired' }) : image('image/jpeg')
		);

		expect((await readGroupAvatar(net.holder, group, CID, hosts))?.type).toBe('image/jpeg');
		expect(net.issued()).toBe(2);
	});

	it('throws on any other failure, naming the call', async () => {
		const net = network(() => json(500, { error: 'InternalServerError' }));

		await expect(readGroupAvatar(net.holder, group, CID, hosts)).rejects.toThrow(
			'com.atproto.space.getBlob failed: 500 InternalServerError'
		);
	});

	it('reads nothing for a group with no meta space', async () => {
		const net = network(() => image('image/png'));

		expect(
			await readGroupAvatar(net.holder, { ...group, about_space_uri: null }, CID, hosts)
		).toBeNull();
		expect(net.reads).toEqual([]);
	});
});
