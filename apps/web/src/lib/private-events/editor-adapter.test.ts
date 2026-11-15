import { beforeEach, describe, expect, it, vi } from 'vitest';

const savePrivateEvent = vi.fn(async () => ({ uri: 'at://x', cid: 'c' }));
vi.mock('./private-events.remote', () => ({ savePrivateEvent, cancelPrivateEvent: vi.fn() }));
vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
vi.mock('$app/paths', () => ({ resolve: (path: string) => path }));
vi.mock('#lib/components/editor/adapter.js', () => ({
	createInAppAdapter: () => ({}),
	handleOrDid: () => 'host.example.com'
}));

const { createPrivateEventAdapter } = await import('./editor-adapter');
const viewer = { isLoggedIn: true, canPostToBluesky: false, did: 'did:plc:host' };
const save = { collection: 'community.lexicon.calendar.event', rkey: '3lnew', record: {} };

beforeEach(() => savePrivateEvent.mockClear());

describe('the name a new private event’s guests get', () => {
	it('goes with the save the editor makes, read when it saves', async () => {
		let name = '';
		const adapter = createPrivateEventAdapter(viewer, undefined, { name: () => name });
		name = '  Supper club ';
		await adapter.putRecord(save as never);
		expect(savePrivateEvent).toHaveBeenCalledWith({
			rkey: '3lnew',
			record: {},
			name: 'Supper club'
		});
	});

	it('is left out when blank, so the event is made as before', async () => {
		const adapter = createPrivateEventAdapter(viewer, undefined, { name: () => '   ' });
		await adapter.putRecord(save as never);
		expect(savePrivateEvent).toHaveBeenCalledWith({ rkey: '3lnew', record: {} });
	});

	it('is never sent with an event on a calendar, which has its calendar’s name', async () => {
		const adapter = createPrivateEventAdapter(viewer, 'cal-3l', { name: () => 'Supper club' });
		await adapter.putRecord(save as never);
		expect(savePrivateEvent).toHaveBeenCalledWith({
			rkey: '3lnew',
			record: {},
			calendar: 'cal-3l'
		});
	});
});
