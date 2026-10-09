// The group editor adapter, called as the shared editor calls it. The group's
// commands are stubbed at their module boundary, along with the SvelteKit and
// login imports the adapter only passes through: what is under test is what it
// sends the commands for each placement, what it does with a refusal, and when
// it tells the page a save is over.
import { afterEach, describe, expect, it, vi } from 'vitest';

const remote = vi.hoisted(() => ({
	putGroupEvent: vi.fn(),
	removeGroupEvent: vi.fn(),
	putGroupEventImage: vi.fn()
}));
vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
vi.mock('$app/paths', () => ({ resolve: (path: string) => path }));
const methods = vi.hoisted(() => ({ getRecord: vi.fn(), resolveHandle: vi.fn() }));
vi.mock('$lib/atproto/methods', () => methods);
vi.mock('$lib/components/LoginModal.svelte', () => ({
	atProtoLoginModalState: { show: vi.fn() }
}));
vi.mock('./group-events.remote', () => remote);

import { createGroupEditorAdapter } from './editor-adapter';

import { type EventPlacement } from './event-placement';
const GROUP_DID = 'did:plc:jcwgw6fcnb5vyoid7nz7sl26';
const EVENT = 'community.lexicon.calendar.event';
const BLOB_REF = {
	$type: 'blob',
	ref: { $link: 'bafkreiimage' },
	mimeType: 'image/png',
	size: 3
};
/** Unit A's refusal for a group made before the calendar space, word for word. */
const NO_CALENDAR_SPACE =
	'This group has no calendar space for members-only events, because it was made before they existed. Re-create the group to post members-only events. Nothing was saved.';

const record = (name: string) => ({ $type: EVENT, name, startsAt: '2026-11-01T18:00:00.000Z' });

/** The adapter the new-event page (no rkey) or the edit page (its rkey) builds. */
function adapterFor(placement: EventPlacement, editingRkey: string | null = null) {
	const onRefusal = vi.fn();
	const onSaveEnd = vi.fn();
	const adapter = createGroupEditorAdapter({
		groupDid: GROUP_DID,
		editingRkey,
		canDelete: true,
		placement,
		onRefusal,
		onSaveEnd
	});
	return { adapter, onRefusal, onSaveEnd };
}

function succeed() {
	remote.putGroupEvent.mockImplementation(async ({ rkey }: { rkey: string }) => ({
		ok: true,
		uri: `at://${GROUP_DID}/${EVENT}/${rkey}`
	}));
	remote.removeGroupEvent.mockResolvedValue({ ok: true });
	remote.putGroupEventImage.mockResolvedValue({ ok: true, blob: BLOB_REF });
}

/** A save from each page, as the editor makes it: a create from the new-event
 *  page; then, on the edit page, the event's own update, a write to another
 *  rkey (what a recurring copy is), and the delete. */
async function saveAndDelete(placement: EventPlacement) {
	await adapterFor(placement).adapter.putRecord({
		collection: EVENT,
		rkey: '3new',
		record: record('A')
	});
	const { adapter } = adapterFor(placement, '3edit');
	await adapter.putRecord({ collection: EVENT, rkey: '3edit', record: record('B') });
	await adapter.putRecord({ collection: EVENT, rkey: '3copy', record: record('C') });
	await adapter.deleteRecord({ collection: EVENT, rkey: '3edit' });
}

afterEach(() => {
	vi.resetAllMocks();
});

describe('the group editor adapter: recurring copies', () => {
	it('a members-only event offers no recurring copies', () => {
		expect(adapterFor('members').adapter.features).toEqual({
			delete: true,
			recurring: false,
			privateMode: false
		});
		expect(adapterFor('members', '3edit').adapter.features.recurring).toBe(false);
	});

	it('a public event keeps its recurring copies', () => {
		expect(adapterFor('everyone').adapter.features).toEqual({
			delete: true,
			recurring: true,
			privateMode: false
		});
		expect(adapterFor('everyone', '3edit').adapter.features.recurring).toBe(true);
	});
});

describe('the group editor adapter: placement on every write', () => {
	it('a members-only save sends its placement on every write and delete', async () => {
		succeed();
		await saveAndDelete('members');

		expect(remote.putGroupEvent.mock.calls).toEqual([
			[
				{
					groupDid: GROUP_DID,
					rkey: '3new',
					intent: 'create',
					placement: 'members',
					record: record('A')
				}
			],
			[
				{
					groupDid: GROUP_DID,
					rkey: '3edit',
					intent: 'update',
					placement: 'members',
					record: record('B')
				}
			],
			[
				{
					groupDid: GROUP_DID,
					rkey: '3copy',
					intent: 'create',
					placement: 'members',
					record: record('C')
				}
			]
		]);
		expect(remote.removeGroupEvent.mock.calls).toEqual([
			[{ groupDid: GROUP_DID, rkey: '3edit', placement: 'members' }]
		]);
	});

	it('a public save sends its placement too, on every write and delete', async () => {
		succeed();
		await saveAndDelete('everyone');

		expect(remote.putGroupEvent.mock.calls).toEqual([
			[
				{
					groupDid: GROUP_DID,
					rkey: '3new',
					intent: 'create',
					placement: 'everyone',
					record: record('A')
				}
			],
			[
				{
					groupDid: GROUP_DID,
					rkey: '3edit',
					intent: 'update',
					placement: 'everyone',
					record: record('B')
				}
			],
			[
				{
					groupDid: GROUP_DID,
					rkey: '3copy',
					intent: 'create',
					placement: 'everyone',
					record: record('C')
				}
			]
		]);
		expect(remote.removeGroupEvent.mock.calls).toEqual([
			[{ groupDid: GROUP_DID, rkey: '3edit', placement: 'everyone' }]
		]);
	});

	// The image goes into the group's repo either way, and only the event record
	// that cites it decides who can reach it.
	it('the image upload is the same for either placement', async () => {
		succeed();
		const upload = async (placement: EventPlacement, editingRkey: string | null) =>
			adapterFor(placement, editingRkey).adapter.uploadBlob(
				new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' })
			);

		for (const editingRkey of [null, '3edit']) {
			remote.putGroupEventImage.mockClear();
			expect(await upload('everyone', editingRkey)).toEqual(BLOB_REF);
			expect(await upload('members', editingRkey)).toEqual(BLOB_REF);

			const [[asPublic], [asMembersOnly]] = remote.putGroupEventImage.mock.calls;
			expect(asPublic).toEqual({
				groupDid: GROUP_DID,
				intent: editingRkey ? 'update' : 'create',
				bytes: [1, 2, 3],
				mimeType: 'image/png'
			});
			expect(asMembersOnly).toEqual(asPublic);
		}
	});
});

