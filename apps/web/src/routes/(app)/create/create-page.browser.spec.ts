import { afterEach, describe, expect, it, vi } from 'vitest';
import { page, type Locator } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import { page as appPage } from '$app/state';
import '../../../app.css';
import CreatePage from './+page.svelte';

const { mocks } = vi.hoisted(() => ({
	mocks: {
		savePrivateEvent: vi.fn(async () => ({ uri: 'at://x', cid: 'cid' })),
		putRecord: vi.fn(async () => ({ uri: 'at://x', cid: 'cid' })),
		user: {
			isLoggedIn: true,
			did: 'did:plc:hosthosthosthosthosthost',
			canPostToBluesky: false,
			profile: { handle: 'host.example.com' }
		}
	}
}));
// The page's writes go through SvelteKit remote functions, which a browser test has no server for.
vi.mock('#lib/private-events/private-events.remote', () => ({
	savePrivateEvent: mocks.savePrivateEvent,
	cancelPrivateEvent: vi.fn()
}));
vi.mock('#lib/atproto/repo.remote.js', () => ({
	putRecord: mocks.putRecord,
	createRecord: vi.fn(),
	deleteRecord: vi.fn(),
	uploadBlob: vi.fn()
}));
vi.mock('#lib/atproto/auth.svelte.js', () => ({
	user: mocks.user,
	login: vi.fn(),
	logout: vi.fn(),
	signup: vi.fn(),
	authorizePreferredSocialClient: vi.fn(),
	authorizeMeetings: vi.fn()
}));

const CALENDARS = [
	{ key: 'cal-3lsupper', name: 'Supper club' },
	{ key: 'cal-3lbrunch', name: 'Brunch club' }
];
const PICKER = "Who's invited?";

// What the page says under the choice, and in the fine print, for each answer.
const PUBLIC_WHAT = 'Anyone can see it, and it shows in search and listings.';
const UNLISTED_WHAT = "Anyone with the link can see it. It doesn't show in search or listings.";
const INVITED_WHAT = 'Only people you invite can see it. You add them after publishing.';
const ON_CALENDAR_WHAT = 'Only people you invite can see it.';
const PUBLIC_FINE_PRINT = "A public or unlisted event can't be made private later.";
const PRIVATE_FINE_PRINT =
	"A private event can't be made public later. Private events can't have an image or repeat yet.";

/** The page's data, as its load returns it for a host with the beta on, or with it off. */
function data(calendars = CALENDARS, privateEvents = true) {
	return {
		pageTitle: 'Create Event',
		actorDid: mocks.user.did,
		rkey: '3knewevent',
		privateEvents,
		hostAccess: null,
		spacesServer: null,
		calendars: privateEvents ? calendars : []
	};
}

function at(search: string) {
	appPage.url = new URL(`https://atmo.rsvp/create${search}`);
}

/** An event already filled in, the way an import leaves one for the page, so a test can publish
 *  it without typing into the editor. */
function filledIn() {
	sessionStorage.setItem(
		'atmo:event-import-prefill',
		JSON.stringify({
			name: 'Dinner',
			startsAt: '2099-01-01T18:00:00.000Z',
			endsAt: '2099-01-01T20:00:00.000Z',
			timezone: 'UTC'
		})
	);
}

