import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'svelte/server';

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

afterEach(() => {
	editor.renders.length = 0;
	vi.resetAllMocks();
});

describe('/groups/[actor]/events/new', () => {
	// A server render has no DOM to click, so what each choice sends is tested on the adapter.
	it('asks who can see the event before it shows the editor', () => {
		const data = { groupDid: GROUP_DID, groupName: 'Kona', handle: null, rkey: '3lnewevent222' };
		const { body } = render(Page, { props: { data } as never });

		// No editor until a choice is made, so nothing can be saved by default.
		expect(editor.renders).toEqual([]);
		// Two answers, neither picked for the person, and neither locked yet.
		expect(body.match(/type="radio"/g)).toHaveLength(2);
		expect(body).not.toMatch(/\bchecked\b/);
		expect(body).not.toMatch(/\bdisabled\b/);
	});
});
