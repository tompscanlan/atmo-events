import { afterEach, describe, expect, it, vi } from 'vitest';

const remote = vi.hoisted(() => ({
	putGroupEvent: vi.fn(),
	removeGroupEvent: vi.fn(),
	putGroupEventImage: vi.fn()
}));
vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
vi.mock('$app/paths', () => ({ resolve: (path: string) => path }));
vi.mock('$lib/atproto/methods', () => ({ resolveHandle: vi.fn() }));
vi.mock('$lib/components/LoginModal.svelte', () => ({
	atProtoLoginModalState: { show: vi.fn() }
}));
vi.mock('./group-events.remote', () => remote);

import { createGroupEditorAdapter } from './editor-adapter';

const GROUP_DID = 'did:plc:jcwgw6fcnb5vyoid7nz7sl26';
const EVENT = 'community.lexicon.calendar.event';
const BLOB_REF = { $type: 'blob', ref: { $link: 'bafkreiimage' }, mimeType: 'image/png', size: 3 };
const record = (name: string) => ({ $type: EVENT, name, startsAt: '2026-11-01T18:00:00.000Z' });

function adapterFor(editingRkey: string | null = null) {
	const onRefusal = vi.fn();
	const adapter = createGroupEditorAdapter({
		groupDid: GROUP_DID,
		editingRkey,
		canDelete: true,
		onRefusal
	});
	return { adapter, onRefusal };
}

afterEach(() => {
	vi.resetAllMocks();
});

describe('the group editor adapter', () => {
	it('creates from the new-event page, updates only the event being edited, and deletes it', async () => {
		remote.putGroupEvent.mockImplementation(async ({ rkey }: { rkey: string }) => ({
			ok: true,
			uri: `at://${GROUP_DID}/${EVENT}/${rkey}`
		}));
		remote.removeGroupEvent.mockResolvedValue({ ok: true });

		await adapterFor().adapter.putRecord({ collection: EVENT, rkey: '3new', record: record('A') });
		const { adapter } = adapterFor('3edit');
		await adapter.putRecord({ collection: EVENT, rkey: '3edit', record: record('B') });
		await adapter.putRecord({ collection: EVENT, rkey: '3copy', record: record('C') });
		await adapter.deleteRecord({ collection: EVENT, rkey: '3edit' });

		expect(remote.putGroupEvent.mock.calls.map(([call]) => [call.rkey, call.intent])).toEqual([
			['3new', 'create'],
			['3edit', 'update'],
			['3copy', 'create']
		]);
		expect(remote.removeGroupEvent.mock.calls).toEqual([[{ groupDid: GROUP_DID, rkey: '3edit' }]]);
		expect(adapter.features).toEqual({ delete: true, recurring: true, privateMode: false });
	});

	it('uploads an image as bytes, for the intent of its page', async () => {
		remote.putGroupEventImage.mockResolvedValue({ ok: true, blob: BLOB_REF });
		const image = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });

		expect(await adapterFor('3edit').adapter.uploadBlob(image)).toEqual(BLOB_REF);
		expect(remote.putGroupEventImage.mock.calls).toEqual([
			[{ groupDid: GROUP_DID, intent: 'update', bytes: [1, 2, 3], mimeType: 'image/png' }]
		]);
	});

	it('hands each refusal to the page, and still throws so the editor stops', async () => {
		remote.putGroupEvent.mockResolvedValue({ ok: false, error: 'put refused' });
		remote.removeGroupEvent.mockResolvedValue({ ok: false, error: 'delete refused' });
		remote.putGroupEventImage.mockResolvedValue({ ok: false, error: 'upload refused' });
		const { adapter, onRefusal } = adapterFor('3edit');

		await expect(
			adapter.putRecord({ collection: EVENT, rkey: '3edit', record: record('B') })
		).rejects.toThrow();
		await expect(adapter.deleteRecord({ collection: EVENT, rkey: '3edit' })).rejects.toThrow();
		await expect(adapter.uploadBlob(new Blob([new Uint8Array([1])]))).rejects.toThrow();
		expect(onRefusal.mock.calls).toEqual([['put refused'], ['delete refused'], ['upload refused']]);
	});
});
