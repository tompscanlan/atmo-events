// Writing as a group: where the credential comes from, and the transport behind
// the one seam.
//
// The only lasting credentials are group sessions, one per person and group,
// each linked by the person it is filed under. The store is read for real; the OAuth client that restores a session is the fixture's
// (./__fixtures__/linked-group.ts), which sends each request through the global
// `fetch` with its own token, so a request it served is one that carries it.
//
// A linked session renews its own tokens inside the OAuth client, so the seam
// only checks whose session it is and reports each write.
//
// Every write logs which credential served it, never the token.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('$lib/atproto/server/oauth', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/atproto/server/oauth')>()),
	...(await import('./__fixtures__/linked-oauth-stub')).linkedOAuthStub
}));

import { linkGroups, unlinkAllGroups } from './__fixtures__/linked-group';
import {
	GROUP_LINK_SCOPES,
	GROUP_SESSION_PREFIX,
	GROUP_SESSION_SCOPES,
	GroupCredentialError,
	groupClient,
	groupSessionKey,
	groupSessionScope,
	parseGroupSessionKey,
	resolveGroupCredential,
	STAND_IN_HOST_SCOPES,
	standInHostCredential,
	type LinkedGroupCredential
} from './session';
import { GROUP_DECLARATION_COLLECTION } from '../declaration-record';
import { GROUP_EVENT_COLLECTION } from '../ids';
import { ABOUT_SPACE_TYPE, CALENDAR_SPACE_TYPE, MEMBERS_SPACE_TYPE } from '../types';

const DID = 'did:plc:sessiontestgroup0000000';
const OTHER = 'did:plc:someoneelseaaaaaaaaaaaaa';
const PERSON = 'did:plc:sessionpersonaaaaaaaaaaa';
const SECOND = 'did:plc:secondpersonaaaaaaaaaaaa';
const PATH = '/xrpc/com.atproto.space.getRecord?space=s&repo=r';
const WRITE = '/xrpc/com.atproto.repo.createRecord';

/** A sessions namespace holding exactly `keys`. */
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
		await expect(groupClient(linked(OTHER), DID)).rejects.toThrow(/authenticates .*someoneelse/);
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

	// Two members with write roles each hold their own session on one group, and
	// a lookup for one never answers with the other's.
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
		// The key before sessions were per person names one DID, and parses as none.
		expect(parseGroupSessionKey(GROUP_SESSION_PREFIX + DID)).toBeNull();
	});

	// Nothing else stands in: no stored password, no deployment-wide account, and
	// no other person's session.
	it('is null for a person who has not linked the group', async () => {
		await expect(resolveGroupCredential(linkGroups([OTHER]), DID, PERSON)).resolves.toBeNull();
		await expect(
			resolveGroupCredential(linkGroups([DID], undefined, [SECOND]), DID, PERSON)
		).resolves.toBeNull();
	});

	it('is null on a deployment with no sessions namespace', async () => {
		await expect(resolveGroupCredential({}, DID, PERSON)).resolves.toBeNull();
	});

	// A sign-in as the group is stored under the bare DID. It lacks the group's
	// scope, so it must not count as a link. The fixture's client throws for a
	// group no test linked, so a restore attempt would fail this case too.
	it('does not take a sign-in session under the bare DID for a link', async () => {
		await expect(
			resolveGroupCredential({ OAUTH_SESSIONS: kv([DID]) }, DID, PERSON)
		).resolves.toBeNull();
	});

	// The person linked it, so a silent "not linked" would hide a broken session.
	it('fails, rather than answering null, when a stored link cannot be restored', async () => {
		const env = { OAUTH_SESSIONS: kv([groupSessionKey(DID, PERSON)]) };

		await expect(resolveGroupCredential(env, DID, PERSON)).rejects.toThrow(/no linked session/);
	});
});

describe('standInHostCredential', () => {
	it('is the creator’s session, whoever else holds one', async () => {
		const env = linkGroups([DID], undefined, [PERSON, SECOND]);

		const cred = await standInHostCredential(env, { group_did: DID, owner_did: SECOND });

		expect(cred.kind === 'linked' && cred.person).toBe(SECOND);
	});

	it('names the creator when they hold none', async () => {
		const env = linkGroups([DID], undefined, [PERSON]);

		const refused = standInHostCredential(env, { group_did: DID, owner_did: SECOND });

		await expect(refused).rejects.toBeInstanceOf(GroupCredentialError);
		await expect(refused).rejects.toMatchObject({ personDid: SECOND, standInHost: true });
	});
});

describe('the scope a link asks for', () => {
	const asked = groupSessionScope(false).split(' ');
	const spaces = asked.filter((s) => s.startsWith('space:'));

	it('covers every public-repo collection the group writes', () => {
		const repo = asked.find((s) => s.startsWith('repo'));
		expect(repo).toContain(GROUP_EVENT_COLLECTION);
		expect(repo).toContain(GROUP_DECLARATION_COLLECTION);
	});

	// A host keeps a requested scope only whole, and grants record access per
	// space type, so a `space:*` scope over records would be dropped. Only space
	// creation is `space:*`, as the host grants it.
	it('names a space type for every record grant, in the group’s own spaces only', () => {
		expect(spaces.length).toBeGreaterThan(0);
		for (const s of spaces) expect(s).toContain('authority=self');
		const typeless = spaces.filter((s) => s.startsWith('space:*?'));
		expect(typeless).toEqual(['space:*?authority=self&manage=create']);
		for (const type of [ABOUT_SPACE_TYPE, MEMBERS_SPACE_TYPE, CALENDAR_SPACE_TYPE]) {
			expect(spaces.some((s) => s.startsWith(`space:${type}?`))).toBe(true);
		}
	});

	it('asks for the two join-request methods and for creating spaces', () => {
		expect(asked).toContain('rpc:group.opensocial.listJoinRequests?aud=*');
		expect(asked).toContain('rpc:group.opensocial.denyJoinRequest?aud=*');
		expect(asked.some((s) => s.startsWith('space:') && s.includes('manage=create'))).toBe(true);
	});

	// What only the stand-in host needs stays out of a person's session.
	it('asks for the stand-in host’s scopes only for its session', () => {
		for (const extra of STAND_IN_HOST_SCOPES) {
			expect(asked).not.toContain(extra);
			expect(groupSessionScope(true).split(' ')).toContain(extra);
		}
		expect(GROUP_LINK_SCOPES).toEqual([...GROUP_SESSION_SCOPES, ...STAND_IN_HOST_SCOPES]);
	});
});
