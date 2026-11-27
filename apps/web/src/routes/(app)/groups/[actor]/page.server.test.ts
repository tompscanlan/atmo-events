import { beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';

const mocks = vi.hoisted(() => ({
	groupView: vi.fn(),
	listAuthoredEventsFromContrail: vi.fn(),
	ongoingQuery: vi.fn(),
	getProfileCounts: vi.fn(),
	callerSession: vi.fn(),
	requireGroupWriter: vi.fn(),
	listMembersOnlyEvents: vi.fn(),
	readCalendarSpace: vi.fn(),
	readRolesAsPerson: vi.fn()
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
	readCalendarSpace: mocks.readCalendarSpace
}));
vi.mock('#lib/groups/server/person.js', () => ({
	personReader: () => ({}),
	readRolesAsPerson: mocks.readRolesAsPerson
}));
vi.mock('#lib/private-events/server/caller.js', () => ({ callerSession: mocks.callerSession }));
vi.mock('#lib/contrail.js', () => ({
	listAuthoredEventsFromContrail: mocks.listAuthoredEventsFromContrail,
	flattenEventRecords: (records: unknown[]) => records
}));
vi.mock('#lib/contrail/ongoing.js', async (importActual) => ({
	EMPTY_ONGOING: (await importActual<typeof import('#lib/contrail/ongoing.js')>()).EMPTY_ONGOING,
	ongoingQuery: mocks.ongoingQuery
}));
vi.mock('#lib/server/profile-counts.js', () => ({ getProfileCounts: mocks.getProfileCounts }));
vi.mock('#lib/contrail/index.js', () => ({ getServerClient: () => ({}) }));
/** Making groups here is tested in the build, and once without. */
const build = vi.hoisted(() => ({ create: true }));
vi.mock('#lib/groups/build.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/groups/build.js')>()),
	get CREATE_IN_THIS_BUILD() {
		return build.create;
	}
}));

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
	build.create = true;
	Object.assign(env, { GROUP_HOST_URL: 'https://host.example' });
	Reflect.deleteProperty(env, 'SPACES_PDS_URL');
	mocks.groupView.mockResolvedValue({ did: GROUP, name: 'Knitters', description: null });
	mocks.listAuthoredEventsFromContrail.mockResolvedValue({ records: [] });
	mocks.ongoingQuery.mockResolvedValue({ events: [], total: 0, totalIsFloor: false });
	mocks.getProfileCounts.mockResolvedValue({ created: 0, rsvpd: 0 });
});

