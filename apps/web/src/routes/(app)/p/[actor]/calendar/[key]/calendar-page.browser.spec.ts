import { afterEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import '../../../../../../app.css';
import CalendarPage from './+page.svelte';

const { OWNER, PERSON, KEY, mocks } = vi.hoisted(() => ({
	OWNER: 'did:plc:ownerownerownerownerowner',
	PERSON: 'did:plc:personpersonpersonperson',
	KEY: 'cal-3lcalcalcalcal',
	mocks: {
		addPersonToCalendar: vi.fn(async () => ({})),
		removePersonFromCalendar: vi.fn(async () => {}),
		renameCalendar: vi.fn(async () => {}),
		deleteCalendar: vi.fn(async () => {})
	}
}));
// The page's writes go through SvelteKit remote functions, which a browser test has no server for.
vi.mock('#lib/private-events/private-events.remote.js', () => mocks);
vi.mock('#lib/private-events/private-events.remote', () => mocks);

const EVENT = {
	name: 'Dinner at eight',
	startsAt: '2099-01-01T18:00:00Z',
	createdAt: '2029-01-01T00:00:00Z',
	did: OWNER,
	rkey: '3kabc',
	uri: `at://${OWNER}/space/rsvp.atmo.dev.space/${KEY}/${OWNER}/community.lexicon.calendar.event/3kabc`,
	cid: 'cid'
};

/** The page's data, as its load returns it, for the owner or someone on it. */
function view(
	isOwner: boolean,
	people: { did: string; handle: string | null }[] | null = isOwner
		? [{ did: PERSON, handle: 'person.example.com' }]
		: null
) {
	return {
		pageTitle: 'Supper club',
		robots: 'noindex',
		view: 'calendar',
		isOwner,
		actor: 'owner.example.com',
		calendar: {
			key: KEY,
			host: OWNER,
			name: 'Supper club',
			ownerHandle: 'owner.example.com',
			upcoming: [EVENT],
			past: [],
			eventsCapped: false,
			people,
			peopleCapped: false
		}
	};
}

/** The text a person reads, with the template's line breaks and indents collapsed. */
function shownText(testId: string): string {
	const found = page.getByTestId(testId).elements()[0];
	return (found?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

afterEach(() => {
	for (const mock of Object.values(mocks)) mock.mockClear();
});

describe('a shared calendar’s page', () => {
	it('tells someone on it that only the people on it can see its events', async () => {
		render(CalendarPage, { data: view(false) } as never);
		await expect.element(page.getByRole('heading', { name: 'Supper club' })).toBeVisible();
		await expect
			.element(page.getByTestId('calendar-private-note'))
			.toHaveTextContent('Private. Only the people on this calendar can see its events.');
		await expect.element(page.getByText('Dinner at eight').first()).toBeVisible();
	});

	it('gives someone on it nothing to change', async () => {
		render(CalendarPage, { data: view(false) } as never);
		await expect.element(page.getByTestId('calendar-private-note')).toBeVisible();
		expect(page.getByTestId('calendar-people').elements()).toHaveLength(0);
		expect(page.getByRole('button', { name: 'Rename' }).elements()).toHaveLength(0);
		expect(page.getByRole('button', { name: 'Delete calendar' }).elements()).toHaveLength(0);
		expect(page.getByRole('link', { name: 'New event on this calendar' }).elements()).toHaveLength(
			0
		);
	});

	it('shows someone on it who else is on it, with nothing to change', async () => {
		const people = [
			{ did: PERSON, handle: 'person.example.com' },
			{ did: 'did:plc:otherotherotherotherothe', handle: null }
		];
		render(CalendarPage, { data: view(false, people) } as never);
		await expect.poll(() => shownText('calendar-people-shown')).toContain('person.example.com');
		expect(shownText('calendar-people-shown')).toContain('did:plc:otherotherotherotherothe');
		expect(page.getByTestId('calendar-people').elements()).toHaveLength(0);
		expect(page.getByRole('button', { name: 'Remove' }).elements()).toHaveLength(0);
		expect(page.getByRole('textbox').elements()).toHaveLength(0);
	});

	it('tells the owner that the people they add see each other', async () => {
		render(CalendarPage, { data: view(true) } as never);
		await expect
			.poll(() => shownText('calendar-people'))
			.toContain('past and future, and who else is on it. Nobody else can.');
	});

	it('tells the owner the same, and lets them add someone by handle', async () => {
		render(CalendarPage, { data: view(true) } as never);
		await expect
			.element(page.getByTestId('calendar-private-note'))
			.toHaveTextContent('Private. Only the people on this calendar can see its events.');
		await expect.element(page.getByText('person.example.com')).toBeVisible();
		await page
			.getByRole('textbox', { name: 'Handle of the person to add' })
			.fill('dana.example.com');
		await page.getByRole('button', { name: 'Add', exact: true }).click();
		await expect
			.poll(() => mocks.addPersonToCalendar)
			.toHaveBeenCalledWith({ key: KEY, handleOrDid: 'dana.example.com' });
	});

	it('starts the owner’s new event on this calendar', async () => {
		render(CalendarPage, { data: view(true) } as never);
		await expect
			.element(page.getByRole('link', { name: 'New event on this calendar' }))
			.toHaveAttribute('href', `/create?audience=calendar&calendar=${KEY}`);
	});

	it('asks the owner before it deletes the calendar for everyone', async () => {
		render(CalendarPage, { data: view(true) } as never);
		await page.getByRole('button', { name: 'Delete calendar' }).click();
		await expect.element(page.getByTestId('confirm-delete')).toBeVisible();
		expect(mocks.deleteCalendar).not.toHaveBeenCalled();
		await page.getByRole('button', { name: 'Delete it for everyone' }).click();
		await expect.poll(() => mocks.deleteCalendar).toHaveBeenCalledWith({ key: KEY });
	});

	it('renames it', async () => {
		render(CalendarPage, { data: view(true) } as never);
		await page.getByRole('button', { name: 'Rename' }).click();
		await page.getByRole('textbox', { name: /calendar.s name/ }).fill('Brunch club');
		await page.getByRole('button', { name: 'Save' }).click();
		await expect
			.poll(() => mocks.renameCalendar)
			.toHaveBeenCalledWith({ key: KEY, name: 'Brunch club' });
	});
});
