import { describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import '../../../app.css';
import PrivatePage from './+page.svelte';

// Making a calendar goes through a SvelteKit remote function, which a browser test has no server for.
vi.mock('#lib/private-events/private-events.remote', () => ({ createCalendar: vi.fn() }));

// As the load returns it: the calendars list is always there, empty or not.
const base = { pageTitle: 'Calendars', did: 'did:plc:person', spacesServer: null, calendars: [] };

describe('/private', () => {
	it('says the link is the invitation when there is nothing to list', async () => {
		render(PrivatePage, { data: { ...base, events: [], access: null } } as never);
		await expect.element(page.getByTestId('link-is-invitation')).toBeVisible();
	});

	it('says it under a list too, since an unanswered invitation is never on the list', async () => {
		const event = {
			name: 'A party',
			startsAt: '2030-01-01T18:00:00Z',
			did: 'did:plc:host',
			rkey: '3kabc',
			uri: 'at://did:plc:host/community.lexicon.calendar.event/3kabc',
			createdAt: '2029-01-01T00:00:00Z',
			rsvpsCount: 0,
			rsvpsGoingCount: 0
		};
		render(PrivatePage, {
			data: {
				...base,
				access: null,
				events: [{ event, href: '/p/x/private/3kabc', hosting: true, hostHandle: null }]
			}
		} as never);
		await expect.element(page.getByTestId('private-events')).toBeVisible();
		await expect.element(page.getByTestId('link-is-invitation')).toBeVisible();
	});

	it('says what a shared calendar is for where you make one', async () => {
		render(PrivatePage, {
			data: {
				...base,
				events: [],
				access: null,
				beta: true,
				calendars: [],
				calendarAccess: 'ready'
			}
		} as never);
		const what = page.getByTestId('new-calendar-what');
		await expect
			.element(what)
			.toHaveTextContent(
				'For a few people you invite to your own events. Only you add events or people.'
			);
		expect(what.element().textContent ?? '').not.toMatch(/group/i);
	});
});