describe('a group page', () => {
	const NOTHING = {
		post: false,
		list: false,
		turnOnMembersOnly: false,
		membersOnly: false
	};
	const holder = (can: Partial<typeof NOTHING>) => {
		mocks.callerSession.mockResolvedValue({ did: ALICE, scope: 'atproto', handle: vi.fn() });
		mocks.groupView.mockResolvedValue({
			did: GROUP,
			name: 'Knitters',
			description: null,
			linked: { can: { ...NOTHING, ...can } }
		});
	};

	it('shows only its own notices, so a made-up ?link= is no notice at all', async () => {
		holder({ post: true });
		expect((await load(request('?link=linked', ALICE))).notice).toEqual(expect.any(String));
		for (const link of ['toString', 'constructor', '__proto__', 'nope']) {
			expect((await load(request(`?link=${link}`, ALICE))).notice).toBeNull();
		}
	});

	it('says it is linked only to the person who holds a working link', async () => {
		// Signed out, a person without a link, and one whose link no longer reads the group.
		expect((await load(request('?link=linked'))).notice).toBeNull();
		mocks.callerSession.mockResolvedValue({ did: ALICE, scope: 'atproto', handle: vi.fn() });
		mocks.groupView.mockResolvedValue({
			did: GROUP,
			name: 'Knitters',
			linked: null,
			hasLink: true
		});
		expect((await load(request('?link=linked', ALICE))).notice).toBeNull();
		expect((await load(request('?link=created', ALICE))).notice).toBeNull();
	});

	it("words the notice from what the person's link may do", async () => {
		holder({ post: true, list: true });
		expect((await load(request('?link=linked', ALICE))).notice).toBe(
			'Linked. You can now post its events and list it here.'
		);
		holder({ post: true });
		expect((await load(request('?link=created', ALICE))).notice).toBe(
			'Your group is made, and linked. You can now post its events here.'
		);
		holder({});
		expect((await load(request('?link=linked', ALICE))).notice).toBe(
			'Linked. Your role in this group lets you see it here.'
		);
	});

	it('says no group was made here in a build without making groups here', async () => {
		build.create = false;
		holder({ post: true });
		expect((await load(request('?link=created', ALICE))).notice).toBeNull();
		expect((await load(request('?link=linked', ALICE))).notice).toBe(
			'Linked. You can now post its events here.'
		);
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

describe("a group page's public events", () => {
	const event = (rkey: string, startsAt: string, endsAt?: string) => ({
		uri: `at://${GROUP}/community.lexicon.calendar.event/${rkey}`,
		did: GROUP,
		rkey,
		name: rkey,
		startsAt,
		...(endsAt ? { endsAt } : {}),
		createdAt: '2020-01-01T00:00:00Z'
	});

	it("reads them as a person's profile does: under way, coming and past, a few of each", async () => {
		const coming = Array.from({ length: 7 }, (_, i) =>
			event(`c${i}`, `2099-01-0${i + 1}T00:00:00Z`)
		);
		const over = event('over', '2020-01-01T00:00:00Z', '2020-01-02T00:00:00Z');
		// Began before now and still running: under way, never past.
		const running = event('running', '2020-01-01T00:00:00Z', '2099-01-01T00:00:00Z');
		mocks.listAuthoredEventsFromContrail.mockImplementation(async (_client, params) => ({
			records: params.order === 'asc' ? coming : [running, over]
		}));
		mocks.ongoingQuery.mockResolvedValue({ events: [running], total: 1, totalIsFloor: false });
		mocks.getProfileCounts.mockResolvedValue({ created: 9, rsvpd: 0 });
		const page = await load(request());
		expect(mocks.listAuthoredEventsFromContrail).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ actor: GROUP, order: 'asc', limit: 7 })
		);
		expect(mocks.ongoingQuery).toHaveBeenCalledWith(expect.anything(), { actor: GROUP });
		expect(page).toMatchObject({
			ongoingEvents: [running],
			hasMoreUpcoming: true,
			pastEvents: [over],
			hasMorePast: false,
			eventsCreated: 9
		});
		expect(page.upcomingEvents.map((e) => e.rkey)).toEqual(['c0', 'c1', 'c2', 'c3', 'c4', 'c5']);
	});

	it('still shows the page when the events under way, or the count, could not be read', async () => {
		mocks.ongoingQuery.mockRejectedValue(new Error('down'));
		mocks.getProfileCounts.mockResolvedValue(undefined);
		expect(await load(request())).toMatchObject({ ongoingEvents: [], eventsCreated: null });
	});
});

describe("a group page's members-only events", () => {
	const SUPPER = { name: 'Supper', rkey: 'r1', startsAt: '2099-01-01T18:00:00.000Z' };
	const person = (scope: string) => ({ did: ALICE, scope, handle: vi.fn() });

	beforeEach(() => {
		mocks.listMembersOnlyEvents.mockResolvedValue({
			events: [SUPPER],
			cutOff: false,
			privacy: 'private'
		});
		mocks.readCalendarSpace.mockResolvedValue({ state: 'ready', posters: ['admin'] });
	});

	it('are listed for a member, read with their own access', async () => {
		const caller = person(`atproto ${GUEST_SCOPE}`);
		mocks.callerSession.mockResolvedValue(caller);
		mocks.groupView.mockResolvedValue({ did: GROUP, name: 'Knitters', member: true });
		const page = await load(request('', ALICE));
		expect(page.membersOnly).toEqual({
			events: [SUPPER],
			unread: false,
			stoppedAt: null,
			privacy: 'private'
		});
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
			mocks.listMembersOnlyEvents.mockResolvedValue({ events: [SUPPER], cutOff: false });
			const some = await outside(did, view);
			mocks.listMembersOnlyEvents.mockResolvedValue(null);
			expect(await outside(did, view)).toEqual(some);
			expect(some).toMatchObject({ membersOnly: null, calendar: null });
		}
		expect(mocks.listMembersOnlyEvents).not.toHaveBeenCalled();
		expect(mocks.readCalendarSpace).not.toHaveBeenCalled();
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
		expect(mocks.readCalendarSpace).toHaveBeenCalledWith(writer);
	});

	it("says whether they are on to a link that may turn them on, but can't read them yet", async () => {
		mocks.requireGroupWriter.mockResolvedValue({ did: GROUP, handle: vi.fn() });
		mocks.callerSession.mockResolvedValue(person('atproto'));
		mocks.readCalendarSpace.mockResolvedValue({ state: 'missing', posters: [] });
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
		expect((await load(request('', ALICE))).membersOnly).toEqual({
			events: [],
			unread: true,
			stoppedAt: null,
			privacy: 'unknown'
		});
	});

	it('say where the list stopped when it stopped at its limit', async () => {
		mocks.callerSession.mockResolvedValue(person(`atproto ${GUEST_SCOPE}`));
		mocks.groupView.mockResolvedValue({ did: GROUP, name: 'Knitters', member: true });
		mocks.listMembersOnlyEvents.mockResolvedValue({
			events: [SUPPER],
			cutOff: true,
			privacy: 'public'
		});
		expect((await load(request('', ALICE))).membersOnly).toEqual({
			events: [SUPPER],
			unread: false,
			stoppedAt: 500,
			privacy: 'public'
		});
	});
});

