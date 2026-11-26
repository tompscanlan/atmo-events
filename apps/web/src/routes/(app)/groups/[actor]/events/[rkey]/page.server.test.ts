// Who may see a members-only event's page. Everyone kept out gets what a made-up key gets.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { error } from '@sveltejs/kit';
import { GUEST_SCOPE } from '#lib/private-events/scopes.js';

const mocks = vi.hoisted(() => ({
	groupView: vi.fn(),
	requireGroupWriter: vi.fn(),
	callerSession: vi.fn(),
	readPage: vi.fn(),
	readAsGroup: vi.fn()
}));
vi.mock('#lib/groups/server/context.js', () => ({
	groupView: mocks.groupView,
	requireGroupWriter: mocks.requireGroupWriter
}));
vi.mock('#lib/private-events/server/caller.js', () => ({ callerSession: mocks.callerSession }));
vi.mock('#lib/groups/server/member-rsvp.js', () => ({ readMembersOnlyEventPage: mocks.readPage }));
vi.mock('#lib/groups/server/group-events.js', () => ({
	readMembersOnlyEventAsGroup: mocks.readAsGroup
}));

import { load } from './+page.server';

const GROUP = 'did:plc:group';
const BOB = 'did:plc:bob';
const RKEY = '3lsupper';
const EVENT = {
	$type: 'community.lexicon.calendar.event',
	name: 'Supper',
	createdAt: '2026-11-01T00:00:00.000Z',
	startsAt: '2099-01-01T18:00:00.000Z'
};
const setHeaders = vi.fn();

type Viewer = { did: string; scope: string } | null;
function request(viewer: Viewer, rkey = RKEY) {
	mocks.callerSession.mockResolvedValue(viewer && { ...viewer, handle: vi.fn() });
	return {
		params: { actor: GROUP, rkey },
		locals: { did: viewer?.did ?? null, session: viewer ? {} : null },
		url: new URL(`https://atmo.example/groups/${GROUP}/events/${rkey}`),
		setHeaders
	} as never;
}

const group = (view: Record<string, unknown> = {}) =>
	mocks.groupView.mockResolvedValue({
		did: GROUP,
		handle: 'knit.example',
		name: 'Knitters',
		member: null,
		linked: null,
		askAccess: false,
		...view
	});

/** The group's calendar holds one event; the host lets in only `readers`. */
function theCalendarHolds(readers: string[]) {
	mocks.readPage.mockImplementation(async (caller: { did: string }, _g: string, rkey: string) =>
		readers.includes(caller.did) && rkey === RKEY
			? { event: { ...EVENT, rkey, did: GROUP, uri: 'u', cid: 'c' }, viewerStatus: 'going' }
			: null
	);
	mocks.readAsGroup.mockImplementation(async (_w: unknown, rkey: string) =>
		rkey === RKEY ? { uri: 'u', cid: 'c', rkey, value: EVENT } : null
	);
}

const answer = (viewer: Viewer, rkey?: string) =>
	(load as (e: never) => Promise<unknown>)(request(viewer, rkey)).catch((e: unknown) => e);

beforeEach(() => {
	vi.resetAllMocks();
	Object.assign(env, { GROUP_HOST_URL: 'https://host.example' });
	vi.spyOn(console, 'error').mockImplementation(() => {});
	theCalendarHolds([BOB]);
});

describe("a members-only event's page", () => {
	it('shows a member the event, marked private, with their own RSVP, and keeps no copy', async () => {
		group({ member: true });
		const data = await answer({ did: BOB, scope: `atproto ${GUEST_SCOPE}` });
		expect(data).toMatchObject({
			view: 'event',
			pageTitle: 'Supper',
			group: { name: 'Knitters' },
			viewerRsvpStatus: 'going',
			canRsvp: true,
			canEdit: false
		});
		expect(mocks.readPage).toHaveBeenCalledWith(expect.objectContaining({ did: BOB }), GROUP, RKEY);
		expect(setHeaders).toHaveBeenCalledWith({ 'cache-control': 'no-store' });
	});

	it('shows it to someone whose link may post them, read as the group', async () => {
		group({ member: null, linked: { can: { membersOnly: true } } });
		mocks.requireGroupWriter.mockResolvedValue({ did: GROUP, handle: vi.fn() });
		expect(await answer({ did: BOB, scope: 'atproto' })).toMatchObject({
			view: 'event',
			canRsvp: false,
			canEdit: true
		});
	});

	it('asks a member whose sign-in cannot open it for that first, at any key', async () => {
		group({ member: true });
		const viewer = { did: BOB, scope: 'atproto' };
		const real = await answer(viewer);
		expect(real).toMatchObject({ view: 'grant', access: 'ask' });
		expect(await answer(viewer, '3lmadeup')).toEqual(real);
		expect(mocks.readPage).not.toHaveBeenCalled();
	});

	it.each([
		['someone signed out', null, {}],
		['someone outside the group', { did: 'did:plc:carol', scope: `atproto ${GUEST_SCOPE}` }, {}],
		[
			'a member the host no longer lets in',
			{ did: 'did:plc:dana', scope: `atproto ${GUEST_SCOPE}` },
			{ member: true }
		],
		[
			'someone whose link may not post them',
			{ did: BOB, scope: 'atproto' },
			{ linked: { can: {} } }
		]
	])('tells %s what it tells them at a made-up key', async (_, viewer, view) => {
		group(view);
		const made = await answer(viewer, '3lmadeup');
		const real = await answer(viewer);
		expect(real).toEqual(made);
		if (viewer) expect(real).toMatchObject({ status: 404, body: { message: 'Event not found' } });
		else
			expect(real).toEqual({
				pageTitle: 'Members-only event',
				group: expect.anything(),
				view: 'signed-out'
			});
	});

	it("tells anyone a group they can't see is not found, at any key", async () => {
		mocks.groupView.mockImplementation(async () => error(404, 'Group not found'));
		for (const viewer of [null, { did: 'did:plc:carol', scope: GUEST_SCOPE }]) {
			expect(await answer(viewer)).toEqual(await answer(viewer, '3lmadeup'));
			expect(await answer(viewer)).toMatchObject({ status: 404 });
		}
	});

	it('does not pass an outage off as not there, and logs not whose or which', async () => {
		group({ member: true });
		mocks.readPage.mockRejectedValue(new Error(`fetch failed for ${BOB} at ${RKEY}`));
		expect(await answer({ did: BOB, scope: GUEST_SCOPE })).toMatchObject({ status: 503 });
		const logged = String(vi.mocked(console.error).mock.calls);
		for (const secret of [BOB, RKEY, GROUP]) expect(logged).not.toContain(secret);
	});

	it('has no action a form could post to', async () => {
		const route = await import('./+page.server');
		expect((route as { actions?: unknown }).actions).toBeUndefined();
	});
});
