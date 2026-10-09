// The new-event page, rendered on the server as a first visit gets it. The
// shared editor is stubbed, so the body holds the page's own markup and each
// render of the editor is counted; the UI package goes whole, since its runtime
// imports pull in plyr's CSS, which Node's ESM loader rejects. A server render
// has no DOM to click, so what each choice sends is tested on the placement
// module and the adapter.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'svelte/server';

const editor = vi.hoisted(() => ({ renders: [] as Array<Record<string, unknown>> }));
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
vi.mock('$lib/groups/group-events.remote', () => ({
	putGroupEvent: vi.fn(),
	removeGroupEvent: vi.fn(),
	putGroupEventImage: vi.fn()
}));

import Page from './+page.svelte';

const GROUP_DID = 'did:plc:jcwgw6fcnb5vyoid7nz7sl26';
const CALENDAR = `at://${GROUP_DID}/space/rsvp.atmo.group.calendar/self`;

/** What a person reads: tags and Svelte's markers dropped, spaces collapsed. */
const textOf = (html: string) =>
	html
		.replace(/<[^>]*>/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();

afterEach(() => {
	editor.renders.length = 0;
});

describe('/groups/[actor]/events/new', () => {
	it('the new-event page asks who can see the event before it shows the editor', () => {
		const { head, body } = render(Page, {
			props: {
				data: {
					groupDid: GROUP_DID,
					groupName: 'Kona',
					handle: null,
					rkey: '3lnewevent222',
					calendarSpaceUri: CALENDAR
				}
			} as never
		});
		const text = textOf(body);

		expect(head).toContain('New event for Kona');
		expect(editor.renders).toEqual([]);
		expect(text).toContain('Who can see this event');
		expect(text).toContain('Everyone Anyone can see it, including people outside the group.');
		expect(text).toContain(
			"Members only Only the group's members can see it. It can't be switched to Everyone later. For now it has no recurring copies and its image isn't shown. The Public / Unlisted setting below doesn't apply."
		);
		// Two answers, neither picked for the person, and neither locked yet.
		expect(body.match(/type="radio"/g)).toHaveLength(2);
		expect(body).not.toMatch(/\bchecked\b/);
		expect(body).not.toMatch(/\bdisabled\b/);
		expect(text).not.toMatch(/\bprivate\b/i);
		// Each answer is described by its own help line, apart from its label.
		const described = [...body.matchAll(/aria-describedby="([^"]+)"/g)].map(([, id]) =>
			textOf(
				body
					.slice(body.indexOf(`id="${id}"`))
					.split('</p>')[0]
					.replace(/^[^>]*>/, '')
			)
		);
		expect(described).toEqual([
			'Anyone can see it, including people outside the group.',
			"Only the group's members can see it. It can't be switched to Everyone later. For now it has no recurring copies and its image isn't shown. The Public / Unlisted setting below doesn't apply."
		]);
	});
});
