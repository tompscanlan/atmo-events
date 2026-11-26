import { beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';

const mocks = vi.hoisted(() => ({
	groupView: vi.fn(),
	hostingQuery: vi.fn(),
	callerSession: vi.fn()
}));
vi.mock('#lib/groups/server/context.js', () => ({ groupView: mocks.groupView }));
vi.mock('#lib/private-events/server/caller.js', () => ({ callerSession: mocks.callerSession }));
vi.mock('#lib/contrail/queries.js', () => ({ hostingQuery: mocks.hostingQuery }));
vi.mock('#lib/contrail/index.js', () => ({ getServerClient: () => ({}) }));

import { load } from './+page.server';

const GROUP = 'did:plc:group';
const ALICE = 'did:plc:alice';
const request = (query = '', did: string | null = null) =>
	({
		params: { actor: GROUP },
		locals: { did, session: did ? {} : null },
		url: new URL(`https://atmo.example/groups/${GROUP}${query}`),
		setHeaders: vi.fn()
	}) as unknown as Parameters<typeof load>[0];

beforeEach(() => {
	vi.resetAllMocks();
	Object.assign(env, { GROUP_HOST_URL: 'https://host.example' });
	Reflect.deleteProperty(env, 'SPACES_PDS_URL');
	mocks.groupView.mockResolvedValue({ did: GROUP, name: 'Knitters', description: null });
	mocks.hostingQuery.mockResolvedValue({ events: [], cursor: null });
});

describe('a group page', () => {
	it('shows only its own notices, so a made-up ?link= is no notice at all', async () => {
		expect((await load(request('?link=linked'))).notice).toEqual(expect.any(String));
		for (const link of ['toString', 'constructor', '__proto__', 'nope']) {
			expect((await load(request(`?link=${link}`))).notice).toBeNull();
		}
	});

	it("reads the group with the person's own session, and asks for what it lacks", async () => {
		const person = { did: ALICE, scope: 'atproto', handle: vi.fn() };
		mocks.callerSession.mockResolvedValue(person);
		mocks.groupView.mockResolvedValue({ did: GROUP, name: 'Knitters', askAccess: true });
		const page = await load(request('', ALICE));
		expect(mocks.groupView).toHaveBeenCalledWith(GROUP, ALICE, person);
		expect(page).toMatchObject({ you: ALICE, access: 'ask', spacesServer: null });
	});

	it('points someone whose server said no at the spaces server, when there is one', async () => {
		Object.assign(env, { SPACES_PDS_URL: 'https://spaces.example' });
		mocks.callerSession.mockResolvedValue({ did: ALICE, scope: 'atproto', handle: vi.fn() });
		mocks.groupView.mockResolvedValue({ did: GROUP, name: 'Knitters', askAccess: true });
		expect(await load(request(`?asked=${ALICE}`, ALICE))).toMatchObject({
			access: 'refused',
			spacesServer: { url: 'https://spaces.example/', host: 'spaces.example' }
		});
	});

	it('asks nothing of someone signed out, or who holds the permissions', async () => {
		expect((await load(request())).access).toBeNull();
		expect(mocks.groupView).toHaveBeenCalledWith(GROUP, null, null);
		mocks.callerSession.mockResolvedValue({ did: ALICE, scope: 'atproto', handle: vi.fn() });
		mocks.groupView.mockResolvedValue({ did: GROUP, name: 'Knitters', askAccess: false });
		expect((await load(request(`?asked=${ALICE}`, ALICE))).access).toBeNull();
	});
});
