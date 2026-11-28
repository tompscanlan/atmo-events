import { beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';

const mocks = vi.hoisted(() => ({
	groupView: vi.fn(),
	getEventRecordFromContrail: vi.fn(),
	requireGroupWriter: vi.fn(),
	calendarSpaceState: vi.fn(),
	readMembersOnlyEventAsGroup: vi.fn()
}));
vi.mock('#lib/groups/server/context.js', async (importActual) => ({
	...(await importActual<typeof import('#lib/groups/server/context.js')>()),
	groupView: mocks.groupView,
	requireGroupWriter: mocks.requireGroupWriter
}));
vi.mock('#lib/groups/server/group-events.js', () => ({
	calendarSpaceState: mocks.calendarSpaceState,
	readMembersOnlyEventAsGroup: mocks.readMembersOnlyEventAsGroup
}));
vi.mock('#lib/contrail/index.js', () => ({ getServerClient: () => ({}) }));
vi.mock('#lib/contrail.js', () => ({
	getEventRecordFromContrail: mocks.getEventRecordFromContrail,
	flattenEventRecord: (record: unknown) => record
}));

import { load as newEvent } from './new/+page.server';
import { load as editEvent } from './[rkey]/edit/+page.server';

const GROUP = 'did:plc:group';
const request = () =>
	({
		params: { actor: GROUP, rkey: 'r' },
		locals: { did: 'did:plc:alice' },
		setHeaders: vi.fn()
	}) as never;

const linked = (post: boolean) => ({
	did: GROUP,
	handle: 'knit.example',
	name: 'Knitters',
	linked: { meta: { profile: null, public: true }, listed: false, can: { post } }
});

beforeEach(() => {
	vi.resetAllMocks();
	Object.assign(env, { GROUP_HOST_URL: 'https://host.example' });
	mocks.getEventRecordFromContrail.mockResolvedValue({ name: 'Meet' });
});

describe('posting and editing as the group', () => {
	it('opens the editor for a link whose scope posts', async () => {
		mocks.groupView.mockResolvedValue(linked(true));
		expect(await newEvent(request())).toMatchObject({ group: { did: GROUP }, postsPublic: true });
		expect(await editEvent(request())).toMatchObject({
			eventData: { name: 'Meet' },
			placement: 'everyone'
		});
	});

	it("says so, rather than opening an editor that can't save, for a link that may not post", async () => {
		mocks.groupView.mockResolvedValue(linked(false));
		for (const load of [newEvent, editEvent]) {
			await expect((load as (e: never) => Promise<unknown>)(request())).rejects.toMatchObject({
				status: 403,
				body: { message: "Your role in this group doesn't let you post its events." }
			});
		}
	});

	it('is the same 404 without a working link', async () => {
		mocks.groupView.mockResolvedValue({ ...linked(true), linked: null });
		for (const load of [newEvent, editEvent]) {
			await expect((load as (e: never) => Promise<unknown>)(request())).rejects.toMatchObject({
				status: 404
			});
		}
	});
});

describe('members-only events, from the editor', () => {
	const admin = (can: Record<string, boolean>) => ({
		...linked(true),
		linked: { ...linked(true).linked, can: { post: true, ...can } }
	});

	beforeEach(() => {
		mocks.requireGroupWriter.mockResolvedValue({ did: GROUP, handle: vi.fn() });
	});

	it('offers members only once they are on and the link may post them', async () => {
		mocks.groupView.mockResolvedValue(admin({ turnOnMembersOnly: true, membersOnly: true }));
		mocks.calendarSpaceState.mockResolvedValue('ready');
		expect(await newEvent(request())).toMatchObject({
			postsPublic: true,
			membersOnlyUnavailable: null
		});
	});

	it.each([
		['not turned on', 'missing', { turnOnMembersOnly: true }, 'Turn them on from its page'],
		[
			'on, before the link was approved once more',
			'ready',
			{ turnOnMembersOnly: true },
			'Approve your link once more'
		],
		['readable by anyone', 'readable', { membersOnly: true }, 'more than its members']
	])('says why not, when they are %s', async (_, state, can, words) => {
		mocks.groupView.mockResolvedValue(admin(can));
		mocks.calendarSpaceState.mockResolvedValue(state);
		const data = (await newEvent(request())) as { membersOnlyUnavailable: string };
		expect(data.membersOnlyUnavailable).toContain(words);
	});

	it('opens a members-only event to edit, read whole as the group, where the index has none', async () => {
		mocks.groupView.mockResolvedValue(admin({ membersOnly: true }));
		mocks.getEventRecordFromContrail.mockResolvedValue(null);
		const value = {
			$type: 'community.lexicon.calendar.event',
			name: 'Supper',
			createdAt: '2026-11-01T00:00:00.000Z',
			startsAt: '2099-01-01T18:00:00.000Z',
			poster: 'kept'
		};
		mocks.readMembersOnlyEventAsGroup.mockResolvedValue({ uri: 'u', cid: 'c', rkey: 'r', value });
		expect(await editEvent(request())).toMatchObject({
			placement: 'members',
			eventData: { name: 'Supper', poster: 'kept', did: GROUP, rkey: 'r' }
		});
		mocks.readMembersOnlyEventAsGroup.mockResolvedValue(null);
		await expect(editEvent(request())).rejects.toMatchObject({ status: 404 });
	});

	it('opens nothing to edit that is not a valid event, as another app sharing the calendar may write', async () => {
		mocks.groupView.mockResolvedValue(admin({ membersOnly: true }));
		mocks.getEventRecordFromContrail.mockResolvedValue(null);
		const value = { $type: 'community.lexicon.calendar.event', name: 'No start or date' };
		mocks.readMembersOnlyEventAsGroup.mockResolvedValue({ uri: 'u', cid: 'c', rkey: 'r', value });
		await expect(editEvent(request())).rejects.toMatchObject({ status: 404 });
	});

	it('edits a public event as public', async () => {
		mocks.groupView.mockResolvedValue(admin({ membersOnly: true }));
		expect(await editEvent(request())).toMatchObject({ placement: 'everyone' });
		expect(mocks.readMembersOnlyEventAsGroup).not.toHaveBeenCalled();
	});
});