describe("a group page's calendar setup, for a link that turned it on but can't post yet", () => {
	const linkedFor = (can: object) => {
		mocks.requireGroupWriter.mockResolvedValue({ did: GROUP, handle: vi.fn() });
		mocks.callerSession.mockResolvedValue({ did: ALICE, scope: 'atproto', handle: vi.fn() });
		mocks.groupView.mockResolvedValue({
			did: GROUP,
			name: 'Knitters',
			linked: { can: { turnOnMembersOnly: true, membersOnly: false, ...can } }
		});
	};

	beforeEach(() => {
		mocks.readCalendarSpace.mockResolvedValue({ state: 'ready', posters: ['admin'] });
	});

	it('is ready, to approve once more, for a role the policy lets post', async () => {
		linkedFor({});
		mocks.readRolesAsPerson.mockResolvedValue(['member', 'admin']);
		expect((await load(request('', ALICE))).calendar).toBe('ready');
	});

	it("says the person's role can't post, rather than to approve again, for any other", async () => {
		linkedFor({});
		mocks.readRolesAsPerson.mockResolvedValue(['member', 'organizer']);
		expect((await load(request('', ALICE))).calendar).toBe('no-role');
	});

	it('stays ready when the roles could not be read', async () => {
		vi.spyOn(console, 'info').mockImplementation(() => {});
		linkedFor({});
		mocks.readRolesAsPerson.mockRejectedValue(new Error('502'));
		expect((await load(request('', ALICE))).calendar).toBe('ready');
		mocks.readRolesAsPerson.mockResolvedValue(null);
		expect((await load(request('', ALICE))).calendar).toBe('ready');
	});

	it('reads no roles for a link that already posts, or a calendar not ready', async () => {
		linkedFor({ membersOnly: true });
		expect((await load(request('', ALICE))).calendar).toBe('ready');
		linkedFor({});
		mocks.readCalendarSpace.mockResolvedValue({ state: 'unusable', posters: [] });
		expect((await load(request('', ALICE))).calendar).toBe('unusable');
		expect(mocks.readRolesAsPerson).not.toHaveBeenCalled();
	});
});
