import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ rsvp: vi.fn(), cancel: vi.fn() }));
vi.mock('./member-rsvp.remote', () => ({
	rsvpToMembersOnlyEvent: mocks.rsvp,
	cancelMembersOnlyRsvp: mocks.cancel
}));
vi.mock('#lib/components/editor/adapter.js', () => ({
	createInAppAdapter: () => ({ notifyUpdate: vi.fn() })
}));

import { createMembersOnlyRsvpAdapter } from './rsvp-adapter';

const GROUP = 'did:plc:group';
const RSVP = 'community.lexicon.calendar.rsvp';
const viewer = { isLoggedIn: true, did: 'did:plc:alice' };
const adapter = () => createMembersOnlyRsvpAdapter(GROUP, 'e1', viewer);
const atEvent = { groupDid: GROUP, rkey: 'e1' };
// As the view's RSVP control builds it, with a key of its own.
const going = {
	collection: RSVP,
	rkey: '3mxyz',
	record: { $type: RSVP, status: `${RSVP}#going`, subject: { uri: 'at://s', cid: 'cid-1' } }
};

beforeEach(() => vi.resetAllMocks());

describe('the members-only RSVP adapter', () => {
	it("sends the answer and the version the page showed, at the event's key", async () => {
		await adapter().putRecord(going);
		expect(mocks.rsvp).toHaveBeenCalledWith({ ...atEvent, status: 'going', cid: 'cid-1' });
	});

	it('throws when the server refuses, so the view never shows an RSVP that was not saved', async () => {
		mocks.rsvp.mockRejectedValue(Object.assign(new Error('refused'), { status: 409 }));
		await expect(adapter().putRecord(going)).rejects.toThrow();
		mocks.cancel.mockRejectedValue(new Error('refused'));
		await expect(adapter().deleteRecord({ collection: RSVP, rkey: '3mxyz' })).rejects.toThrow();
	});

	it("cancels at the event's key, whatever key the view kept", async () => {
		await adapter().deleteRecord({ collection: RSVP, rkey: '3mxyz' });
		expect(mocks.cancel).toHaveBeenCalledWith(atEvent);
	});

	it('writes nothing but RSVPs, and tells the index nothing', async () => {
		const a = adapter();
		await expect(a.putRecord({ ...going, collection: 'app.bsky.feed.post' })).rejects.toThrow();
		expect(() => a.createRecord(going)).toThrow();
		expect(() => a.uploadBlob(new Blob())).toThrow();
		expect(mocks.rsvp).not.toHaveBeenCalled();
		await a.notifyUpdate?.('at://x');
		expect(a.features).toMatchObject({ delete: false, images: false });
	});
});
