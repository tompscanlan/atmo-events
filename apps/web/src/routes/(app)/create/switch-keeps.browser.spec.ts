// PROTOTYPE check: does /create keep what a host typed when they switch Private -> Public?
import { expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import { page as appPage } from '$app/state';
import '../../../app.css';
import CreatePage from './+page.svelte';
import CreatePageB from './CreatePageB.svelte';

const { mocks } = vi.hoisted(() => ({
	mocks: { user: { isLoggedIn: true, did: 'did:plc:hosthosthosthosthosthost', canPostToBluesky: false, profile: { handle: 'ana.example.com' } } }
}));
vi.mock('#lib/private-events/private-events.remote', () => ({ savePrivateEvent: vi.fn(), cancelPrivateEvent: vi.fn() }));
vi.mock('#lib/atproto/repo.remote.js', () => ({ putRecord: vi.fn(), createRecord: vi.fn(), deleteRecord: vi.fn(), uploadBlob: vi.fn() }));
vi.mock('#lib/atproto/auth.svelte.js', () => ({ user: mocks.user, login: vi.fn(), logout: vi.fn(), signup: vi.fn(), authorizePreferredSocialClient: vi.fn(), authorizeMeetings: vi.fn() }));
const data = { pageTitle: 'Create Event', actorDid: mocks.user.did, rkey: '3knewevent', privateEvents: true, hostAccess: null, spacesServer: null };
const radio = (name: string) => page.getByRole('radio', { name, exact: true });

async function typeName() {
	const title = page.getByLabelText('Event name');
	await title.click();
	await userEvent.keyboard('Dinner at Ana');
	await expect.element(page.getByText('Dinner at Ana')).toBeInTheDocument();
}

it('#105 layout: Private, type a name, switch to Public', async () => {
	appPage.url = new URL('https://atmo.rsvp/create');
	render(CreatePage, { props: { data } });
	await radio('Private').click();
	await typeName();
	await radio('Public').click();
	await expect.element(page.getByText('Publish Event')).toBeVisible();
	console.log('A KEPT NAME AFTER SWITCH:', document.body.textContent?.includes('Dinner at Ana'));
});

it('prototype layout: type a name, choose Private, confirm', async () => {
	document.body.innerHTML = '';
	appPage.url = new URL('https://atmo.rsvp/create');
	render(CreatePageB, { props: { data } });
	await typeName();
	await radio('Private').click();
	await page.getByRole('button', { name: 'Make it private' }).click();
	await expect.element(page.getByText('Only people you invite can see it.')).toBeVisible();
	console.log('B KEPT NAME AFTER SWITCH:', document.body.textContent?.includes('Dinner at Ana'));
});
