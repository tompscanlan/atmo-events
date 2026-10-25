import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sqliteD1, type SqliteD1 } from './server/__fixtures__/d1-sqlite';
import { fakeGroupHost, type FakeGroupHostOptions } from './server/__fixtures__/group-host';
import { stubSession } from './server/__fixtures__/linked-oauth-stub';

vi.mock('./server/handles', () => ({ refreshGroupHandle: vi.fn(async () => null) }));
vi.mock('./server/host', async (importOriginal) => ({
	...(await importOriginal<typeof import('./server/host')>()),
	isHostGroup: vi.fn(async () => true)
}));

import {
	finishCreateAtHost,
	hostCreation,
	setUpHostGroup,
	startCreateAtHost,
	type HostCreateFields,
	type HostCreateState
} from './create-at-host';
import { isHostGroup } from './server/host';
import { getGroupByDid } from './server/db/groups';
import { listMembers } from './server/db/roster';
import { groupSessionScope, type LinkedGroupCredential } from './server/session';
import { groupSpaceUris } from './ids';

const CREATOR = 'did:plc:creatoraaaaaaaaaaaaaaaaa';
const GROUP = 'did:plc:hostgroupaaaaaaaaaaaaaaa';
const HOST = 'https://grouphost.stub.test';
const { aboutSpaceUri: META, membersSpaceUri: MEMBERS } = groupSpaceUris(GROUP);
const ENV = { GROUP_HOST_URL: HOST, OAUTH_PUBLIC_URL: 'https://atmo.stub.test' };

let harness: SqliteD1;

beforeEach(() => {
	harness = sqliteD1();
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.mocked(isHostGroup).mockReset().mockResolvedValue(true);
	harness.close();
});

function fields(overrides: Partial<HostCreateFields> = {}): HostCreateFields {
	return {
		name: 'Kona Trail Runners',
		description: 'Dawn runs',
		visibility: 'public',
		joinPolicy: 'approval',
		listed: true,
		rules: 'Be kind\nLeave no trace',
		...overrides
	};
}

const groupDids = async () =>
	((await harness.db.prepare(`SELECT group_did FROM groups`).all()).results ?? []).map(
		(row) => (row as { group_did: string }).group_did
	);

/** The host's meta `access` record as it writes it at create. */
const HOST_META_GRANTS = [
	{ role: 'admin', scopes: ['space:group.opensocial.meta?collection=*'] },
	{ role: 'member', scopes: ['space:group.opensocial.meta?action=read'] }
];

/** The fake host holding the group it made, with its meta `access` record. */
async function hostWithGroup(fail?: FakeGroupHostOptions['fail']) {
	const host = fakeGroupHost({ did: GROUP, fail });
	await fetch(`${HOST}/xrpc/com.atproto.space.putRecord`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			space: META,
			repo: GROUP,
			collection: 'group.opensocial.access',
			rkey: 'self',
			record: { $type: 'group.opensocial.access', public: false, grants: HOST_META_GRANTS }
		})
	});
	host.clearLog();
	return host;
}

const credential = (): LinkedGroupCredential => ({
	kind: 'linked',
	person: CREATOR,
	session: stubSession(GROUP, HOST, CREATOR)
});

const setUp = (overrides: Partial<HostCreateFields> = {}) =>
	setUpHostGroup({ DB: harness.db, ...ENV }, CREATOR, fields(overrides), credential(), HOST);

describe('hostCreation', () => {
	it('is the host origin only when the deployment can also link what the host makes', () => {
		const linked = {
			OAUTH_PUBLIC_URL: 'https://atmo.stub.test',
			OAUTH_SESSIONS: {} as KVNamespace
		};
		expect(hostCreation({ ...linked, GROUP_HOST_URL: `${HOST}/` })).toBe(HOST);
		expect(hostCreation({ GROUP_HOST_URL: HOST })).toBeNull();
		expect(hostCreation(linked)).toBeNull();
	});
});

