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

/** The page's data, as its load returns it for a host with private events on, or off. */
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

afterEach(() => at(''));

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
	it('shows no editor, only how to turn them on', async () => {
		at('?audience=invited');
		render(CreatePage, { data: data(false) } as never);
		await expect.element(page.getByTestId('private-off')).toBeVisible();
		await expect
			.element(page.getByTestId('private-off').getByRole('link', { name: 'Settings' }))
			.toHaveAttribute('href', '/settings');
		expect(page.getByRole('button', { name: /^publish/i }).elements()).toHaveLength(0);
		expect(page.getByRole('radio').elements()).toHaveLength(0);
	});

	it('leaves a plain /create as it was: the public editor, with no choice to make', async () => {
		render(CreatePage, { data: data(false) } as never);
		await expect.element(page.getByRole('button', { name: /^publish/i })).toBeVisible();
		expect(page.getByTestId('private-off').elements()).toHaveLength(0);
	});
});
