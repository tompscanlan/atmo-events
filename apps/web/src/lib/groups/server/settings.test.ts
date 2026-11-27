import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeKemHost } from '#lib/spaces/server/__fixtures__/space-mac-host.js';
import type { SpaceHosts } from '#lib/spaces/server/space-credential.js';
import type { XrpcHandle } from './xrpc';

const mocks = vi.hoisted(() => ({
	networkFetch: vi.fn<typeof fetch>(),
	listGroup: vi.fn(),
	unlistGroup: vi.fn(),
	notifyIndex: vi.fn(),
	repoHasDeclaration: vi.fn(),
	storeCachedProfile: vi.fn()
}));
vi.mock('#lib/atproto/network.js', () => ({
	atprotoNetwork: () => ({
		fetch: (input: RequestInfo | URL, init?: RequestInit) => mocks.networkFetch(input, init),
		isolated: false,
		assertUrl: () => {}
	})
}));
vi.mock('./group', () => ({
	listGroup: mocks.listGroup,
	unlistGroup: mocks.unlistGroup,
	notifyIndex: mocks.notifyIndex,
	repoHasDeclaration: mocks.repoHasDeclaration,
	storeCachedProfile: mocks.storeCachedProfile
}));

import {
	makeMetaPublic,
	parseGroupSettings,
	readGroupSettings,
	saveGroupSettings,
	type GroupSettings
} from './settings';

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

const order = () => [
	...mocks.listGroup.mock.invocationCallOrder.map((at) => [at, 'list']),
	...mocks.unlistGroup.mock.invocationCallOrder.map((at) => [at, 'unlist']),
	...mocks.notifyIndex.mock.invocationCallOrder.map((at) => [at, 'notify'])
];

const SETTINGS: GroupSettings = {
	name: 'Night Riders',
	description: 'We ride at night.',
	website: 'https://riders.example/',
	joinPolicy: 'open',
	public: true,
	listed: true
};

beforeEach(() => {
	vi.resetAllMocks();
	mocks.storeCachedProfile.mockResolvedValue(undefined);
});

describe('parseGroupSettings', () => {
	const form = { ...SETTINGS, description: '', website: '' };

	it('reads empty fields as none, and lists only a public group', () => {
		expect(parseGroupSettings(form)).toMatchObject({ description: null, website: null });
		expect(parseGroupSettings({ ...form, public: false })).toMatchObject({ listed: false });
	});

	it('reads an empty join policy as the one the group has, to keep', () => {
		expect(parseGroupSettings({ ...form, joinPolicy: '' })).toMatchObject({ joinPolicy: null });
	});

	it.each([
		['no name', { name: '' }],
		['a website that is not http', { website: 'ftp://riders.example' }],
		['a website that is no URL', { website: 'riders' }],
		['a join policy the spec does not name', { joinPolicy: 'closed' }]
	])('is refused with %s', (_why, change) => {
		expect(parseGroupSettings({ ...form, ...change })).toBeNull();
	});
});

