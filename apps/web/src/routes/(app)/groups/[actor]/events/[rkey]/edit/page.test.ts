// The edit page, rendered on the server with the shared editor stubbed, as on
// the new-event page (../../new/page.test.ts). The body is the page's own
// markup, and the adapter the editor would have saved with is called directly.
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
vi.mock('$lib/groups/groups.remote', () => remote);

import Page from './+page.svelte';

const GROUP_DID = 'did:plc:jcwgw6fcnb5vyoid7nz7sl26';
const EVENT = 'community.lexicon.calendar.event';

/** What a person reads: tags and Svelte's markers dropped, spaces collapsed. */
const textOf = (html: string) =>
	html
		.replace(/<[^>]*>/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();

afterEach(() => {
	editor.renders.length = 0;
	vi.resetAllMocks();
});

describe('/groups/[actor]/events/[rkey]/edit', () => {
	it('the edit page shows who can see the event and offers no way to change it', async () => {
		const eventData = { name: 'Sunrise paddle', startsAt: '2026-11-01T06:00:00.000Z' };
		const { body } = render(Page, {
			props: {
				data: {
					groupDid: GROUP_DID,
					groupName: 'Kona',
					handle: null,
					canDelete: true,
					rkey: '3lpaddle',
					eventData
				}
			} as never
		});
		const text = textOf(body);

		expect(text).toContain('Who can see this event: Everyone');
		expect(text).toContain("This can't be changed after the event is published.");
		// No control of the page's own (the editor's markup is stubbed out), and
		// no space named.
		expect(body).not.toMatch(/<(input|select|button|textarea)\b/);
		expect(body).not.toContain('/space/');
		expect(text).not.toMatch(/\bprivate\b/i);

		// The editor saves where the line says: the group's public repo.
		expect(editor.renders).toHaveLength(1);
		const { adapter } = editor.renders[0] as { adapter: EditorAdapter };
		expect(adapter.features.recurring).toBe(true);
		remote.putGroupEvent.mockResolvedValue({
			ok: true,
			uri: `at://${GROUP_DID}/${EVENT}/3lpaddle`
		});
		remote.removeGroupEvent.mockResolvedValue({ ok: true });
		await adapter.putRecord({ collection: EVENT, rkey: '3lpaddle', record: eventData });
		await adapter.deleteRecord({ collection: EVENT, rkey: '3lpaddle' });
		expect(remote.putGroupEvent.mock.calls).toEqual([
			[{ groupDid: GROUP_DID, rkey: '3lpaddle', intent: 'update', space: null, record: eventData }]
		]);
		expect(remote.removeGroupEvent.mock.calls).toEqual([
			[{ groupDid: GROUP_DID, rkey: '3lpaddle', space: null }]
		]);
	});
});
