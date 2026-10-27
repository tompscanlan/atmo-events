import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'svelte/server';
import type { EditorAdapter } from '$lib/components/editor/adapter';

const editor = vi.hoisted(() => ({ renders: [] as Array<Record<string, unknown>> }));
const remote = vi.hoisted(() => ({
	putGroupEvent: vi.fn(),
	removeGroupEvent: vi.fn(),
	putGroupEventImage: vi.fn()
}));
vi.mock('@atmo-dev/events-ui', () => ({
	EventEditor: (_renderer: unknown, props: Record<string, unknown>) => {
		editor.renders.push(props);
	}
}));
vi.mock('$lib/atproto/auth.svelte', () => ({ user: { isLoggedIn: true } }));
vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
vi.mock('$app/paths', () => ({ resolve: (path: string) => path }));
vi.mock('$lib/atproto/methods', () => ({ getRecord: vi.fn(), resolveHandle: vi.fn() }));
vi.mock('$lib/components/LoginModal.svelte', () => ({
	atProtoLoginModalState: { show: vi.fn() }
}));
vi.mock('$lib/groups/group-events.remote', () => remote);

import Page from './+page.svelte';

const GROUP_DID = 'did:plc:jcwgw6fcnb5vyoid7nz7sl26';
const EVENT = 'community.lexicon.calendar.event';

afterEach(() => {
	editor.renders.length = 0;
	vi.resetAllMocks();
});

describe('/groups/[actor]/events/[rkey]/edit', () => {
	it('edits the event in the group repo: a save updates it and a delete removes it', async () => {
		const eventData = { name: 'Sunrise paddle', startsAt: '2030-11-01T06:00:00.000Z' };
		const data = {
			groupDid: GROUP_DID,
			groupName: 'Kona',
			handle: null,
			canDelete: true,
			rkey: '3lpaddle',
			eventData
		};
		const { body } = render(Page, { props: { data } as never });
		expect(body).not.toContain('/space/');

		expect(editor.renders).toHaveLength(1);
		const { adapter, eventData: given } = editor.renders[0] as {
			adapter: EditorAdapter;
			eventData: unknown;
		};
		expect(given).toStrictEqual(eventData);
		remote.putGroupEvent.mockResolvedValue({
			ok: true,
			uri: `at://${GROUP_DID}/${EVENT}/3lpaddle`
		});
		remote.removeGroupEvent.mockResolvedValue({ ok: true });
		await adapter.putRecord({ collection: EVENT, rkey: '3lpaddle', record: eventData });
		await adapter.deleteRecord({ collection: EVENT, rkey: '3lpaddle' });
		expect(remote.putGroupEvent.mock.calls[0][0]).toMatchObject({
			groupDid: GROUP_DID,
			rkey: '3lpaddle',
			intent: 'update'
		});
		expect(remote.removeGroupEvent.mock.calls).toEqual([
			[{ groupDid: GROUP_DID, rkey: '3lpaddle' }]
		]);
	});
});
