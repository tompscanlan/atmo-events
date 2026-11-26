import { beforeEach, describe, expect, it, vi } from 'vitest';
import { error } from '@sveltejs/kit';

// The in-app adapter the RSVP adapter starts from, as it is: its notify tells the public index
// about a write, and its writes go to the person's public repo.
const mocks = vi.hoisted(() => ({
	notify: vi.fn(),
	putRecord: vi.fn(),
	createRecord: vi.fn(),
	deleteRecord: vi.fn(),
	uploadBlob: vi.fn(),
	rsvpToMembersOnlyEvent: vi.fn(async () => ({ ok: true })),
	cancelMembersOnlyRsvp: vi.fn(async () => ({ ok: true })),
	invalidateAll: vi.fn()
}));
vi.mock('#lib/contrail.js', () => ({ notifyContrailOfUpdate: mocks.notify }));
vi.mock('#lib/atproto/repo.remote.js', () => ({
	putRecord: mocks.putRecord,
	createRecord: mocks.createRecord,
	deleteRecord: mocks.deleteRecord,
	uploadBlob: mocks.uploadBlob
}));
vi.mock('@svelte-atproto/oauth/helper', () => ({ getRecord: vi.fn(), resolveHandle: vi.fn() }));
vi.mock('$app/navigation', () => ({ goto: vi.fn(), invalidateAll: mocks.invalidateAll }));
vi.mock('$app/paths', () => ({
	resolve: (path: string, params: Record<string, string>) =>
		path.replace('[actor]', params.actor).replace('[rkey]', params.rkey)
}));
vi.mock('#lib/components/LoginModal.svelte', () => ({ atProtoLoginModalState: { show: vi.fn() } }));
vi.mock('./members-only.remote', () => ({
	rsvpToMembersOnlyEvent: mocks.rsvpToMembersOnlyEvent,
	cancelMembersOnlyRsvp: mocks.cancelMembersOnlyRsvp
}));

const { createMembersOnlyRsvpAdapter } = await import('./rsvp-adapter');

const GROUP = 'did:plc:group';
const BOB = 'did:plc:bob';
const RKEY = '3lsupper';
const EVENT_URI = `at:space/${GROUP}/community.lexicon.calendar.collection/self/${GROUP}/community.lexicon.calendar.event/${RKEY}`;
const RSVP = 'community.lexicon.calendar.rsvp';
const viewer = { isLoggedIn: true, did: BOB, canPostToBluesky: false };
const going = { status: `${RSVP}#going`, subject: { uri: EVENT_URI, cid: 'c' } };

beforeEach(() => vi.clearAllMocks());

describe("a member's RSVP to a members-only event", () => {
	it('goes to the server, tells the index nothing, and writes nothing to the public repo', async () => {
		const adapter = createMembersOnlyRsvpAdapter(GROUP, RKEY, viewer);
		const saved = await adapter.putRecord({ collection: RSVP, rkey: 'other', record: going });
		await adapter.deleteRecord({ collection: RSVP, rkey: 'other' });
		await adapter.notifyUpdate?.(EVENT_URI);
		expect(mocks.rsvpToMembersOnlyEvent).toHaveBeenCalledWith({
			groupDid: GROUP,
			rkey: RKEY,
			status: 'going',
			cid: 'c'
		});
		expect(mocks.cancelMembersOnlyRsvp).toHaveBeenCalledWith({ groupDid: GROUP, rkey: RKEY });
		expect(saved.uri).toBe(
			`at:space/${GROUP}/community.lexicon.calendar.collection/self/${BOB}/${RSVP}/${RKEY}`
		);
		expect(mocks.notify).not.toHaveBeenCalled();
		for (const write of [mocks.putRecord, mocks.createRecord, mocks.deleteRecord]) {
			expect(write).not.toHaveBeenCalled();
		}
	});

	it('writes nothing else, and reloads the page on a refusal', async () => {
		const adapter = createMembersOnlyRsvpAdapter(GROUP, RKEY, viewer);
		await expect(
			adapter.putRecord({ collection: 'community.lexicon.calendar.event', rkey: RKEY, record: {} })
		).rejects.toThrow();
		mocks.rsvpToMembersOnlyEvent.mockImplementationOnce(async () => error(409, 'changed'));
		await expect(
			adapter.putRecord({ collection: RSVP, rkey: RKEY, record: going })
		).rejects.toMatchObject({
			status: 409
		});
		expect(mocks.invalidateAll).toHaveBeenCalledOnce();
	});

	it('links the event to its own members-only page, not a public one', () => {
		const adapter = createMembersOnlyRsvpAdapter(GROUP, RKEY, viewer);
		expect(adapter.urls?.event?.(GROUP, RKEY)).toBe(`/(app)/groups/${GROUP}/events/${RKEY}`);
	});
});