/** The text a person reads, with the template's line breaks and indents collapsed. */
function shownText(testId: string): string {
	const found = page.getByTestId(testId).elements()[0];
	return (found?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

function choice(name: string) {
	return page.getByRole('radio', { name, exact: true });
}

function optionsOf(picker: Locator): string[] {
	return [...picker.element().querySelectorAll('option')].map((option) => option.text);
}

const publish = () => page.getByRole('button', { name: /^publish/i });

afterEach(() => {
	at('');
	sessionStorage.clear();
	mocks.savePrivateEvent.mockClear();
	mocks.putRecord.mockClear();
});

describe('choosing who can see it on /create', () => {
	it('asks Public, Unlisted or Private, with nothing picked and no editor until one is', async () => {
		render(CreatePage, { data: data() } as never);
		for (const name of ['Public', 'Unlisted', 'Private']) {
			await expect.element(choice(name)).toBeVisible();
			await expect.element(choice(name)).not.toBeChecked();
		}
		expect(page.getByTestId('audience-what').elements()).toHaveLength(0);
		expect(page.getByRole('combobox').elements()).toHaveLength(0);
		expect(publish().elements()).toHaveLength(0);
	});

	it.each([
		['Public', PUBLIC_WHAT, PUBLIC_FINE_PRINT],
		['Unlisted', UNLISTED_WHAT, PUBLIC_FINE_PRINT],
		['Private', INVITED_WHAT, PRIVATE_FINE_PRINT]
	])(
		'says in one line what %s means, and in the fine print what it rules out',
		async (name, what, finePrint) => {
			render(CreatePage, { data: data() } as never);
			await choice(name).click();
			await expect.element(choice(name)).toBeChecked();
			await expect.poll(() => shownText('audience-what')).toBe(what);
			expect(shownText('audience-fine-print')).toBe(finePrint);
			await expect.element(publish()).toBeVisible();
		}
	);

	it('asks Public or Unlisted only once, with no switch for it in the editor', async () => {
		render(CreatePage, { data: data() } as never);
		await choice('Unlisted').click();
		await expect.element(publish()).toBeVisible();
		expect(page.getByRole('radio', { name: 'Unlisted' }).elements()).toHaveLength(1);
		expect(page.getByRole('radio', { name: 'Public' }).elements()).toHaveLength(1);
	});

	it.each([
		['Public', true],
		['Unlisted', false]
	])('publishes an event picked as %s with that answer in its record', async (name, listed) => {
		filledIn();
		render(CreatePage, { data: data() } as never);
		await choice(name).click();
		await publish().click();
		await expect
			.poll(() => mocks.putRecord)
			.toHaveBeenCalledWith(
				expect.objectContaining({
					record: expect.objectContaining({ preferences: { showInDiscovery: listed } })
				})
			);
		expect(mocks.savePrivateEvent).not.toHaveBeenCalled();
	});

	it('publishes the last of Public and Unlisted picked, when the host changes their mind', async () => {
		filledIn();
		render(CreatePage, { data: data() } as never);
		await choice('Public').click();
		await expect.element(publish()).toBeVisible();
		await choice('Unlisted').click();
		await publish().click();
		await expect
			.poll(() => mocks.putRecord)
			.toHaveBeenCalledWith(
				expect.objectContaining({
					record: expect.objectContaining({ preferences: { showInDiscovery: false } })
				})
			);
	});
});

describe('choosing who’s invited to a private event on /create', () => {
	it('asks who’s invited: just this event, or everyone on one of their calendars', async () => {
		render(CreatePage, { data: data() } as never);
		expect(page.getByRole('combobox').elements()).toHaveLength(0);
		await choice('Private').click();
		const picker = page.getByRole('combobox', { name: PICKER });
		await expect.element(picker).toHaveValue('');
		expect(optionsOf(picker)).toEqual([
			'Just this event',
			'Everyone on Supper club',
			'Everyone on Brunch club'
		]);
		await expect.poll(() => shownText('audience-what')).toBe(INVITED_WHAT);
		await expect.element(publish()).toBeVisible();

		await picker.selectOptions('cal-3lbrunch');
		await expect.element(picker).toHaveValue('cal-3lbrunch');
		await expect.poll(() => shownText('audience-what')).toBe(ON_CALENDAR_WHAT);
		expect(shownText('audience-fine-print')).toBe(PRIVATE_FINE_PRINT);
		await expect.element(choice('Private')).toBeChecked();
		await expect.element(publish()).toBeVisible();

		await picker.selectOptions('Just this event');
		await expect.element(picker).toHaveValue('');
		await expect.poll(() => shownText('audience-what')).toBe(INVITED_WHAT);
	});

	it('puts the event on the calendar picked, and on none for just this event', async () => {
		filledIn();
		render(CreatePage, { data: data() } as never);
		await choice('Private').click();
		const picker = page.getByRole('combobox', { name: PICKER });
		await picker.selectOptions('cal-3lbrunch');
		await publish().click();
		await expect
			.poll(() => mocks.savePrivateEvent)
			.toHaveBeenCalledWith(expect.objectContaining({ calendar: 'cal-3lbrunch' }));

		mocks.savePrivateEvent.mockClear();
		await picker.selectOptions('Just this event');
		await expect.element(picker).toHaveValue('');
		await publish().click();
		await expect
			.poll(() => mocks.savePrivateEvent)
			.toHaveBeenCalledWith(expect.objectContaining({ rkey: '3knewevent' }));
		expect(mocks.savePrivateEvent).not.toHaveBeenCalledWith(
			expect.objectContaining({ calendar: expect.anything() })
		);
		expect(mocks.putRecord).not.toHaveBeenCalled();
	});

	it('asks nothing more of a host with no calendar', async () => {
		render(CreatePage, { data: data([]) } as never);
		await choice('Private').click();
		await expect.poll(() => shownText('audience-what')).toBe(INVITED_WHAT);
		expect(page.getByRole('combobox').elements()).toHaveLength(0);
		await expect.element(publish()).toBeVisible();
	});

	it('comes from a calendar’s page with that calendar picked', async () => {
		at('?audience=calendar&calendar=cal-3lbrunch');
		render(CreatePage, { data: data() } as never);
		await expect.element(choice('Private')).toBeChecked();
		await expect.element(page.getByRole('combobox', { name: PICKER })).toHaveValue('cal-3lbrunch');
		await expect.poll(() => shownText('audience-what')).toBe(ON_CALENDAR_WHAT);
	});

	it('picks nothing when the calendar named is not one of theirs, and says so', async () => {
		at('?audience=calendar&calendar=cal-3lgone');
		render(CreatePage, { data: data() } as never);
		await expect.element(page.getByTestId('calendar-missing')).toBeVisible();
		const picker = page.getByRole('combobox', { name: PICKER });
		// Its own placeholder, so choosing "Just this event" is a change the browser reports.
		await expect.element(picker).toHaveValue('not-picked');
		expect(publish().elements()).toHaveLength(0);
		await picker.selectOptions('');
		await expect.element(publish()).toBeVisible();
		expect(page.getByTestId('calendar-missing').elements()).toHaveLength(0);
		at('?audience=calendar&calendar=cal-3lgone');
		await picker.selectOptions('cal-3lbrunch');
		await expect.element(picker).toHaveValue('cal-3lbrunch');
		await expect.element(publish()).toBeVisible();
		expect(page.getByTestId('calendar-missing').elements()).toHaveLength(0);
	});

	it('offers no editor when a calendar is named and none of theirs could be read', async () => {
		at('?audience=calendar&calendar=cal-3lsupper');
		render(CreatePage, { data: data([]) } as never);
		await expect.element(page.getByTestId('calendar-missing')).toBeVisible();
		expect(page.getByRole('combobox').elements()).toHaveLength(0);
		expect(publish().elements()).toHaveLength(0);
	});

	it('says there may be more calendars when it read only the newest', async () => {
		at('?audience=calendar');
		render(CreatePage, { data: { ...data(), calendarsCapped: true } } as never);
		await expect
			.element(page.getByText('There may be more than these.', { exact: false }))
			.toBeVisible();
	});
});

describe('coming back from the permission step', () => {
	it('has Private picked for just this event, with the editor ready', async () => {
		at('?audience=private');
		render(CreatePage, { data: data() } as never);
		await expect.element(choice('Private')).toBeChecked();
		await expect.element(page.getByRole('combobox', { name: PICKER })).toHaveValue('');
		await expect.element(publish()).toBeVisible();
	});
});

// Private events read as off when someone turned the beta off, or when the setting couldn't be read
// in time. The editor is then the public one, and a public post can't be taken back.
describe('a link that asks for a private audience, while private events are off', () => {
	it.each([
		['a shared calendar', '?audience=calendar&calendar=cal-3lsupper'],
		['invited people', '?audience=private']
	])('for %s shows no editor, only how to turn them on', async (_, search) => {
		at(search);
		render(CreatePage, { data: data(CALENDARS, false) } as never);
		await expect.element(page.getByTestId('private-off')).toBeVisible();
		await expect
			.element(page.getByTestId('private-off').getByRole('link', { name: 'Settings' }))
			.toHaveAttribute('href', '/settings');
		expect(publish().elements()).toHaveLength(0);
		expect(page.getByRole('radio').elements()).toHaveLength(0);
	});

	it('gives a draft chosen as Private no editor when private events turn off mid-edit', async () => {
		const view = await render(CreatePage, { data: data() } as never);
		await choice('Private').click();
		await expect.element(publish()).toBeVisible();
		await view.rerender({ data: data(CALENDARS, false) } as never);
		await expect.poll(() => publish().elements()).toHaveLength(0);
		await expect.element(page.getByTestId('private-off')).toBeVisible();
	});

	it('publishes a draft chosen as Unlisted unlisted when private events turn off mid-edit', async () => {
		filledIn();
		const view = await render(CreatePage, { data: data() } as never);
		await choice('Unlisted').click();
		await expect.element(publish()).toBeVisible();
		await view.rerender({ data: data(CALENDARS, false) } as never);
		await expect.poll(() => page.getByTestId('audience').elements()).toHaveLength(0);
		await publish().click();
		await expect
			.poll(() => mocks.putRecord)
			.toHaveBeenCalledWith(
				expect.objectContaining({
					record: expect.objectContaining({ preferences: { showInDiscovery: false } })
				})
			);
	});

	it('leaves a plain /create as it was: the public editor, with its own Public / Unlisted switch', async () => {
		render(CreatePage, { data: data(CALENDARS, false) } as never);
		await expect.element(publish()).toBeVisible();
		expect(page.getByTestId('private-off').elements()).toHaveLength(0);
		expect(page.getByTestId('audience').elements()).toHaveLength(0);
		await expect.element(page.getByRole('radio', { name: 'Unlisted', exact: true })).toBeVisible();
	});
});
