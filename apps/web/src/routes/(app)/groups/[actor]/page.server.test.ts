import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	groupView: vi.fn(),
	hostingQuery: vi.fn(),
	pendingSetup: vi.fn(),
	callerSession: vi.fn(),
	readMembersOnlyEvents: vi.fn()
}));
vi.mock('#lib/groups/server/context.js', () => ({ groupView: mocks.groupView }));
vi.mock('#lib/contrail/index.js', () => ({ getServerClient: () => ({}) }));
vi.mock('#lib/contrail/queries.js', () => ({ hostingQuery: mocks.hostingQuery }));
vi.mock('#lib/groups/server/create.js', () => ({ pendingSetup: mocks.pendingSetup }));
vi.mock('#lib/groups/server/caller.js', () => ({ callerSession: mocks.callerSession }));
vi.mock('#lib/groups/server/calendar-read.js', async (original) => ({
	...(await original()),
	readMembersOnlyEvents: mocks.readMembersOnlyEvents
}));

import { load } from './+page.server';

const GROUP = 'did:plc:group';
const caller = { did: 'did:plc:alice', scope: 'x', handle: vi.fn() };
const input = () =>
	({
		params: { actor: GROUP },
		locals: { did: caller.did, session: {} },
		url: new URL(`https://atmo.example/groups/${GROUP}`)
	}) as never;
const at = (rkey: string, startsAt: string) => ({
	rkey,
	startsAt,
	did: GROUP,
	uri: rkey,
	name: rkey
});

beforeEach(() => {
	vi.resetAllMocks();
	mocks.groupView.mockResolvedValue({ did: GROUP, name: 'Knitters', member: true, linked: null });
	mocks.hostingQuery.mockResolvedValue({ events: [], cursor: null });
	mocks.callerSession.mockResolvedValue(caller);
});

describe("the group page's members-only events", () => {
	it('lists the upcoming ones for a member, soonest first', async () => {
		mocks.readMembersOnlyEvents.mockResolvedValue([
			at('later', '2999-02-01T00:00:00.000Z'),
			at('past', '2001-01-01T00:00:00.000Z'),
			at('soon', '2999-01-01T00:00:00.000Z')
		]);
		const data = (await load(input())) as { membersOnly: { events: { rkey: string }[] } };
		expect(data.membersOnly.events.map((e) => e.rkey)).toEqual(['soon', 'later']);
		expect(mocks.readMembersOnlyEvents).toHaveBeenCalledWith(caller, GROUP);
	});

	it('reads nothing for someone the host does not count a member', async () => {
		mocks.groupView.mockResolvedValue({
			did: GROUP,
			name: 'Knitters',
			member: false,
			linked: null
		});
		expect(await load(input())).toMatchObject({ membersOnly: null });
		expect(mocks.readMembersOnlyEvents).not.toHaveBeenCalled();
	});

	it('shows nothing for a member who may not read the space, and says so when the read fails', async () => {
		mocks.readMembersOnlyEvents.mockResolvedValueOnce(null);
		expect(await load(input())).toMatchObject({ membersOnly: null });

		vi.spyOn(console, 'error').mockImplementation(() => {});
		mocks.readMembersOnlyEvents.mockRejectedValueOnce(new Error('host down'));
		const data = (await load(input())) as { membersOnly: { events: unknown[]; notice: unknown } };
		expect(data.membersOnly.events).toEqual([]);
		expect(typeof data.membersOnly.notice).toBe('string');
	});
});
