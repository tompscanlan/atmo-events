import { beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';

const mocks = vi.hoisted(() => ({
	groupView: vi.fn(),
	hostingQuery: vi.fn(),
	callerSession: vi.fn(),
	requireGroupWriter: vi.fn(),
	listMembersOnlyEvents: vi.fn(),
	calendarSpaceState: vi.fn()
}));
vi.mock('#lib/groups/server/context.js', () => ({
	groupView: mocks.groupView,
	requireGroupWriter: mocks.requireGroupWriter
}));
vi.mock('#lib/groups/server/calendar-read.js', async (importActual) => ({
	...(await importActual<typeof import('#lib/groups/server/calendar-read.js')>()),
	listMembersOnlyEvents: mocks.listMembersOnlyEvents
}));
vi.mock('#lib/groups/server/group-events.js', () => ({
	calendarSpaceState: mocks.calendarSpaceState
}));
vi.mock('#lib/private-events/server/caller.js', () => ({ callerSession: mocks.callerSession }));
vi.mock('#lib/contrail/queries.js', () => ({ hostingQuery: mocks.hostingQuery }));
vi.mock('#lib/contrail/index.js', () => ({ getServerClient: () => ({}) }));

import { GUEST_SCOPE } from '#lib/private-events/scopes.js';
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

describe("a group page's members-only events", () => {
	const SUPPER = { name: 'Supper', rkey: 'r1', startsAt: '2099-01-01T18:00:00.000Z' };
	const person = (scope: string) => ({ did: ALICE, scope, handle: vi.fn() });

	beforeEach(() => {
		mocks.listMembersOnlyEvents.mockResolvedValue([SUPPER]);
		mocks.calendarSpaceState.mockResolvedValue('ready');
	});

	it('are listed for a member, read with their own access', async () => {
		const caller = person(`atproto ${GUEST_SCOPE}`);
		mocks.callerSession.mockResolvedValue(caller);
		mocks.groupView.mockResolvedValue({ did: GROUP, name: 'Knitters', member: true });
		const page = await load(request('', ALICE));
		expect(page.membersOnly).toEqual({ events: [SUPPER], unread: false });
		expect(mocks.listMembersOnlyEvents).toHaveBeenCalledWith(caller, GROUP);
		expect(page).toMatchObject({ access: null, calendar: null });
	});

	it('ask a member whose sign-in cannot open them, and read nothing', async () => {
		mocks.callerSession.mockResolvedValue(person('atproto'));
		mocks.groupView.mockResolvedValue({ did: GROUP, name: 'Knitters', member: true });
		const page = await load(request('', ALICE));
		expect(page).toMatchObject({ membersOnly: null, access: 'ask', accessForMembersOnly: true });
		expect(mocks.listMembersOnlyEvents).not.toHaveBeenCalled();
	});

	it('leave the page the same for anyone outside the group, whether there are any or not', async () => {
		const outside = async (did: string | null, view: object) => {
			mocks.callerSession.mockResolvedValue(did ? person(`atproto ${GUEST_SCOPE}`) : null);
			mocks.groupView.mockResolvedValue({ did: GROUP, name: 'Knitters', ...view });
			return load(request('', did));
		};
		for (const [did, view] of [
			[null, {}],
			[ALICE, { member: false }],
			[ALICE, { member: null }],
			[ALICE, { member: false, linked: { can: { post: true } } }]
		] as const) {
			mocks.listMembersOnlyEvents.mockResolvedValue([SUPPER]);
			const some = await outside(did, view);
			mocks.listMembersOnlyEvents.mockResolvedValue(null);
			expect(await outside(did, view)).toEqual(some);
			expect(some).toMatchObject({ membersOnly: null, calendar: null });
		}
		expect(mocks.listMembersOnlyEvents).not.toHaveBeenCalled();
		expect(mocks.calendarSpaceState).not.toHaveBeenCalled();
	});

	it('are read as the group, with whether they are on, through a link that may post them', async () => {
		const writer = { did: GROUP, handle: vi.fn() };
		mocks.requireGroupWriter.mockResolvedValue(writer);
		mocks.callerSession.mockResolvedValue(person('atproto'));
		mocks.groupView.mockResolvedValue({
			did: GROUP,
			name: 'Knitters',
			member: null,
			linked: { can: { turnOnMembersOnly: true, membersOnly: true } }
		});
		const page = await load(request('', ALICE));
		expect(page).toMatchObject({ membersOnly: { events: [SUPPER] }, calendar: 'ready' });
		expect(mocks.listMembersOnlyEvents).toHaveBeenCalledWith(writer, GROUP);
		expect(mocks.calendarSpaceState).toHaveBeenCalledWith(writer);
	});

	it("says whether they are on to a link that may turn them on, but can't read them yet", async () => {
		mocks.requireGroupWriter.mockResolvedValue({ did: GROUP, handle: vi.fn() });
		mocks.callerSession.mockResolvedValue(person('atproto'));
		mocks.calendarSpaceState.mockResolvedValue('missing');
		mocks.groupView.mockResolvedValue({
			did: GROUP,
			name: 'Knitters',
			linked: { can: { turnOnMembersOnly: true, membersOnly: false } }
		});
		expect(await load(request('', ALICE))).toMatchObject({
			membersOnly: null,
			calendar: 'missing'
		});
	});

	it('say they could not be read, rather than that there are none', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		mocks.callerSession.mockResolvedValue(person(`atproto ${GUEST_SCOPE}`));
		mocks.groupView.mockResolvedValue({ did: GROUP, name: 'Knitters', member: true });
		mocks.listMembersOnlyEvents.mockRejectedValue(new Error('502'));
		expect((await load(request('', ALICE))).membersOnly).toEqual({ events: [], unread: true });
	});
});
