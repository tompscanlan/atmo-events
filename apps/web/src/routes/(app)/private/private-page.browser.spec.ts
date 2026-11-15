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
	it('says the link is the invitation, since an unanswered invitation is never on the list', async () => {
		render(PrivatePage, { data: { ...base, canList: true, access: null } } as never);
		await expect.element(page.getByTestId('link-is-invitation')).toBeVisible();
	});

	it('points at Your events for private events apart from any calendar', async () => {
		render(PrivatePage, { data: { ...base, canList: true, access: null, beta: true } } as never);
		const pointer = page.getByTestId('single-events-pointer');
		await expect
			.element(pointer)
			.toHaveTextContent(
				"Private events that aren't on a shared calendar are listed in Your events, on the home page."
			);
		await expect
			.element(pointer.getByRole('link', { name: 'Your events' }))
			.toHaveAttribute('href', '/');
	});

	it('says they show there once private events are on, to someone who has them off', async () => {
		render(PrivatePage, { data: { ...base, canList: true, access: null, beta: false } } as never);
		await expect
			.element(page.getByTestId('single-events-pointer'))
			.toMatchTextContent(/on the home page, once private events are on\.$/);
	});

	it('says what a shared calendar is for where you make one', async () => {
		render(PrivatePage, {
			data: {
				...base,
				canList: true,
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
				'For a few people you invite to your own events. Only you add events or people. Everyone on it sees its name and who else is on it.'
			);
		expect(what.element().textContent ?? '').not.toMatch(/group/i);
	});
});