describe('the group editor adapter: refusals', () => {
	it("a refusal from the group's commands reaches the page as its own message", async () => {
		remote.putGroupEvent.mockResolvedValue({ ok: false, error: NO_CALENDAR_SPACE });
		remote.removeGroupEvent.mockResolvedValue({ ok: false, error: 'Delete refused.' });
		remote.putGroupEventImage.mockResolvedValue({ ok: false, error: 'Upload refused.' });
		const { adapter, onRefusal } = adapterFor('members', '3edit');

		// Each still throws, so the editor stops and shows its own line too.
		await expect(
			adapter.putRecord({ collection: EVENT, rkey: '3edit', record: record('B') })
		).rejects.toThrow(NO_CALENDAR_SPACE);
		expect(onRefusal.mock.calls).toEqual([[NO_CALENDAR_SPACE]]);

		await expect(adapter.deleteRecord({ collection: EVENT, rkey: '3edit' })).rejects.toThrow(
			'Delete refused.'
		);
		await expect(adapter.uploadBlob(new Blob([new Uint8Array([1])]))).rejects.toThrow(
			'Upload refused.'
		);
		expect(onRefusal.mock.calls).toEqual([
			[NO_CALENDAR_SPACE],
			['Delete refused.'],
			['Upload refused.']
		]);
	});

	// Only a refusal carries words meant for the person. A failed request's
	// error is left to the editor's own line.
	it('a save that succeeds, or fails without a refusal, shows no refusal', async () => {
		succeed();
		const { adapter, onRefusal } = adapterFor('members');
		await adapter.putRecord({ collection: EVENT, rkey: '3new', record: record('A') });
		remote.putGroupEvent.mockRejectedValueOnce(new Error('fetch failed'));
		await expect(
			adapter.putRecord({ collection: EVENT, rkey: '3new', record: record('A') })
		).rejects.toThrow('fetch failed');
		expect(onRefusal).not.toHaveBeenCalled();
	});
});

// The new-event page locks its choice from Publish until the save is over, so
// the adapter has to say when that is. The editor's save ends at the write, or
// earlier when the image upload before it fails.
describe('the group editor adapter: the end of a save', () => {
	const image = () => new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });

	it('a save ends when its write succeeds, is refused or fails', async () => {
		succeed();
		const { adapter, onSaveEnd } = adapterFor('members');
		await adapter.putRecord({ collection: EVENT, rkey: '3new', record: record('A') });
		expect(onSaveEnd.mock.calls).toEqual([[true]]);

		remote.putGroupEvent.mockResolvedValueOnce({ ok: false, error: NO_CALENDAR_SPACE });
		await expect(
			adapter.putRecord({ collection: EVENT, rkey: '3new', record: record('A') })
		).rejects.toThrow(NO_CALENDAR_SPACE);
		remote.putGroupEvent.mockRejectedValueOnce(new Error('fetch failed'));
		await expect(
			adapter.putRecord({ collection: EVENT, rkey: '3new', record: record('A') })
		).rejects.toThrow('fetch failed');
		expect(onSaveEnd.mock.calls).toEqual([[true], [false], [false]]);
	});

	it('a failed image upload ends the save, and one that succeeds does not', async () => {
		succeed();
		const { adapter, onSaveEnd } = adapterFor('members');
		expect(await adapter.uploadBlob(image())).toEqual(BLOB_REF);
		expect(onSaveEnd).not.toHaveBeenCalled();

		remote.putGroupEventImage.mockResolvedValueOnce({ ok: false, error: 'Upload refused.' });
		await expect(adapter.uploadBlob(image())).rejects.toThrow('Upload refused.');
		remote.putGroupEventImage.mockRejectedValueOnce(new Error('fetch failed'));
		await expect(adapter.uploadBlob(image())).rejects.toThrow('fetch failed');
		expect(onSaveEnd.mock.calls).toEqual([[false], [false]]);
	});

	// The editor drops a mention it can't resolve and goes on to the write, so
	// ending the save there would unlock the choice before the write is sent.
	it("a mention that can't be resolved does not end the save", async () => {
		methods.resolveHandle.mockRejectedValue(new Error('handle not found'));
		const { adapter, onSaveEnd } = adapterFor('members');
		await expect(adapter.resolveHandle('nobody.example.com')).rejects.toThrow('handle not found');
		expect(onSaveEnd).not.toHaveBeenCalled();
	});
});
