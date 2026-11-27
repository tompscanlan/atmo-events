import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeKemHost } from '#lib/spaces/server/__fixtures__/space-mac-host.js';
import type { SpaceHosts } from '#lib/spaces/server/space-credential.js';
import type { XrpcHandle } from './xrpc';

const mocks = vi.hoisted(() => ({
	networkFetch: vi.fn<typeof fetch>(),
	repoHasDeclaration: vi.fn()
}));
vi.mock('#lib/atproto/network.js', () => ({
	atprotoNetwork: () => ({
		fetch: (input: RequestInfo | URL, init?: RequestInit) => mocks.networkFetch(input, init),
		isolated: false,
		assertUrl: () => {}
	})
}));
vi.mock('./group', () => ({ repoHasDeclaration: mocks.repoHasDeclaration }));

import { makeMetaPublic } from './settings';

const GROUP = 'did:plc:group';
const META = `at:space/${GROUP}/org.atgrp.meta/self`;
const kem = await fakeKemHost();
const hosts: SpaceHosts = {
	repoHost: async () => 'https://host.example',
	kemKey: async () => kem.did
};
const GRANTS = [
	{ role: 'member', read: true },
	{ role: 'admin', read: true }
];

/** The group's meta space at its host, read with a credential; and what was written as the group,
 *  in order, as `[nsid, body]`. */
function group(records: { about?: object; config?: object; publicRead?: boolean }) {
	const values: Record<string, unknown> = {
		'org.atgrp.about': records.about,
		'org.atgrp.config': records.config,
		'com.atproto.space.policy': {
			$type: 'com.atproto.space.policy',
			policy: {
				$type: 'org.atgrp.policy',
				grants: GRANTS,
				...(records.publicRead ? { publicRead: true } : {})
			}
		}
	};
	const writes: [string, Record<string, unknown>][] = [];
	const handle = vi.fn<XrpcHandle>(async (pathname, init) => {
		if (pathname.startsWith('/xrpc/com.atproto.space.getDelegationToken')) {
			return Response.json({ token: 'delegation' });
		}
		writes.push([pathname.replace('/xrpc/', ''), JSON.parse(String(init.body))]);
		return Response.json({});
	});
	mocks.networkFetch.mockImplementation(async (input, init) => {
		const url = new URL(String(input));
		if (url.pathname.endsWith('authorizeSpaceSync')) return Response.json({ credential: 'c' });
		const q = url.searchParams;
		const value = values[q.get('collection')!];
		if (!value) return Response.json({ error: 'RecordNotFound' }, { status: 400 });
		const uri = `${q.get('space')}/${q.get('repo')}/${q.get('collection')}/${q.get('rkey')}`;
		const answered = await kem.recordAnswer(new Headers(init?.headers), { uri, cid: 'b', value });
		return Response.json({ uri, cid: answered.cid, value }, { headers: answered.headers });
	});
	return { writer: { did: GROUP, handle }, writes };
}

beforeEach(() => {
	vi.resetAllMocks();
});

describe('making a group made private public', () => {
	it('sets the whole policy public, its grants kept, and nothing else', async () => {
		const { writer, writes } = group({ about: { displayName: 'Riders' } });
		mocks.repoHasDeclaration.mockResolvedValue(false);
		await makeMetaPublic(writer, hosts);
		expect(writes).toEqual([
			[
				'com.atproto.space.updateSpace',
				{ space: META, policy: { $type: 'org.atgrp.policy', grants: GRANTS, publicRead: true } }
			]
		]);
	});

	it('changes nothing for a group public already', async () => {
		const { writer, writes } = group({ about: { displayName: 'Riders' }, publicRead: true });
		mocks.repoHasDeclaration.mockResolvedValue(true);
		await makeMetaPublic(writer, hosts);
		expect(writes).toEqual([]);
	});
});
