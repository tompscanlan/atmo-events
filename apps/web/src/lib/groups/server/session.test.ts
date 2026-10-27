import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('$lib/atproto/server/oauth', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/atproto/server/oauth')>()),
	...(await import('./__fixtures__/linked-oauth-stub')).linkedOAuthStub
}));

import { linkGroups, unlinkAllGroups } from './__fixtures__/linked-group';
import {
	GROUP_SESSION_PREFIX,
	groupClient,
	groupSessionKey,
	groupSessionScope,
	parseGroupSessionKey,
	resolveGroupCredential,
	type LinkedGroupCredential
} from './session';
import { GROUP_DECLARATION_COLLECTION } from '../declaration-record';
import { GROUP_EVENT_COLLECTION } from '../ids';

const DID = 'did:plc:sessiontestgroup0000000';
const OTHER = 'did:plc:someoneelseaaaaaaaaaaaaa';
const PERSON = 'did:plc:sessionpersonaaaaaaaaaaa';
const SECOND = 'did:plc:secondpersonaaaaaaaaaaaa';
const PATH = '/xrpc/com.atproto.space.getRecord?space=s&repo=r';
const WRITE = '/xrpc/com.atproto.repo.createRecord';

function kv(keys: string[]): KVNamespace {
	return {
		get: async (key: string) => (keys.includes(key) ? '{}' : null)
	} as unknown as KVNamespace;
}

let calls: { url: URL; token: string | null }[];
let reply: () => Response;
let logged: string[];

beforeEach(() => {
	calls = [];
	logged = [];
	reply = () => Response.json({ ok: true });
	vi.stubGlobal('fetch', async (input: URL | string, init?: RequestInit) => {
		const url = new URL(String(input));
		const token = new Headers(init?.headers).get('authorization')?.replace('Bearer ', '') ?? null;
		calls.push({ url, token });
		return reply();
	});
	vi.spyOn(console, 'info').mockImplementation((line: string) => {
		logged.push(line);
	});
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	unlinkAllGroups();
});

describe('groupClient: the linked session', () => {
	function linked(did: string): LinkedGroupCredential {
		return {
			kind: 'linked',
			person: PERSON,
			session: {
				did: did as LinkedGroupCredential['session']['did'],
				handle: async (pathname: string, init?: RequestInit) => {
					calls.push({ url: new URL(pathname, 'https://pds.stub.test'), token: null });
					return Response.json({ ok: true }, { status: init?.method === 'POST' ? 201 : 200 });
				}
			}
		};
	}

	it('sends through the session, and logs whose session served a write', async () => {
		const { handle } = await groupClient(linked(DID), DID);

		await handle(PATH, { method: 'GET' });
		await handle(WRITE, { method: 'POST', body: '{}' });

		expect(calls.map((c) => c.url.pathname)).toEqual([
			'/xrpc/com.atproto.space.getRecord',
			'/xrpc/com.atproto.repo.createRecord'
		]);
		expect(logged).toEqual([
			`[group-session] ${DID} com.atproto.repo.createRecord via linked by ${PERSON}: 201`
		]);
	});

	it('refuses a session that authenticates another account, before any request', async () => {
		await expect(groupClient(linked(OTHER), DID)).rejects.toThrow();
		expect(calls).toEqual([]);
	});
});

describe('resolveGroupCredential', () => {
	it('is the person’s own session when the store holds one for the group', async () => {
		const env = linkGroups([DID]);

		const cred = await resolveGroupCredential(env, DID, PERSON);

		expect(cred?.kind).toBe('linked');
		expect(cred?.kind === 'linked' && cred.session.did).toBe(DID);
		expect(cred?.kind === 'linked' && cred.person).toBe(PERSON);
	});

	it('keeps two people’s sessions on one group apart', async () => {
		const env = linkGroups([DID], undefined, [PERSON, SECOND]);

		const first = await resolveGroupCredential(env, DID, PERSON);
		const second = await resolveGroupCredential(env, DID, SECOND);

		expect(first?.kind === 'linked' && first.person).toBe(PERSON);
		expect(second?.kind === 'linked' && second.person).toBe(SECOND);
		expect(await resolveGroupCredential(env, DID, OTHER)).toBeNull();
	});

	it('files a session under the person, then the group', () => {
		expect(groupSessionKey(DID, PERSON)).toBe(`${GROUP_SESSION_PREFIX}${PERSON}/${DID}`);
		expect(parseGroupSessionKey(groupSessionKey(DID, PERSON))).toEqual({
			groupDid: DID,
			personDid: PERSON
		});
		expect(parseGroupSessionKey(GROUP_SESSION_PREFIX + DID)).toBeNull();
	});

	it('is null for a person who has not linked the group', async () => {
		await expect(resolveGroupCredential(linkGroups([OTHER]), DID, PERSON)).resolves.toBeNull();
		await expect(
			resolveGroupCredential(linkGroups([DID], undefined, [SECOND]), DID, PERSON)
		).resolves.toBeNull();
	});

	it('is null on a deployment with no sessions namespace', async () => {
		await expect(resolveGroupCredential({}, DID, PERSON)).resolves.toBeNull();
	});

	it('does not take a sign-in session under the bare DID for a link', async () => {
		await expect(
			resolveGroupCredential({ OAUTH_SESSIONS: kv([DID]) }, DID, PERSON)
		).resolves.toBeNull();
	});

	it('fails, rather than answering null, when a stored link cannot be restored', async () => {
		const env = { OAUTH_SESSIONS: kv([groupSessionKey(DID, PERSON)]) };

		await expect(resolveGroupCredential(env, DID, PERSON)).rejects.toThrow();
	});
});

describe('the scope a link asks for', () => {
	const asked = groupSessionScope().split(' ');

	it('asks for the proposal’s permission sets, and no raw space scope', () => {
		expect(asked).toEqual(
			expect.arrayContaining([
				'include:group.opensocial.configure',
				'include:group.opensocial.manageSpaces',
				'include:group.opensocial.manageMembers'
			])
		);
		expect(asked.filter((s) => s.startsWith('space:'))).toEqual([]);
	});

	it('covers every public-repo collection the group writes', () => {
		const repo = asked.find((s) => s.startsWith('repo'));
		expect(repo).toContain(GROUP_EVENT_COLLECTION);
		expect(repo).toContain(GROUP_DECLARATION_COLLECTION);
	});
});
