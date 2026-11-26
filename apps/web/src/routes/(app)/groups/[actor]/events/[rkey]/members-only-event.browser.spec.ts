import { afterEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import '../../../../../../app.css';
import EventPage from './+page.svelte';

const { GROUP, BOB, mocks } = vi.hoisted(() => {
	const BOB = 'did:plc:bobbobbobbobbobbobbobbob';
	return {
		GROUP: 'did:plc:groupgroupgroupgroupgrou',
		BOB,
		mocks: {
			rsvp: vi.fn(async () => ({ ok: true })),
			requestPermissions: vi.fn(),
			user: { isLoggedIn: true, did: BOB, profile: { handle: 'bob.example.com' } }
		}
	};
});
// The page's writes go through SvelteKit remote functions, which a browser test has no server for.
vi.mock('#lib/groups/members-only.remote', () => ({
	rsvpToMembersOnlyEvent: mocks.rsvp,
	cancelMembersOnlyRsvp: vi.fn()
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
vi.mock('@svelte-atproto/oauth/client', () => ({ requestPermissions: mocks.requestPermissions }));

const group = { did: GROUP, handle: 'knit.example', name: 'Night Knitters' };

/** A member's view of the event, as the page's load returns it. */
function memberView(more: Record<string, unknown> = {}) {
	return {
		pageTitle: 'Supper',
		group,
		view: 'event',
		eventData: {
			name: 'Supper',
			startsAt: '2030-01-01T18:00:00Z',
			createdAt: '2029-01-01T00:00:00Z',
			did: GROUP,
			rkey: '3ksupper',
			uri: `at:space/${GROUP}/community.lexicon.calendar.collection/self/${GROUP}/community.lexicon.calendar.event/3ksupper`,
			cid: 'cid'
		},
		description: null,
		actorDid: GROUP,
		rkey: '3ksupper',
		hostProfile: { did: GROUP, handle: 'knit.example', displayName: 'Night Knitters' },
		attendees: { going: [], interested: [], goingCount: 0, interestedCount: 0 },
		viewerRsvpStatus: null,
		viewerRsvpRkey: null,
		loggedIn: true,
		canRsvp: true,
		canEdit: false,
		...more
	};
}

const shown = () => (document.body.textContent ?? '').replace(/\s+/g, ' ');

afterEach(() => vi.clearAllMocks());

describe("a members-only event's page", () => {
	it("says it is private and who can see it, with private events' lock", async () => {
		render(EventPage, { data: memberView() as never });
		const note = page.getByTestId('private-note');
		await expect.element(note).toBeVisible();
		expect(note.element().textContent?.replace(/\s+/g, ' ').trim()).toBe(
			'Private event. Only members of Night Knitters can see it.'
		);
		expect(note.element().querySelector('svg')).not.toBeNull();
		expect(document.querySelector('meta[name="robots"]')?.getAttribute('content')).toBe('noindex');
		expect(page.getByRole('link', { name: 'Edit event' }).elements()).toHaveLength(0);
	});

	it("saves a member's RSVP through the server, with the event as they saw it", async () => {
		render(EventPage, { data: memberView() as never });
		await page.getByRole('button', { name: 'Going', exact: true }).click();
		await expect
			.poll(() => mocks.rsvp.mock.calls[0])
			.toEqual([{ groupDid: GROUP, rkey: '3ksupper', status: 'going', cid: 'cid' }]);
	});

	it('offers editing to a link that may post it, and says how to RSVP without the permission', async () => {
		render(EventPage, { data: memberView({ canEdit: true, canRsvp: false }) as never });
		await expect.element(page.getByRole('link', { name: 'Edit event' })).toBeVisible();
		expect(shown()).toContain('To RSVP, allow atmo to act for you in groups');
	});

	it('asks someone signed out to sign in, naming no event', async () => {
		render(EventPage, {
			data: { pageTitle: 'Members-only event', group, view: 'signed-out' } as never
		});
		await expect.element(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
		expect(shown()).not.toContain('Supper');
	});

	it("asks a member for what opening it takes: the groups' permissions and the guest scope", async () => {
		render(EventPage, {
			data: {
				pageTitle: 'Members-only event',
				group,
				view: 'grant',
				did: BOB,
				access: 'ask',
				spacesServer: null
			} as never
		});
		await page.getByRole('button', { name: 'Allow joining groups' }).click();
		await expect
			.poll(() => mocks.requestPermissions.mock.calls[0]?.[0])
			.toContain(
				'space:community.lexicon.calendar.collection?authority=*&collection=community.lexicon.calendar.rsvp&action=read&action=create&action=update&action=delete'
			);
	});
});
