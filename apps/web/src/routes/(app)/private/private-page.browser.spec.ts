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
	it('says in one line when a calendar shows, and that events apart from one are in Your events', async () => {
		render(PrivatePage, { data: { ...base, canList: true, access: null, beta: true } } as never);
		const footnote = page.getByTestId('calendars-footnote');
		await expect
			.element(footnote)
			.toHaveTextContent(
				"A calendar you're on shows here once you answer one of its events. Private events not on a calendar are in Your events."
			);
		await expect
			.element(footnote.getByRole('link', { name: 'Your events' }))
			.toHaveAttribute('href', '/');
	});

	it('says they show there once private events are on, to someone who has them off', async () => {
		render(PrivatePage, { data: { ...base, canList: true, access: null, beta: false } } as never);
		await expect
			.element(page.getByTestId('calendars-footnote'))
			.toMatchTextContent(/are in Your events once private events are on\.$/);
	});

	it('lists each calendar with whose it is, marked private for a screen reader', async () => {
		render(PrivatePage, {
			data: {
				...base,
				canList: true,
				access: null,
				beta: false,
				calendars: [
					{ href: 'a', key: 'k1', name: 'Supper club', owning: true, host: 'did:plc:person' },
					{
						href: 'b',
						key: 'k2',
						name: 'Book club',
						owning: false,
						host: 'did:plc:ivo',
						ownerHandle: 'ivo.example.com'
					}
				]
			}
		} as never);
		const list = page.getByTestId('calendar-list');
		await expect
			.element(list)
			.toHaveTextContent('Private: Supper club yours Private: Book club ivo.example.com');
		expect(list.element().textContent ?? '').not.toMatch(/Only the people on it/);
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