describe('startCreateAtHost', () => {
	it("sends the creator to the host's sign-up with the form in the state, and makes nothing here", async () => {
		const name = 'Hilo & Kona #1 = "best" <runners>?';
		const authorize = vi.fn(async () => ({
			url: new URL(`${HOST}/oauth/authorize?request_uri=x`)
		}));

		const answer = await startCreateAtHost({
			client: { authorize } as never,
			hostUrl: HOST,
			callerDid: CREATOR,
			fields: fields({ name }),
			redirectUri: 'https://atmo.stub.test/oauth/group-create/callback'
		});

		expect(answer.ok).toBe(true);
		const signUp = new URL(answer.ok ? answer.signUpUrl : '');
		expect(Object.fromEntries(signUp.searchParams)).toEqual({
			request_uri: 'x',
			gh_name: name,
			gh_person: CREATOR
		});
		const [options] = authorize.mock.calls[0] as unknown as [Record<string, unknown>];
		expect(options).toMatchObject({
			target: { type: 'pds', serviceUrl: HOST },
			prompt: 'create',
			scope: groupSessionScope()
		});
		expect(options.state).toEqual({
			by: CREATOR,
			create: fields({ name })
		} satisfies HostCreateState);
		expect(JSON.stringify(options)).not.toContain('gh_');
		expect(await groupDids()).toEqual([]);
	});
});

describe('setUpHostGroup', () => {
	it("writes only this app's records, on the creator's session, and records the spaces last", async () => {
		const host = await hostWithGroup();

		expect(await setUp()).toEqual({ ok: true, groupDid: GROUP });

		expect(new Set(host.requests.map((r) => r.person))).toEqual(new Set([CREATOR]));
		expect(host.spaceWrites.map((w) => w.collection)).toEqual([
			'group.opensocial.profile',
			'group.opensocial.rule',
			'group.opensocial.rule',
			'group.opensocial.access'
		]);
		expect(host.record(META, 'group.opensocial.profile', 'self')).toMatchObject({
			displayName: 'Kona Trail Runners',
			description: 'Dawn runs',
			joinPolicy: 'approval'
		});
		expect(host.record(META, 'group.opensocial.access', 'self')).toEqual({
			$type: 'group.opensocial.access',
			public: true,
			grants: HOST_META_GRANTS
		});
		expect(host.repoWrites.map((w) => w.collection)).toEqual(['group.opensocial.declaration']);
		const row = await getGroupByDid(harness.db, GROUP);
		expect(row).toMatchObject({ about_space_uri: META, members_space_uri: MEMBERS });
		expect(await listMembers(harness.db, row!.id)).toEqual([
			expect.objectContaining({ did: CREATOR, role: 'admin' })
		]);
	});

	it.each([
		['a private group', { visibility: 'private' as const }, false],
		['an unlisted public group', { listed: false }, true]
	])('does not declare %s', async (_, overrides, isPublic) => {
		const host = await hostWithGroup();

		expect((await setUp(overrides)).ok).toBe(true);
		expect(host.record(META, 'group.opensocial.access', 'self')).toMatchObject({
			public: isPublic
		});
		expect(host.repoWrites).toEqual([]);
	});

	it('names the group the host made when a later step fails, and records no spaces', async () => {
		await hostWithGroup((nsid) =>
			nsid === 'com.atproto.space.putRecord'
				? Response.json({ error: 'InternalServerError' }, { status: 500 })
				: undefined
		);

		const result = await setUp();

		expect(result.ok).toBe(false);
		expect(!result.ok && result.error).toContain(GROUP);
		expect((await getGroupByDid(harness.db, GROUP))?.members_space_uri).toBeNull();
	});
});

