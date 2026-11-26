import { beforeEach, describe, expect, it, vi } from 'vitest';
import { error } from '@sveltejs/kit';

const mocks = vi.hoisted(() => ({
	putGroupEvent: vi.fn(),
	deleteGroupEvent: vi.fn(),
	uploadGroupBlob: vi.fn()
}));
vi.mock('./group.remote', () => mocks);
vi.mock('#lib/components/editor/adapter.js', () => ({ createInAppAdapter: () => ({}) }));
vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
vi.mock('$app/paths', () => ({ resolve: (path: string) => path }));

import { createGroupAdapter, groupViewer } from './editor-adapter';

const GROUP = 'did:plc:group';
const viewer = groupViewer({ did: GROUP, handle: 'knit.example', name: 'Knitters' });
const REASON = 'Your role in this group no longer allows that.';

beforeEach(() => vi.resetAllMocks());

describe('the group editor adapter', () => {
	it('hands the page the reason the server gives for a refusal, and still fails the save', async () => {
		const refused = vi.fn();
		const adapter = createGroupAdapter(GROUP, viewer, refused);
		for (const write of Object.values(mocks)) {
			write.mockImplementation(async () => error(403, REASON));
		}
		const record = { collection: 'community.lexicon.calendar.event', rkey: 'r', record: {} };
		await expect(adapter.putRecord(record)).rejects.toMatchObject({ status: 403 });
		await expect(adapter.deleteRecord(record)).rejects.toMatchObject({ status: 403 });
		await expect(adapter.uploadBlob(new Blob([new Uint8Array([1])]))).rejects.toMatchObject({
			status: 403
		});
		expect(refused.mock.calls).toEqual([[REASON], [REASON], [REASON]]);
	});

	it('leaves any other failure to the editor', async () => {
		const refused = vi.fn();
		mocks.putGroupEvent.mockImplementation(async () => error(502, 'Saving the event failed'));
		const adapter = createGroupAdapter(GROUP, viewer, refused);
		await expect(
			adapter.putRecord({ collection: 'community.lexicon.calendar.event', rkey: 'r', record: {} })
		).rejects.toMatchObject({ status: 502 });
		expect(refused).not.toHaveBeenCalled();
	});

	it('writes as the group', async () => {
		mocks.putGroupEvent.mockResolvedValue({ uri: 'at://u', cid: 'c' });
		const adapter = createGroupAdapter(GROUP, viewer);
		await adapter.putRecord({
			collection: 'community.lexicon.calendar.event',
			rkey: 'r',
			record: { name: 'Meet' }
		});
		expect(mocks.putGroupEvent).toHaveBeenCalledWith({
			groupDid: GROUP,
			rkey: 'r',
			record: { name: 'Meet' }
		});
	});

	it('writes a members-only event to where it is, with no image, listing or index', async () => {
		mocks.putGroupEvent.mockResolvedValue({ uri: 'at:space/u', cid: 'c' });
		const adapter = createGroupAdapter(GROUP, viewer, undefined, 'members');
		expect(adapter.features).toEqual({
			delete: true,
			recurring: false,
			images: false,
			visibility: false
		});
		expect(adapter.linkedRecords).toBeUndefined();
		const record = { collection: 'community.lexicon.calendar.event', rkey: 'r', record: {} };
		await adapter.putRecord(record);
		await adapter.createRecord(record);
		await adapter.deleteRecord(record);
		const sent = { groupDid: GROUP, rkey: 'r', placement: 'members' };
		expect(mocks.putGroupEvent.mock.calls).toEqual([
			[{ ...sent, record: {} }],
			[{ ...sent, record: {} }]
		]);
		expect(mocks.deleteGroupEvent).toHaveBeenCalledWith(sent);
		await expect(adapter.uploadBlob(new Blob([new Uint8Array([1])]))).rejects.toThrow();
		expect(mocks.uploadGroupBlob).not.toHaveBeenCalled();
	});
});
