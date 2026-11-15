import { afterEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import { page as appPage } from '$app/state';
import { BETA_WARNING_SHORT } from '#lib/private-events/beta.js';
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

/** Whether `later` comes after `earlier` on the page. */
function follows(earlier: Element, later: Element): boolean {
	return (earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

afterEach(() => {
	for (const mock of Object.values(mocks)) mock.mockClear();
});

describe('a shared calendar’s page', () => {
	it('tells someone on it in one line that it is private, and whose it is', async () => {
		render(CalendarPage, { data: view(false) } as never);
		await expect.element(page.getByRole('heading', { name: 'Supper club' })).toBeVisible();
		await expect.poll(() => shownText('calendar-private-note')).toBe('Private · owner.example.com');
		await expect
			.element(page.getByTestId('calendar-owner').getByRole('link', { name: 'owner.example.com' }))
			.toHaveAttribute('href', '/p/owner.example.com');
		await expect.element(page.getByText('Dinner at eight').first()).toBeVisible();
	});

	it('ends with the short beta note', async () => {
		render(CalendarPage, { data: view(true) } as never);
		await expect.poll(() => shownText('beta-notice')).toBe(BETA_WARNING_SHORT);
		const [people] = page.getByTestId('calendar-people').elements();
		const [beta] = page.getByTestId('beta-notice').elements();
		expect(follows(people, beta)).toBe(true);
	});

	it('gives someone on it nothing to change', async () => {
		render(CalendarPage, { data: view(false) } as never);
		await expect.element(page.getByTestId('calendar-private-note')).toBeVisible();
		expect(page.getByTestId('calendar-owner-actions').elements()).toHaveLength(0);
		expect(page.getByTestId('calendar-people').elements()).toHaveLength(0);
		expect(page.getByRole('button', { name: 'Rename' }).elements()).toHaveLength(0);
		expect(page.getByRole('button', { name: 'Delete', exact: true }).elements()).toHaveLength(0);
		expect(page.getByRole('link', { name: 'New event', exact: true }).elements()).toHaveLength(0);
	});

	it('shows someone on it who else is on it, with nothing to change', async () => {
		const people = [
			{ did: PERSON, handle: 'person.example.com' },
			{ did: 'did:plc:otherotherotherotherothe', handle: null }
		];
		render(CalendarPage, { data: view(false, people) } as never);
		await expect.poll(() => shownText('calendar-people-shown')).toContain('People (2)');
		expect(shownText('calendar-people-shown')).toContain('person.example.com');
		expect(shownText('calendar-people-shown')).toContain('did:plc:otherotherotherotherothe');
		expect(shownText('calendar-people-shown')).toContain(
			"Everyone here sees every event and each other. Only the owner changes who's here."
		);
		expect(page.getByTestId('calendar-people').elements()).toHaveLength(0);
		expect(page.getByRole('button', { name: 'Remove' }).elements()).toHaveLength(0);
		expect(page.getByRole('textbox').elements()).toHaveLength(0);
	});

	it('tells the owner that the people they add see each other', async () => {
		render(CalendarPage, { data: view(true) } as never);
		await expect
			.poll(() => shownText('calendar-people'))
			.toContain('People here see every event, past and future, and each other. Nobody else can.');
	});

	it('tells the owner it is theirs, and lets them add someone by handle', async () => {
		render(CalendarPage, { data: view(true) } as never);
		await expect.poll(() => shownText('calendar-private-note')).toBe('Private · yours');
		await expect.element(page.getByText('person.example.com')).toBeVisible();
		await page
			.getByRole('textbox', { name: 'Handle of the person to add' })
			.fill('dana.example.com');
		await page.getByRole('button', { name: 'Add', exact: true }).click();
		await expect
			.poll(() => mocks.addPersonToCalendar)
			.toHaveBeenCalledWith({ key: KEY, handleOrDid: 'dana.example.com' });
	});

	it('lists the owner’s people first, then the form to add one, then the link to send', async () => {
		render(CalendarPage, { data: view(true) } as never);
		await expect.poll(() => shownText('calendar-people')).toContain('People (1)');
		const [person] = page.getByText('person.example.com').elements();
		const [field] = page.getByRole('textbox', { name: 'Handle of the person to add' }).elements();
		const [send] = page
			.getByText("atmo doesn't notify people you add. Send them the link.")
			.elements();
		expect(follows(person, field)).toBe(true);
		expect(follows(field, send)).toBe(true);
	});

	it('copies the calendar’s link for the owner to send', async () => {
		const was = appPage.url;
		appPage.url = new URL(`https://atmo.rsvp/p/owner.example.com/calendar/${KEY}?from=list`);
		const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
		try {
			render(CalendarPage, { data: view(true) } as never);
			await page.getByRole('button', { name: 'Copy link' }).click();
			await expect
				.poll(() => writeText)
				.toHaveBeenCalledWith(`https://atmo.rsvp/p/owner.example.com/calendar/${KEY}`);
			await expect.element(page.getByRole('button', { name: 'Link copied' })).toBeVisible();
		} finally {
			writeText.mockRestore();
			appPage.url = was;
		}
	});

	it('starts the owner’s new event on this calendar', async () => {
		render(CalendarPage, { data: view(true) } as never);
		await expect
			.element(page.getByRole('link', { name: 'New event', exact: true }))
			.toHaveAttribute('href', `/create?audience=calendar&calendar=${KEY}`);
	});

	it('asks the owner before it deletes the calendar for everyone', async () => {
		render(CalendarPage, { data: view(true) } as never);
		await page.getByRole('button', { name: 'Delete', exact: true }).click();
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