describe('finishCreateAtHost', () => {
	const STATE_ID = 'state-1';
	const started: HostCreateState = { by: CREATOR, create: fields() };

	function finish(
		options: {
			signedInDid?: string | null;
			stored?: unknown;
			callback?: () => Promise<{ session: LinkedGroupCredential['session'] }>;
		} = {}
	) {
		const states = {
			get: vi.fn(async () =>
				'stored' in options ? (options.stored as never) : ({ userState: started } as never)
			),
			delete: vi.fn(async () => undefined)
		};
		const client = {
			callback: vi.fn(
				options.callback ?? (async () => ({ session: stubSession(GROUP, HOST, CREATOR) }))
			),
			revoke: vi.fn(async () => undefined)
		};
		const clientFor = vi.fn(() => client as never);
		return {
			states,
			client,
			clientFor,
			result: finishCreateAtHost({
				env: { DB: harness.db, ...ENV, OAUTH_SESSIONS: {} as KVNamespace },
				clientFor,
				states,
				params: new URLSearchParams({ state: STATE_ID, code: 'c', iss: HOST }),
				signedInDid: 'signedInDid' in options ? (options.signedInDid ?? null) : CREATOR
			})
		};
	}

	it('sets up the group the host made, on the client of the person who started it', async () => {
		await hostWithGroup();
		const { clientFor, client, result } = finish();

		expect(await result).toEqual({ ok: true, groupDid: GROUP });
		expect(clientFor).toHaveBeenCalledWith(CREATOR);
		expect(client.revoke).not.toHaveBeenCalled();
		expect(await groupDids()).toEqual([GROUP]);
	});

	it('finishes a create that stopped partway, writing its rules once', async () => {
		const down = { declaration: true };
		const host = await hostWithGroup((nsid) =>
			down.declaration && nsid === 'com.atproto.repo.putRecord'
				? Response.json({ error: 'InternalServerError' }, { status: 500 })
				: undefined
		);
		expect((await finish().result).ok).toBe(false);

		down.declaration = false;
		expect(await finish().result).toEqual({ ok: true, groupDid: GROUP });
		expect(host.records(META, 'group.opensocial.rule')).toHaveLength(2);
		expect(host.repoWrites.map((w) => w.collection)).toEqual(['group.opensocial.declaration']);
		expect((await getGroupByDid(harness.db, GROUP))?.members_space_uri).toBe(MEMBERS);
	});

	it('sets up nothing for a group this site already has', async () => {
		const host = await hostWithGroup();
		await finish().result;
		host.clearLog();

		expect(await finish().result).toMatchObject({ ok: false, groupDid: GROUP });
		expect(host.writes()).toEqual([]);
	});

	it('refuses a browser signed in as someone else before the code is exchanged', async () => {
		const { states, client, result } = finish({ signedInDid: 'did:plc:someoneelseaaaaaaaaaaaa' });

		expect((await result).ok).toBe(false);
		expect(states.delete).toHaveBeenCalledWith(STATE_ID);
		expect(client.callback).not.toHaveBeenCalled();
	});

	it('refuses a state that is not a create', async () => {
		const { client, result } = finish({ stored: { userState: { groupDid: GROUP, by: CREATOR } } });

		expect(await result).toMatchObject({ ok: false, groupDid: null });
		expect(client.callback).not.toHaveBeenCalled();
	});

	it('revokes and sets up nothing when the account is not at the group host', async () => {
		vi.mocked(isHostGroup).mockResolvedValue(false);
		const { client, result } = finish();

		expect(await result).toMatchObject({ ok: false, groupDid: null });
		expect(client.revoke).toHaveBeenCalledWith(GROUP);
		expect(await groupDids()).toEqual([]);
	});

	it('sets up nothing when the host did not finish the sign-up', async () => {
		const { result } = finish({
			callback: async () => {
				throw new Error('access_denied');
			}
		});

		expect(await result).toMatchObject({ ok: false, groupDid: null });
		expect(await groupDids()).toEqual([]);
	});
});
