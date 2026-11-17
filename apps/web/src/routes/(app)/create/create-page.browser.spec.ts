import { afterEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import { page as appPage } from '$app/state';
import {
	DESCRIPTION_WITH_GIF,
	embedSettled,
	gifHostRequests,
	loadButton
} from '#lib/private-events/held-embeds.fixture.js';
import '../../../app.css';
import CreatePage from './+page.svelte';

const { mocks } = vi.hoisted(() => ({
	mocks: {
		savePrivateEvent: vi.fn(async () => ({ uri: 'at://x', cid: 'cid' })),
		putRecord: vi.fn(async () => ({ uri: 'at://x', cid: 'cid' })),
		uploadBlob: vi.fn(),
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
	uploadBlob: mocks.uploadBlob
}));
vi.mock('#lib/atproto/auth.svelte.js', () => ({
	user: mocks.user,
	login: vi.fn(),
	logout: vi.fn(),
	signup: vi.fn(),
	authorizePreferredSocialClient: vi.fn(),
	authorizeMeetings: vi.fn()
}));

// What the page says under the choice, and in the fine print, for each answer.
const PUBLIC_WHAT = 'Anyone can see it, and it shows in search and listings.';
const UNLISTED_WHAT = "Anyone with the link can see it. It doesn't show in search or listings.";
const INVITED_WHAT = 'Only people you invite can see it. You add them after publishing.';

/** The page's data, as its load returns it for a host with the beta on, or with it off. */
function data(privateEvents = true) {
	return {
		pageTitle: 'Create Event',
		actorDid: mocks.user.did,
		rkey: '3knewevent',
		privateEvents,
		hostAccess: null,
		spacesServer: null
	};
}

function at(search: string) {
	appPage.url = new URL(`https://atmo.rsvp/create${search}`);
}

/** An event already filled in, the way an import leaves one for the page, so a test can publish
 *  it without typing into the editor. */
function filledIn(more: { description?: string } = {}) {
	sessionStorage.setItem(
		'atmo:event-import-prefill',
		JSON.stringify({
			name: 'Dinner',
			startsAt: '2099-01-01T18:00:00.000Z',
			endsAt: '2099-01-01T20:00:00.000Z',
			timezone: 'UTC',
			...more
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

const publish = () => page.getByRole('button', { name: /^publish/i });

afterEach(() => {
	at('');
	sessionStorage.clear();
	mocks.savePrivateEvent.mockClear();
	mocks.putRecord.mockClear();
	mocks.uploadBlob.mockReset();
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
		['Public', PUBLIC_WHAT],
		['Unlisted', UNLISTED_WHAT],
		['Private', INVITED_WHAT]
	])('says in one line what %s means, with fine print below', async (name, what) => {
		render(CreatePage, { data: data() } as never);
		await choice(name).click();
		await expect.element(choice(name)).toBeChecked();
		await expect.poll(() => shownText('audience-what')).toBe(what);
		expect(shownText('audience-fine-print')).not.toBe('');
		await expect.element(publish()).toBeVisible();
	});

	it('gives Private fine print of its own, and Public and Unlisted the same', async () => {
		render(CreatePage, { data: data() } as never);
		const finePrint: Record<string, string> = {};
		for (const name of ['Public', 'Unlisted', 'Private']) {
			await choice(name).click();
			await expect.element(choice(name)).toBeChecked();
			finePrint[name] = shownText('audience-fine-print');
		}
		expect(finePrint.Unlisted).toBe(finePrint.Public);
		expect(finePrint.Private).not.toBe(finePrint.Public);
	});

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

describe('publishing a private event on /create', () => {
	it('saves it in the host’s own space, never publicly', async () => {
		filledIn();
		render(CreatePage, { data: data() } as never);
		await choice('Private').click();
		await publish().click();
		await expect
			.poll(() => mocks.savePrivateEvent)
			.toHaveBeenCalledWith(expect.objectContaining({ rkey: '3knewevent' }));
		expect(mocks.putRecord).not.toHaveBeenCalled();
	});
});

describe('a private event’s picture on /create', () => {
	const uploaded = {
		$type: 'blob',
		ref: { $link: 'bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku' },
		mimeType: 'image/webp',
		size: 1000
	};
	const saved = () =>
		(mocks.savePrivateEvent.mock.calls[0] as unknown as [{ record: Record<string, unknown> }])[0]
			.record;

	it('is uploaded through the host’s own sign-in and saved with the event', async () => {
		mocks.uploadBlob.mockResolvedValue(uploaded);
		filledIn();
		render(CreatePage, { data: data() } as never);
		await choice('Private').click();
		await publish().click();
		await expect.poll(() => mocks.savePrivateEvent).toHaveBeenCalled();
		expect(mocks.uploadBlob).toHaveBeenCalledTimes(1);
		expect(saved().media).toEqual([expect.objectContaining({ content: uploaded })]);
	});

	it('does not stop the event being created when the cover won’t upload', async () => {
		mocks.uploadBlob.mockRejectedValue(new Error('upload refused'));
		const warned = vi.spyOn(console, 'warn').mockImplementation(() => {});
		filledIn();
		render(CreatePage, { data: data() } as never);
		await choice('Private').click();
		await publish().click();
		await expect.poll(() => mocks.savePrivateEvent).toHaveBeenCalled();
		expect(mocks.uploadBlob).toHaveBeenCalledTimes(1);
		expect(saved()).not.toHaveProperty('media');
		warned.mockRestore();
	});
});

describe('a link in a private event’s description on /create', () => {
	it('asks nothing of a GIF host until the host loads the GIF', async () => {
		filledIn({ description: DESCRIPTION_WITH_GIF });
		render(CreatePage, { data: data() } as never);
		await choice('Private').click();
		await expect.element(page.getByText('Bring snacks', { exact: false })).toBeVisible();
		await embedSettled();
		expect(gifHostRequests()).toEqual([]);
		await loadButton().click();
		await expect.poll(() => gifHostRequests()).not.toEqual([]);
	});
});

describe('coming back from the permission step', () => {
	it('has Private picked, with the editor ready', async () => {
		at('?audience=private');
		render(CreatePage, { data: data() } as never);
		await expect.element(choice('Private')).toBeChecked();
		await expect.element(publish()).toBeVisible();
	});
});

// Private events read as off when someone turned the beta off, or when the setting couldn't be read
// in time. The editor is then the public one, and a public post can't be taken back.
describe('a link that asks for a private audience, while private events are off', () => {
	it('for invited people shows no editor, only how to turn them on', async () => {
		at('?audience=private');
		render(CreatePage, { data: data(false) } as never);
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
		await view.rerender({ data: data(false) } as never);
		await expect.poll(() => publish().elements()).toHaveLength(0);
		await expect.element(page.getByTestId('private-off')).toBeVisible();
	});

	it('publishes a draft chosen as Unlisted unlisted when private events turn off mid-edit', async () => {
		filledIn();
		const view = await render(CreatePage, { data: data() } as never);
		await choice('Unlisted').click();
		await expect.element(publish()).toBeVisible();
		await view.rerender({ data: data(false) } as never);
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
		render(CreatePage, { data: data(false) } as never);
		await expect.element(publish()).toBeVisible();
		expect(page.getByTestId('private-off').elements()).toHaveLength(0);
		expect(page.getByTestId('audience').elements()).toHaveLength(0);
		await expect.element(page.getByRole('radio', { name: 'Unlisted', exact: true })).toBeVisible();
	});
});
