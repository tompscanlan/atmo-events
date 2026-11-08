import { afterEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import { privateEventUri } from '#lib/private-events/ids.js';
import '../../../../../../app.css';
import EventPage from './+page.svelte';

// Hoisted with the mocks, which run before the rest of the file.
const { HOST, GUEST, mocks } = vi.hoisted(() => ({
	HOST: 'did:plc:hosthosthosthosthosthost',
	GUEST: 'did:plc:guestguestguestguestguest',
	mocks: { rsvp: vi.fn(async () => ({})) }
}));
// The page's writes go through SvelteKit remote functions, which a browser test has no server for.
vi.mock('#lib/private-events/private-events.remote', () => ({
	rsvpToPrivateEvent: mocks.rsvp,
	cancelPrivateRsvp: vi.fn(),
	addGuest: vi.fn(),
	removeGuest: vi.fn()
}));
vi.mock('#lib/atproto/repo.remote.js', () => ({
	putRecord: vi.fn(),
	createRecord: vi.fn(),
	deleteRecord: vi.fn(),
	uploadBlob: vi.fn()
}));
vi.mock('#lib/atproto/auth.svelte.js', () => ({
	user: { isLoggedIn: true, did: GUEST, profile: { handle: 'guest.example.com' } },
	login: vi.fn(),
	logout: vi.fn(),
	signup: vi.fn(),
	authorizePreferredSocialClient: vi.fn(),
	authorizeMeetings: vi.fn()
}));

const ADDRESS = {
	$type: 'community.lexicon.location.address',
	street: '12 Secret Lane',
	locality: 'Louisville',
	country: 'US'
};

/** A guest's view of the event, as the page's load returns it. */
function guestView() {
	return {
		pageTitle: 'Dinner',
		did: GUEST,
		view: 'event',
		eventData: {
			name: 'Dinner',
			startsAt: '2030-01-01T18:00:00Z',
			createdAt: '2029-01-01T00:00:00Z',
			did: HOST,
			rkey: '3kabc',
			uri: privateEventUri(HOST, '3kabc'),
			cid: 'cid',
			locations: [ADDRESS]
		},
		description: null,
		actorDid: HOST,
		rkey: '3kabc',
		hostProfile: { did: HOST, handle: 'host.example.com' },
		attendees: { going: [], interested: [], goingCount: 0, interestedCount: 0 },
		answersUnread: false,
		viewerRsvpStatus: null,
		viewerRsvpRkey: null,
		loggedIn: true,
		guests: null
	};
}

/** What the page asks for with fetch, which is how a geocoding lookup goes. */
function watchRequests() {
	const seen: string[] = [];
	vi.stubGlobal('fetch', async (input: unknown) => {
		seen.push(String(input));
		return Response.json([]);
	});
	return () => seen;
}

afterEach(() => vi.unstubAllGlobals());

describe('a private event’s page', () => {
	it('shows a guest the address and sends it to no geocoder', async () => {
		const requests = watchRequests();
		render(EventPage, { data: guestView() } as never);
		await expect.element(page.getByText('12 Secret Lane', { exact: false }).first()).toBeVisible();
		await new Promise((settled) => setTimeout(settled, 200));
		expect(requests().filter((url) => url.includes('Secret') || url.includes('geocoding'))).toEqual(
			[]
		);
	});

	it('asks a guest who answers Going to share nothing', async () => {
		watchRequests();
		render(EventPage, { data: guestView() } as never);
		await page.getByRole('button', { name: 'Going', exact: true }).click();
		await expect
			.poll(() => mocks.rsvp)
			.toHaveBeenCalledWith(
				expect.objectContaining({ host: HOST, rkey: '3kabc', status: 'going' })
			);
		await expect.element(page.getByText("You're Going", { exact: true })).toBeVisible();
		expect(page.getByText("You're going!", { exact: true }).elements()).toHaveLength(0);
	});
});
