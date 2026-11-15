import { afterEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import { page as appPage } from '$app/state';
import '../../../app.css';
import CreatePage from './+page.svelte';

const { mocks } = vi.hoisted(() => ({
	mocks: {
		savePrivateEvent: vi.fn(async () => ({ uri: 'at://x', cid: 'cid' })),
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
	putRecord: vi.fn(),
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
const CHOICE = 'Only the people on one of your shared calendars';

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

afterEach(() => at(''));

describe('choosing a shared calendar on /create', () => {
	it('is a third choice, private to the people on a calendar, for a host who has one', async () => {
		render(CreatePage, { data: data() } as never);
		await expect.element(page.getByRole('radio', { name: CHOICE })).toBeVisible();
		expect(page.getByRole('combobox').elements()).toHaveLength(0);
		await page.getByRole('radio', { name: CHOICE }).click();
		const picker = page.getByRole('combobox', { name: 'Calendar' });
		await expect.element(picker).toHaveValue('cal-3lsupper');
		await expect.element(page.getByRole('button', { name: /^publish/i })).toBeVisible();
	});

	it('is not offered to a host with no calendar', async () => {
		render(CreatePage, { data: data([]) } as never);
		await expect.element(page.getByRole('radio', { name: 'Everyone' })).toBeVisible();
		expect(page.getByRole('radio', { name: CHOICE }).elements()).toHaveLength(0);
	});

	it('comes from a calendar’s page with that calendar picked', async () => {
		at('?audience=calendar&calendar=cal-3lbrunch');
		render(CreatePage, { data: data() } as never);
		await expect.element(page.getByRole('radio', { name: CHOICE })).toBeChecked();
		await expect
			.element(page.getByRole('combobox', { name: 'Calendar' }))
			.toHaveValue('cal-3lbrunch');
	});

	it('picks nothing when the calendar named is not one of theirs, and says so', async () => {
		at('?audience=calendar&calendar=cal-3lgone');
		render(CreatePage, { data: data() } as never);
		await expect.element(page.getByTestId('calendar-missing')).toBeVisible();
		const picker = page.getByRole('combobox', { name: 'Calendar' });
		await expect.element(picker).toHaveValue('');
		expect(page.getByRole('button', { name: /^publish/i }).elements()).toHaveLength(0);
		await picker.selectOptions('cal-3lbrunch');
		await expect.element(picker).toHaveValue('cal-3lbrunch');
		await expect.element(page.getByRole('button', { name: /^publish/i })).toBeVisible();
		expect(page.getByTestId('calendar-missing').elements()).toHaveLength(0);
	});

	it('offers no editor when a calendar is named and none of theirs could be read', async () => {
		at('?audience=calendar&calendar=cal-3lsupper');
		render(CreatePage, { data: data([]) } as never);
		await expect.element(page.getByTestId('calendar-missing')).toBeVisible();
		expect(page.getByRole('combobox').elements()).toHaveLength(0);
		expect(page.getByRole('button', { name: /^publish/i }).elements()).toHaveLength(0);
	});
});

describe('coming back from the permission step', () => {
	it('has invited people picked, with the editor ready', async () => {
		at('?audience=invited');
		render(CreatePage, { data: data() } as never);
		await expect.element(page.getByRole('radio', { name: 'Invited people only' })).toBeChecked();
		await expect.element(page.getByRole('button', { name: /^publish/i })).toBeVisible();
	});
});

// Private events read as off when someone turned the beta off, or when the setting couldn't be read
// in time. The editor is then the public one, and a public post can't be taken back.
describe('a link that asks for a private audience, while private events are off', () => {
	it.each([
		['a shared calendar', '?audience=calendar&calendar=cal-3lsupper'],
		['invited people', '?audience=invited']
	])('for %s shows no editor, only how to turn them on', async (_, search) => {
		at(search);
		render(CreatePage, { data: data(CALENDARS, false) } as never);
		await expect.element(page.getByTestId('private-off')).toBeVisible();
		await expect
			.element(page.getByTestId('private-off').getByRole('link', { name: 'Settings' }))
			.toHaveAttribute('href', '/settings');
		expect(page.getByRole('button', { name: /^publish/i }).elements()).toHaveLength(0);
		expect(page.getByRole('radio').elements()).toHaveLength(0);
	});

	it('leaves a plain /create as it was: the public editor, with no choice to make', async () => {
		render(CreatePage, { data: data(CALENDARS, false) } as never);
		await expect.element(page.getByRole('button', { name: /^publish/i })).toBeVisible();
		expect(page.getByTestId('private-off').elements()).toHaveLength(0);
	});
});

describe('the pointer to groups on /create', () => {
	it('sends someone posting for a group to the group, when groups are on', async () => {
		render(CreatePage, { data: { ...data(), groupsEnabled: true } } as never);
		const pointer = page.getByTestId('group-pointer');
		await expect
			.element(pointer)
			.toHaveTextContent("Posting for a group? Start from the group's page.");
		await expect.element(pointer.getByRole('link')).toHaveAttribute('href', '/groups');
	});

	it('is not there when groups are off', async () => {
		render(CreatePage, { data: data() } as never);
		await expect.element(page.getByText('Who can see this event?')).toBeVisible();
		expect(page.getByTestId('group-pointer').elements()).toHaveLength(0);
	});
});
