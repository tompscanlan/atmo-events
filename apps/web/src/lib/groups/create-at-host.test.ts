// A create at a group host, against a stub host and the real schema. The host
// makes the group's account and its meta and members records at sign-up; these
// cases cover what this app does around that: the refusals before anything
// exists at the host, the checks at the callback, and what it writes on the
// creator's new session afterwards, and above all what it leaves to the host.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sqliteD1, type SqliteD1 } from './server/__fixtures__/d1-sqlite';
import { stubPds } from './server/__fixtures__/stub-pds';
import { stubSession } from './server/__fixtures__/linked-oauth-stub';

vi.mock('./server/handles', () => ({ refreshGroupHandle: vi.fn(async () => null) }));
vi.mock('./server/host-kind', async (importOriginal) => ({
	...(await importOriginal<typeof import('./server/host-kind')>()),
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
import { isHostGroup } from './server/host-kind';
import { getGroupByDid } from './server/db/groups';
import { groupSessionScope, type LinkedGroupCredential } from './server/session';
import { groupSpaceUris } from './ids';
import { CALENDAR_SPACE_TYPE } from './types';

const CREATOR = 'did:plc:creatoraaaaaaaaaaaaaaaaa';
const GROUP = 'did:plc:hostgroupaaaaaaaaaaaaaaa';
const HOST = 'https://grouphost.stub.test';
const {
	aboutSpaceUri: META,
	membersSpaceUri: MEMBERS,
	calendarSpaceUri: CALENDAR
} = groupSpaceUris(GROUP);

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
		requireApproval: true,
		rules: 'Be kind\nLeave no trace',
		...overrides
	};
}

const groupRows = async () =>
	(await harness.db.prepare(`SELECT group_did, owner_did FROM groups`).all()).results ?? [];

/** The host's meta `access` record as it writes it at create. */
const HOST_META_GRANTS = [
	{ role: 'admin', scopes: ['space:group.opensocial.meta?collection=*'] },
	{ role: 'member', scopes: ['space:group.opensocial.meta?action=read'] }
];

/** The stub host with the group the host made: its meta `access` record, and
 *  the host's own `createSpace`, which the stub does not serve. */
async function hostWithGroup(fail?: (nsid: string) => Response | undefined) {
	const host = stubPds({
		did: GROUP,
		handle: 'kona.grouphost.stub.test',
		fail: (nsid) =>
			fail?.(nsid) ??
			(nsid === 'group.opensocial.createSpace'
				? Response.json({
						space: CALENDAR,
						access: { uri: `${CALENDAR}/access`, cid: 'bafyaccess' }
					})
				: undefined)
	});
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

/** A PNG's first bytes: enough for a stub host that keeps what it was sent. */
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const picture = (type = 'image/png') => new Blob([PNG], { type });

/** The stash, in memory, taking each image once as the KV one does. */
function memoryStash() {
	const kept = new Map<string, Blob>();
	return {
		kept,
		put: vi.fn(async (image: Blob) => {
			const key = `picture-${kept.size + 1}`;
			kept.set(key, image);
			return key;
		}),
		take: vi.fn(async (key: string) => {
			const image = kept.get(key) ?? null;
			kept.delete(key);
			return image;
		})
	};
}

const credential = (): LinkedGroupCredential => ({
	kind: 'linked',
	person: CREATOR,
	session: stubSession(GROUP, HOST, CREATOR)
});

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
	const start = (overrides: Partial<HostCreateFields> = {}, image?: Blob) => {
		const authorize = vi.fn(async () => ({
			url: new URL(`${HOST}/oauth/authorize?request_uri=x`)
		}));
		const stash = memoryStash();
		return {
			authorize,
			stash,
			result: startCreateAtHost({
				db: harness.db,
				client: { authorize } as never,
				hostUrl: HOST,
				callerDid: CREATOR,
				fields: fields(overrides),
				redirectUri: 'https://atmo.stub.test/oauth/group-create/callback',
				...(image ? { avatar: { image, stash } } : {})
			})
		};
	};

	// The state goes to the host and back, so it carries the key, never the image.
	it('keeps the picture here and sends the host only its key', async () => {
		const image = picture();
		const { authorize, stash, result } = start({}, image);

		expect((await result).ok).toBe(true);
		expect([...stash.kept.values()]).toEqual([image]);
		const [options] = authorize.mock.calls[0] as unknown as [{ state: HostCreateState }];
		expect(options.state.avatar).toBe('picture-1');
		expect(JSON.stringify(options.state)).not.toContain('image/png');
	});

	it('refuses a picture the profile cannot take before anything is kept or asked', async () => {
		const { authorize, stash, result } = start({}, picture('image/gif'));

		expect(await result).toEqual({
			ok: false,
			error: 'The group picture must be a PNG, JPEG or WebP image.'
		});
		expect(stash.put).not.toHaveBeenCalled();
		expect(authorize).not.toHaveBeenCalled();
	});

	it("sends the creator to the host's sign-up with the link scope, and makes nothing here", async () => {
		const { authorize, result } = start({ locationName: 'Kailua-Kona' });

		const answer = await result;
		expect(answer.ok).toBe(true);
		const signUp = new URL(answer.ok ? answer.signUpUrl : '');
		expect(signUp.origin + signUp.pathname).toBe(`${HOST}/oauth/authorize`);
		expect(signUp.searchParams.get('request_uri')).toBe('x');
		expect(authorize).toHaveBeenCalledOnce();
		const [options] = authorize.mock.calls[0] as unknown as [Record<string, unknown>];
		expect(options.target).toEqual({ type: 'pds', serviceUrl: HOST });
		expect(options.prompt).toBe('create');
		expect(options.scope).toBe(groupSessionScope(false));
		// The calendar space does not exist yet, and its items are asked for anyway:
		// the host's admin grant covers every space, ones made later included.
		expect(options.scope).toContain(`space:${CALENDAR_SPACE_TYPE}?`);
		expect(options.state).toEqual({
			by: CREATOR,
			create: {
				name: 'Kona Trail Runners',
				description: 'Dawn runs',
				visibility: 'public',
				requireApproval: true,
				locationName: 'Kailua-Kona',
				rules: 'Be kind\nLeave no trace'
			}
		} satisfies HostCreateState);
		expect(await groupRows()).toEqual([]);
	});

	// The host's sign-up page asks for the group's address and the creator's own
	// handle, and reads these hints off the link to fill both in. They ride on the
	// URL the browser opens: the authorization request stays as it was, since the
	// PDS drops any field it does not know.
	it('hints the typed name and the creator to the host on the sign-up link, and adds nothing to the request', async () => {
		for (const name of ['Kona Trail Runners', 'Hilo & Kona #1 = "best" <runners>?']) {
			const { authorize, result } = start({ name });

			const answer = await result;
			expect(answer.ok).toBe(true);
			const signUp = new URL(answer.ok ? answer.signUpUrl : '');
			expect(signUp.searchParams.get('gh_name')).toBe(name);
			expect(signUp.searchParams.get('gh_person')).toBe(CREATOR);
			expect(signUp.searchParams.get('request_uri')).toBe('x');
			expect([...signUp.searchParams.keys()].sort()).toEqual([
				'gh_name',
				'gh_person',
				'request_uri'
			]);

			const [options] = authorize.mock.calls[0] as unknown as [Record<string, unknown>];
			expect(Object.keys(options).sort()).toEqual([
				'prompt',
				'redirectUri',
				'scope',
				'state',
				'target'
			]);
			expect(JSON.stringify(options)).not.toContain('gh_');
		}
	});

	it('refuses a private group without approval before the host is asked', async () => {
		const { authorize, result } = start({ visibility: 'private', requireApproval: false });

		expect((await result).ok).toBe(false);
		expect(authorize).not.toHaveBeenCalled();
	});

	it('refuses before the host is asked when the row would not fit the database', async () => {
		harness.raw.exec('ALTER TABLE groups ADD COLUMN slug TEXT CHECK (slug IS NOT NULL)');
		const { authorize, result } = start();

		const answer = await result;
		expect(answer.ok).toBe(false);
		expect(!answer.ok && answer.error).toContain('nothing was made');
		expect(authorize).not.toHaveBeenCalled();
	});
});

