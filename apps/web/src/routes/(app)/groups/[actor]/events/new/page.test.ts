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

describe('/groups/[actor]/events/new', () => {
	it('opens the editor as the group, and its save creates the event', async () => {
		const data = { groupDid: GROUP_DID, groupName: 'Kona', handle: null, rkey: '3lnewevent222' };
		const { body } = render(Page, { props: { data } as never });
		expect(body).not.toMatch(/type="radio"/);

		expect(editor.renders).toHaveLength(1);
		const props = editor.renders[0] as {
			adapter: EditorAdapter;
			eventData: unknown;
			actorDid: string;
			viewer: { did: string };
		};
		expect(props).toMatchObject({ eventData: null, actorDid: GROUP_DID });
		expect(props.viewer.did).toBe(GROUP_DID);

		remote.putGroupEvent.mockResolvedValue({ ok: true, uri: `at://${GROUP_DID}/${EVENT}/x` });
		await props.adapter.putRecord({ collection: EVENT, rkey: '3lnewevent222', record: {} });
		expect(remote.putGroupEvent.mock.calls[0][0]).toMatchObject({
			groupDid: GROUP_DID,
			rkey: '3lnewevent222',
			intent: 'create'
		});
	});
});