describe('reading the settings', () => {
	it('reads the about record, the config and the policy with a credential, and the listing', async () => {
		const { writer } = group({
			about: { displayName: 'Riders', website: 'https://riders.example/' },
			config: { joinPolicy: 'invite' },
			publicRead: true
		});
		mocks.repoHasDeclaration.mockResolvedValue(true);
		expect(await readGroupSettings(writer, hosts)).toEqual({
			name: 'Riders',
			description: null,
			website: 'https://riders.example/',
			joinPolicy: 'invite',
			public: true,
			listed: true
		});
	});

	it('reads a join policy this site does not know as one to keep, and a private group as unlisted though a declaration is left', async () => {
		const { writer } = group({ about: { displayName: 'Riders' }, config: { joinPolicy: 'x' } });
		mocks.repoHasDeclaration.mockResolvedValue(true);
		expect(await readGroupSettings(writer, hosts)).toMatchObject({
			joinPolicy: null,
			public: false,
			listed: false
		});
	});

	it('reads a group with no join policy as the host does, approval', async () => {
		const { writer } = group({ about: { displayName: 'Riders' }, config: {} });
		mocks.repoHasDeclaration.mockResolvedValue(false);
		expect(await readGroupSettings(writer, hosts)).toMatchObject({ joinPolicy: 'approval' });
	});
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

describe('saving the settings of a group whose join policy this site does not know', () => {
	it('keeps that policy, and writes the rest', async () => {
		const { writer, writes } = group({
			about: { displayName: 'Riders' },
			config: { joinPolicy: 'x', other: 1 },
			publicRead: true
		});
		mocks.repoHasDeclaration.mockResolvedValue(true);
		await saveGroupSettings(
			writer,
			{ did: GROUP, handle: null },
			{ ...SETTINGS, joinPolicy: null },
			true,
			hosts
		);
		expect(writes.map(([, body]) => body.collection)).toEqual(['org.atgrp.about']);
	});

	it('writes another the person picked, keeping the rest of the config', async () => {
		const { writer, writes } = group({
			about: { displayName: 'Riders' },
			config: { joinPolicy: 'x', other: 1 },
			publicRead: true
		});
		mocks.repoHasDeclaration.mockResolvedValue(true);
		await saveGroupSettings(writer, { did: GROUP, handle: null }, SETTINGS, true, hosts);
		expect(writes.find(([, body]) => body.collection === 'org.atgrp.config')?.[1].record).toEqual({
			$type: 'org.atgrp.config',
			joinPolicy: 'open',
			other: 1
		});
	});
});

describe('saving the settings', () => {
	const about = {
		displayName: 'Riders',
		avatar: {
			$type: 'blob',
			ref: { $link: 'bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku' }
		}
	};

	it('makes a group private first: the whole policy, its grants kept, then the config and about', async () => {
		const { writer, writes } = group({
			about,
			config: { joinPolicy: 'approval' },
			publicRead: true
		});
		mocks.repoHasDeclaration.mockResolvedValue(true);
		await saveGroupSettings(
			writer,
			{ did: GROUP, handle: null },
			{ ...SETTINGS, public: false, listed: false },
			true,
			hosts
		);

		expect(writes.map(([nsid]) => nsid)).toEqual([
			'com.atproto.space.updateSpace',
			'com.atproto.space.putRecord',
			'com.atproto.space.putRecord'
		]);
		expect(writes[0][1]).toEqual({
			space: META,
			policy: { $type: 'org.atgrp.policy', grants: GRANTS, publicRead: false }
		});
		// The host took the declaration down; the index is told, and nothing is written for it.
		expect(mocks.unlistGroup).not.toHaveBeenCalled();
		expect(mocks.notifyIndex).toHaveBeenCalledWith(`at://${GROUP}/org.atgrp.declaration/self`);
		expect(writes[1][1]).toEqual({
			repo: GROUP,
			space: META,
			collection: 'org.atgrp.config',
			rkey: 'self',
			record: { $type: 'org.atgrp.config', joinPolicy: 'open' }
		});
		expect(writes[2][1]).toEqual({
			repo: GROUP,
			space: META,
			collection: 'org.atgrp.about',
			rkey: 'self',
			record: {
				$type: 'org.atgrp.about',
				displayName: 'Night Riders',
				description: 'We ride at night.',
				website: 'https://riders.example/',
				avatar: about.avatar
			}
		});
		expect(mocks.storeCachedProfile).toHaveBeenCalledWith(
			{ did: GROUP, handle: null },
			{
				profile: {
					name: 'Night Riders',
					description: 'We ride at night.',
					website: 'https://riders.example/'
				},
				public: false
			}
		);
	});

	it('makes a group public, then takes the declaration the host wrote down when it is not to be listed', async () => {
		const { writer, writes } = group({ about, config: { joinPolicy: 'approval' } });
		mocks.repoHasDeclaration.mockResolvedValue(false);
		await saveGroupSettings(
			writer,
			{ did: GROUP, handle: null },
			{ ...SETTINGS, listed: false },
			false,
			hosts
		);
		expect(writes[0]).toEqual([
			'com.atproto.space.updateSpace',
			{ space: META, policy: { $type: 'org.atgrp.policy', grants: GRANTS, publicRead: true } }
		]);
		expect(mocks.unlistGroup).toHaveBeenCalledWith(writer.handle, GROUP);
		expect(mocks.listGroup).not.toHaveBeenCalled();
	});

	it('lists a public group that was not, without touching its policy', async () => {
		const { writer, writes } = group({ about, publicRead: true });
		mocks.repoHasDeclaration.mockResolvedValue(false);
		await saveGroupSettings(writer, { did: GROUP, handle: null }, SETTINGS, true, hosts);
		expect(writes.map(([nsid]) => nsid)).not.toContain('com.atproto.space.updateSpace');
		expect(mocks.listGroup).toHaveBeenCalledWith(writer.handle, GROUP);
		expect(order().map(([, what]) => what)).toEqual(['list']);
	});

	it('removes a description and a website left empty', async () => {
		const { writer, writes } = group({
			about: { displayName: 'Riders', description: 'old', website: 'https://old.example/' },
			publicRead: true
		});
		mocks.repoHasDeclaration.mockResolvedValue(true);
		await saveGroupSettings(
			writer,
			{ did: GROUP, handle: null },
			{ ...SETTINGS, description: null, website: null },
			true,
			hosts
		);
		expect(writes.at(-1)?.[1].record).toEqual({
			$type: 'org.atgrp.about',
			displayName: 'Night Riders'
		});
		// And from the profile cached for visitors.
		expect(mocks.storeCachedProfile).toHaveBeenCalledWith(
			{ did: GROUP, handle: null },
			{ profile: { name: 'Night Riders', description: null }, public: true }
		);
	});

	it('keeps a visibility someone changed since the form was shown, and its listing', async () => {
		const { writer, writes } = group({ about, publicRead: true });
		mocks.repoHasDeclaration.mockResolvedValue(true);
		// The form showed it private and leaves it so; someone made it public and listed since.
		await saveGroupSettings(
			writer,
			{ did: GROUP, handle: null },
			{ ...SETTINGS, public: false, listed: false },
			false,
			hosts
		);
		expect(writes.map(([nsid]) => nsid)).not.toContain('com.atproto.space.updateSpace');
		expect(mocks.unlistGroup).not.toHaveBeenCalled();
		expect(mocks.storeCachedProfile.mock.calls[0][1]).toMatchObject({ public: true });
	});
});
