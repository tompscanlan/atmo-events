// PROTOTYPE: screenshots of /create as #105 has it (A) and as Florian suggested (B), for a blind
// comparison. Not a test. UX_SHOTS names the folder the pictures go to.
import { describe, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import { page as appPage } from '$app/state';
import '../../../app.css';
import CreatePage from './+page.svelte';
import CreatePageB from './CreatePageB.svelte';

const { mocks } = vi.hoisted(() => ({
	mocks: {
		user: {
			isLoggedIn: true,
			did: 'did:plc:hosthosthosthosthosthost',
			canPostToBluesky: true,
			profile: { handle: 'ana.example.com', displayName: 'Ana' }
		}
	}
}));
vi.mock('#lib/private-events/private-events.remote', () => ({
	savePrivateEvent: vi.fn(),
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

const OUT = '../../../../.ux-shots';
const data = {
	pageTitle: 'Create Event',
	actorDid: mocks.user.did,
	rkey: '3knewevent',
	privateEvents: true,
	hostAccess: null,
	spacesServer: null
};
const SIZES = [
	{ name: 'desktop', width: 1280, height: 1000 },
	{ name: 'phone', width: 390, height: 844 }
];

async function shot(name: string) {
	// No leftover hover from the last click.
	await userEvent.unhover(document.body);
	await new Promise((r) => setTimeout(r, 400));
	await page.screenshot({ path: `${OUT}/${name}.png` });
}

describe.each(SIZES)('$name', (size) => {
	it('A: as #105 has it', async () => {
		await page.viewport(size.width, size.height);
		appPage.url = new URL('https://atmo.rsvp/create');
		const screen = render(CreatePage, { props: { data } });
		await expect.element(page.getByRole('radio', { name: 'Private', exact: true })).toBeVisible();
		await shot(`A-${size.name}-1-first-view`);
		await page.getByRole('radio', { name: 'Private', exact: true }).click();
		await expect.element(page.getByText('Publish Event')).toBeVisible();
		await shot(`A-${size.name}-2-chose-private`);
		await page.getByRole('radio', { name: 'Public', exact: true }).click();
		await shot(`A-${size.name}-3-chose-public`);
		screen.unmount?.();
	});

	it('B: as Florian suggested', async () => {
		await page.viewport(size.width, size.height);
		appPage.url = new URL('https://atmo.rsvp/create');
		const screen = render(CreatePageB, { props: { data } });
		await expect.element(page.getByText('Publish Event')).toBeVisible();
		await shot(`B-${size.name}-1-first-view`);
		await page.getByRole('radio', { name: 'Private', exact: true }).click();
		await expect.element(page.getByRole('button', { name: 'Make it private' })).toBeVisible();
		await shot(`B-${size.name}-2-clicked-private-dialog`);
		await page.getByRole('button', { name: 'Make it private' }).click();
		await expect.element(page.getByText('Only people you invite can see it.')).toBeVisible();
		await shot(`B-${size.name}-3-chose-private`);
		screen.unmount?.();
	});
});