describe('setUpHostGroup', () => {
	it("makes the calendar space through the host, then writes only this app's records", async () => {
		const host = await hostWithGroup();

		const result = await setUpHostGroup(
			{ DB: harness.db, GROUP_HOST_URL: HOST },
			CREATOR,
			fields(),
			credential(),
			HOST
		);

		expect(result).toEqual({ ok: true, groupDid: GROUP });
		const writes = host.writes();
		// The calendar space before any record, with an `access` record naming the
		// host's roles. The stub does not count the host's own method as a write.
		const sent = host.requests.map((r) => r.nsid);
		expect(sent.indexOf('group.opensocial.createSpace')).toBeGreaterThanOrEqual(0);
		expect(sent.indexOf('group.opensocial.createSpace')).toBeLessThan(sent.indexOf(writes[0].nsid));
		const createSpace = host.requests.find((r) => r.nsid === 'group.opensocial.createSpace');
		expect(createSpace?.body).toEqual({
			type: CALENDAR_SPACE_TYPE,
			skey: 'self',
			access: {
				public: false,
				grants: [
					{ role: 'admin', scopes: [`space:${CALENDAR_SPACE_TYPE}?action=read`] },
					{ role: 'member', scopes: [`space:${CALENDAR_SPACE_TYPE}?action=read`] }
				]
			}
		});
		// Every write on the creator's own session.
		expect(new Set(host.requests.map((r) => r.person))).toEqual(new Set([CREATOR]));
		// What the host already holds is left alone: no role, permissions,
		// membership or space index, and no member list or read policy.
		const collections = host.spaceWrites.map((w) => w.collection);
		for (const theirs of [
			'group.opensocial.role',
			'group.opensocial.permissions',
			'group.opensocial.membership',
			'group.opensocial.space'
		]) {
			expect(collections).not.toContain(theirs);
		}
		expect(writes.some((w) => w.nsid.startsWith('com.atproto.simplespace.'))).toBe(false);
		// The event bindings name the host's roles.
		expect(host.record(MEMBERS, 'rsvp.atmo.group.eventPermissions', 'self')).toMatchObject({
			bindings: [
				{ role: 'admin', actions: expect.arrayContaining(['createEvent', 'manageEvents']) },
				{ role: 'member', actions: [] }
			]
		});
		expect(host.record(META, 'group.opensocial.profile', 'self')).toMatchObject({
			displayName: 'Kona Trail Runners',
			description: 'Dawn runs',
			joinPolicy: 'approval'
		});
		expect(host.records(META, 'group.opensocial.rule')).toHaveLength(2);
		// The host's grants kept; only `public` follows the form.
		expect(host.record(META, 'group.opensocial.access', 'self')).toEqual({
			$type: 'group.opensocial.access',
			public: true,
			grants: HOST_META_GRANTS
		});
		expect(host.repoWrites.map((w) => w.collection)).toEqual(['group.opensocial.declaration']);
		// The row, owned by the creator, with the host's spaces recorded.
		const row = await getGroupByDid(harness.db, GROUP);
		expect(row).toMatchObject({
			owner_did: CREATOR,
			about_space_uri: META,
			members_space_uri: MEMBERS
		});
	});

	it("uploads the picture on the creator's session and names it in the profile", async () => {
		const host = await hostWithGroup();

		const result = await setUpHostGroup(
			{ DB: harness.db, GROUP_HOST_URL: HOST },
			CREATOR,
			fields(),
			credential(),
			HOST,
			picture()
		);

		expect(result.ok).toBe(true);
		expect(host.blobs).toEqual([{ mimeType: 'image/png', bytes: PNG }]);
		const upload = host.requests.find((r) => r.nsid === 'com.atproto.repo.uploadBlob');
		expect(upload?.person).toBe(CREATOR);
		expect(host.record(META, 'group.opensocial.profile', 'self')).toMatchObject({
			avatar: { $type: 'blob', ref: { $link: 'bafkreiupload1' }, mimeType: 'image/png' }
		});
	});

	it('uploads nothing, and the profile names no picture, when the form had none', async () => {
		const host = await hostWithGroup();

		await setUpHostGroup(
			{ DB: harness.db, GROUP_HOST_URL: HOST },
			CREATOR,
			fields(),
			credential(),
			HOST
		);

		expect(host.blobs).toEqual([]);
		expect(host.record(META, 'group.opensocial.profile', 'self')).not.toHaveProperty('avatar');
	});

	it('neither opens nor declares a private group', async () => {
		const host = await hostWithGroup();

		const result = await setUpHostGroup(
			{ DB: harness.db, GROUP_HOST_URL: HOST },
			CREATOR,
			fields({ visibility: 'private', requireApproval: true }),
			credential(),
			HOST
		);

		expect(result.ok).toBe(true);
		expect(host.record(META, 'group.opensocial.access', 'self')).toMatchObject({ public: false });
		expect(host.repoWrites).toEqual([]);
		expect(host.record(META, 'group.opensocial.profile', 'self')).toMatchObject({
			joinPolicy: 'invite'
		});
	});

	it('names the group the host made when a step after it fails', async () => {
		const host = await hostWithGroup((nsid) =>
			nsid === 'group.opensocial.createSpace'
				? Response.json({ error: 'InvalidScope', message: 'no' }, { status: 400 })
				: undefined
		);

		const result = await setUpHostGroup(
			{ DB: harness.db, GROUP_HOST_URL: HOST },
			CREATOR,
			fields(),
			credential(),
			HOST
		);

		expect(result.ok).toBe(false);
		expect(!result.ok && result.error).toContain(GROUP);
		expect(host.spaceWrites).toEqual([]);
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
			stash?: ReturnType<typeof memoryStash>;
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
				env: {
					DB: harness.db,
					GROUP_HOST_URL: HOST,
					OAUTH_PUBLIC_URL: 'https://atmo.stub.test',
					OAUTH_SESSIONS: {} as KVNamespace
				},
				clientFor,
				states,
				params: new URLSearchParams({ state: STATE_ID, code: 'c', iss: HOST }),
				signedInDid: 'signedInDid' in options ? (options.signedInDid ?? null) : CREATOR,
				stash: options.stash
			})
		};
	}

	it('sets up the group the host made, filed under the person who started it', async () => {
		await hostWithGroup();
		const { clientFor, client, result } = finish();

		expect(await result).toEqual({ ok: true, groupDid: GROUP });
		expect(clientFor).toHaveBeenCalledWith(CREATOR);
		expect(client.revoke).not.toHaveBeenCalled();
		expect(await groupRows()).toEqual([{ group_did: GROUP, owner_did: CREATOR }]);
	});

	it('takes the picture the form left and uploads it into the new group', async () => {
		const host = await hostWithGroup();
		const stash = memoryStash();
		const key = await stash.put(picture());

		const { result } = finish({ stored: { userState: { ...started, avatar: key } }, stash });

		expect(await result).toEqual({ ok: true, groupDid: GROUP });
		expect(stash.take).toHaveBeenCalledWith(key);
		expect(stash.kept.size).toBe(0);
		expect(host.blobs).toHaveLength(1);
	});

	// The group exists at the host by now, so a lost picture is not worth a
	// half-made group: it can be added later.
	it('makes the group without the picture when it is gone', async () => {
		const host = await hostWithGroup();

		const { result } = finish({
			stored: { userState: { ...started, avatar: 'picture-lapsed' } },
			stash: memoryStash()
		});

		expect(await result).toEqual({ ok: true, groupDid: GROUP });
		expect(host.blobs).toEqual([]);
		expect(host.record(META, 'group.opensocial.profile', 'self')).not.toHaveProperty('avatar');
	});

	it('refuses a browser signed in as someone else before the code is exchanged', async () => {
		const { states, client, result } = finish({ signedInDid: 'did:plc:someoneelseaaaaaaaaaaaa' });

		expect((await result).ok).toBe(false);
		expect(states.delete).toHaveBeenCalledWith(STATE_ID);
		expect(client.callback).not.toHaveBeenCalled();
	});

	it('refuses a state that is not a create', async () => {
		const { client, result } = finish({
			stored: { userState: { groupDid: GROUP, by: CREATOR } }
		});

		expect(await result).toMatchObject({ ok: false, groupDid: null });
		expect(client.callback).not.toHaveBeenCalled();
	});

	it('revokes and sets up nothing when the account is not at the group host', async () => {
		vi.mocked(isHostGroup).mockResolvedValue(false);
		const { client, result } = finish();

		expect(await result).toMatchObject({ ok: false, groupDid: null });
		expect(client.revoke).toHaveBeenCalledWith(GROUP);
		expect(await groupRows()).toEqual([]);
	});

	it('sets up nothing for a group this site already has', async () => {
		const host = await hostWithGroup();
		await finish().result;
		host.clearLog();

		const { result } = finish();

		expect(await result).toMatchObject({ ok: false, groupDid: GROUP });
		expect(host.writes()).toEqual([]);
	});

	it('reports a sign-up the host did not finish', async () => {
		const { result } = finish({
			callback: async () => {
				throw new Error('access_denied');
			}
		});

		const answer = await result;
		expect(answer.ok).toBe(false);
		expect(!answer.ok && answer.error).toContain('access_denied');
		expect(await groupRows()).toEqual([]);
	});
});
