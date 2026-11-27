import { beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';

const mocks = vi.hoisted(() => ({
	groupView: vi.fn(),
	listAuthoredEventsFromContrail: vi.fn(),
	ongoingQuery: vi.fn(),
	getProfileCounts: vi.fn(),
	callerSession: vi.fn()
}));
vi.mock('#lib/groups/server/context.js', () => ({ groupView: mocks.groupView }));
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
	mocks.listAuthoredEventsFromContrail.mockResolvedValue({ records: [] });
	mocks.ongoingQuery.mockResolvedValue({ events: [], total: 0, totalIsFloor: false });
	mocks.getProfileCounts.mockResolvedValue({ created: 0, rsvpd: 0 });
});

describe('a group page', () => {
	const NOTHING = {
		post: false
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
	});

	it("words the notice from what the person's link may do", async () => {
		holder({ post: true });
		expect((await load(request('?link=linked', ALICE))).notice).toBe(
			'Linked. You can now post its events here.'
		);
		holder({});
		expect((await load(request('?link=linked', ALICE))).notice).toBe(
			'Linked. Your role in this group lets you see it here.'
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
