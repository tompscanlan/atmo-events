// What groups' reader adds to lib/spaces': the listing, and a get that says its collection. The
// credential, the MAC and the time limits are tested in lib/spaces.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeKemHost } from '#lib/spaces/server/__fixtures__/space-mac-host.js';
import { credentialSpaceReader } from './space-read';
import { isSpaceAccessDenied } from '#lib/spaces/server/space-credential.js';

const GROUP = 'did:plc:jcwgw6fcnb5vyoid7nz7sl26';
const SPACE = `at://${GROUP}/space/group.opensocial.members/self`;
const HOST = 'https://group.pds.test';
const COLLECTION = 'group.opensocial.membership';

const kem = await fakeKemHost();
const hosts = { repoHost: async () => HOST, kemKey: async () => kem.did };
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json', ...headers }
	});

const holder = (answer?: Response) => ({
	handle: vi.fn(async () => answer ?? json(200, { token: 'delegation' }))
});

const pages = vi.fn();
const fetchMock = vi.fn(async (input: URL | string, init?: RequestInit) => {
	const url = new URL(String(input));
	if (url.pathname.endsWith('.getSpaceCredential')) return json(200, { credential: 'a.b.c' });
	if (url.pathname.endsWith('.listRecords')) return pages(url);
	if (url.pathname.endsWith('.getRecord')) {
		const value = { hello: 'world' };
		const uri = `${SPACE}/${GROUP}/${url.searchParams.get('collection')}/${url.searchParams.get('rkey')}`;
		const answered = await kem.recordAnswer(new Headers(init?.headers), {
			uri,
			cid: 'bafytest',
			value
		});
		return json(200, { uri, cid: answered.cid, value }, answered.headers);
	}
	throw new Error(`unexpected ${url.pathname}`);
});

vi.mock('#lib/atproto/network.js', () => ({
	atprotoNetwork: () => ({
		isolated: true,
		assertUrl: () => {},
		fetch: (input: URL | string, init?: RequestInit) => fetchMock(input, init)
	})
}));

beforeEach(() => {
	pages.mockReset();
	fetchMock.mockClear();
});

describe("groups' reader", () => {
	it('lists every page, on one credential, and names each record', async () => {
		pages
			.mockImplementationOnce(() =>
				json(200, {
					records: [{ collection: COLLECTION, rkey: 'one', cid: 'c1', value: { n: 1 } }],
					cursor: 'next'
				})
			)
			.mockImplementationOnce(() =>
				json(200, {
					records: [{ collection: COLLECTION, rkey: 'two', cid: 'c2', value: { n: 2 } }]
				})
			);
		const person = holder();
		const records = await credentialSpaceReader(person, hosts).list({
			space: SPACE,
			repo: GROUP,
			collection: COLLECTION
		});
		expect(records.map((r) => r.rkey)).toEqual(['one', 'two']);
		expect(records[1]).toMatchObject({
			uri: `${SPACE}/${GROUP}/${COLLECTION}/two`,
			cid: 'c2',
			collection: COLLECTION,
			value: { n: 2 }
		});
		expect(person.handle).toHaveBeenCalledTimes(1);
	});

	it('throws on a page that fails, so a partial list never returns', async () => {
		pages
			.mockImplementationOnce(() =>
				json(200, {
					records: [{ collection: COLLECTION, rkey: 'one', cid: 'c1', value: {} }],
					cursor: 'next'
				})
			)
			.mockImplementationOnce(() => json(500, { error: 'Oops' }));
		await expect(
			credentialSpaceReader(holder(), hosts).list({ space: SPACE, repo: GROUP })
		).rejects.toThrow();
	});

	it('throws on a cursor repeated, rather than read for ever', async () => {
		pages.mockImplementation(() =>
			json(200, {
				records: [{ collection: COLLECTION, rkey: 'one', cid: 'c1', value: {} }],
				cursor: 'same'
			})
		);
		await expect(
			credentialSpaceReader(holder(), hosts).list({ space: SPACE, repo: GROUP })
		).rejects.toThrow(/repeated its cursor/);
	});

	it('a get says its collection, shares the credential, and the MAC is checked', async () => {
		const person = holder();
		const reader = credentialSpaceReader(person, hosts);
		const [a, b] = await Promise.all([
			reader.get({ space: SPACE, repo: GROUP, collection: COLLECTION, rkey: 'one' }),
			reader.get({ space: SPACE, repo: GROUP, collection: COLLECTION, rkey: 'two' })
		]);
		expect(a?.collection).toBe(COLLECTION);
		expect(b?.rkey).toBe('two');
		expect(person.handle).toHaveBeenCalledTimes(1);
	});

	it('a refusal at the exchange is a refusal for the listing too', async () => {
		const person = holder(json(400, { error: 'SpaceNotFound' }));
		const thrown = await credentialSpaceReader(person, hosts)
			.list({ space: SPACE, repo: GROUP })
			.catch((e) => e);
		expect(isSpaceAccessDenied(thrown)).toBe(true);
	});

	it('asks again on the next request, so a removed person loses access at once', async () => {
		pages.mockImplementation(() => json(200, { records: [] }));
		const person = holder();
		await credentialSpaceReader(person, hosts).list({ space: SPACE, repo: GROUP });
		await credentialSpaceReader(person, hosts).list({ space: SPACE, repo: GROUP });
		expect(person.handle).toHaveBeenCalledTimes(2);
	});
});
