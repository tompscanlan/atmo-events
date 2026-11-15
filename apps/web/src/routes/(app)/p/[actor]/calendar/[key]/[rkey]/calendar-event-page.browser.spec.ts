import { afterEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import { BETA_WARNING_SHORT } from '#lib/private-events/beta.js';
import { calendarEvent, eventUri } from '#lib/private-events/ids.js';
import '../../../../../../../app.css';
import EventPage from './+page.svelte';

const { HOST, GUEST, KEY, mocks } = vi.hoisted(() => {
	const GUEST = 'did:plc:guestguestguestguestguest';
	return {
		HOST: 'did:plc:hosthosthosthosthosthost',
		GUEST,
		KEY: 'cal-3lcalcalcalcal',
		mocks: {
			rsvp: vi.fn(async () => ({})),
			// Signed in as the guest unless a test signs in as the host.
			user: { isLoggedIn: true, did: GUEST, profile: { handle: 'guest.example.com' } }
		}
	};
});
vi.mock('#lib/private-events/private-events.remote', () => ({
	rsvpToPrivateEvent: mocks.rsvp,
	cancelPrivateRsvp: vi.fn(),
	// The beta switch, off, for the offer a guest sees once they answer.
	getPrivateEventsBeta: () => ({ ready: true, current: { canSave: true, on: false } }),
	setPrivateEventsBeta: vi.fn()
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

/** The event's page as its load returns it: for a guest, or with the calendar's people. */
function eventView(guests: unknown = null, guestsCapped = false, isHost = false) {
	return {
		pageTitle: 'Dinner',
		view: 'event',
		eventData: {
			name: 'Dinner',
			startsAt: '2099-01-01T18:00:00Z',
			createdAt: '2029-01-01T00:00:00Z',
			did: HOST,
			rkey: '3kabc',
			uri: eventUri(calendarEvent(HOST, KEY, '3kabc')),
			cid: 'cid'
		},
		description: null,
		actorDid: HOST,
		rkey: '3kabc',
		calendar: { key: KEY, name: 'Supper club' },
		hostProfile: { did: HOST, handle: 'host.example.com' },
		attendees: { going: [], interested: [], goingCount: 0, interestedCount: 0 },
		answersUnread: false,
		viewerRsvpStatus: null,
		viewerRsvpRkey: null,
		loggedIn: true,
		isHost,
		guests,
		guestsCapped
	};
}

/** A description with a Klipy GIF alone on its line, as the page's load parses it (parseRichText's
 *  output); a link alone on its line is the kind that shows as an embed. */
const GIF = 'https://static.klipy.com/ii/abc123/def456.gif';
const WITH_GIF = {
	version: 1,
	markdown: true,
	children: [
		{ type: 'paragraph', children: [{ type: 'text', value: 'Bring snacks' }] },
		{
			type: 'paragraph',
			children: [{ type: 'link', url: GIF, children: [{ type: 'text', value: GIF }] }]
		}
	]
};

/** Anything the page asked the GIF host for: a fetch, or a media element pointing there. */
function gifHostRequests(seen: string[]): string[] {
	const media = [...document.querySelectorAll('[src]')].map((e) => e.getAttribute('src') ?? '');
	const loaded = performance.getEntriesByType('resource').map((e) => e.name);
	return [...seen, ...media, ...loaded].filter((url) => /klipy\.com|k\.gifs\.bsky\.app/.test(url));
}

/** The text a person reads, with the template's line breaks and indents collapsed. */
function shownText(testId: string): string {
	const found = page.getByTestId(testId).elements()[0];
	return (found?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

afterEach(() => {
	mocks.user.did = GUEST;
	mocks.rsvp.mockClear();
});

/** Whether `later` comes after `earlier` on the page. */
function follows(earlier: Element, later: Element): boolean {
	return (earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

describe('an event on a shared calendar', () => {
	it('tells a guest in one line that it is private to the calendar, with a link to it', async () => {
		render(EventPage, { data: eventView() } as never);
		await expect.poll(() => shownText('private-to')).toBe('Private · Supper club');
		await expect
			.element(page.getByTestId('private-to').getByRole('link', { name: 'Supper club' }))
			.toHaveAttribute('href', `/p/host.example.com/calendar/${KEY}`);
	});

	it('ends with the short beta note', async () => {
		mocks.user.did = HOST;
		const guests = [{ did: GUEST, handle: 'guest.example.com', answer: null, answerUnread: false }];
		render(EventPage, { data: eventView(guests, false, true) } as never);
		await expect.poll(() => shownText('beta-notice')).toBe(BETA_WARNING_SHORT);
		const [note] = page.getByTestId('private-note').elements();
		const [list] = page.getByTestId('calendar-guests').elements();
		const [beta] = page.getByTestId('beta-notice').elements();
		expect(follows(note, list)).toBe(true);
		expect(follows(list, beta)).toBe(true);
	});

	it('sends a guest’s answer for this event on this calendar', async () => {
		render(EventPage, { data: eventView() } as never);
		await page.getByRole('button', { name: 'Going', exact: true }).click();
		await expect
			.poll(() => mocks.rsvp)
			.toHaveBeenCalledWith(
				expect.objectContaining({ host: HOST, rkey: '3kabc', calendar: KEY, status: 'going' })
			);
	});

	it('shows the host who is invited and their answers, and a link to add or remove people', async () => {
		mocks.user.did = HOST;
		const guests = [
			{ did: GUEST, handle: 'guest.example.com', answer: 'going', answerUnread: false }
		];
		render(EventPage, { data: eventView(guests, false, true) } as never);
		await expect.poll(() => shownText('private-note')).toBe('Private · Supper club');
		await expect.poll(() => shownText('calendar-guests')).toContain('Invited (1)');
		expect(shownText('calendar-guests')).toContain('guest.example.com Going');
		await expect
			.element(page.getByRole('link', { name: 'Add or remove people on Supper club' }))
			.toHaveAttribute('href', `/p/host.example.com/calendar/${KEY}`);
		expect(page.getByRole('textbox').elements()).toHaveLength(0);
		expect(page.getByRole('button', { name: 'Remove' }).elements()).toHaveLength(0);
	});

	it('tells the host when no one else is invited yet, and still links to add people', async () => {
		mocks.user.did = HOST;
		render(EventPage, { data: eventView([], false, true) } as never);
		await expect.poll(() => shownText('calendar-guests')).toContain('No one else yet.');
		expect(shownText('calendar-guests')).not.toContain('(0)');
		await expect
			.element(page.getByRole('link', { name: 'Add or remove people on Supper club' }))
			.toBeVisible();
	});

	it('shows someone on it who is invited and their answers, and asks them to answer', async () => {
		const guests = [
			{ did: GUEST, handle: 'guest.example.com', answer: null, answerUnread: false },
			{ did: HOST + 'x', handle: 'friend.example.com', answer: 'going', answerUnread: false }
		];
		render(EventPage, { data: eventView(guests) } as never);
		await expect.poll(() => shownText('calendar-guests')).toContain('Invited (2)');
		expect(shownText('calendar-guests')).toContain('friend.example.com Going');
		expect(shownText('calendar-guests')).toContain('guest.example.com No answer yet');
		expect(page.getByRole('link', { name: 'Add or remove people' }).elements()).toHaveLength(0);
		await expect
			.poll(() => shownText('private-note'))
			.toContain('Answer to let the host know you saw it.');
	});

	it('offers a guest who answers, with the beta off, a way to find it again', async () => {
		render(EventPage, { data: eventView() } as never);
		await expect.poll(() => shownText('private-note')).toContain('Answer to let the host know');
		expect(page.getByTestId('find-again').elements()).toHaveLength(0);
		await page.getByRole('button', { name: 'Going', exact: true }).click();
		await expect
			.poll(() => shownText('find-again'))
			.toContain('Turn on private events to find this again under Calendars.');
		expect(shownText('private-note')).not.toContain('Answer to let the host know');
	});

	it('shows a guest their own answer in the list as soon as they give it', async () => {
		const guests = [
			{ did: GUEST, handle: 'guest.example.com', answer: null, answerUnread: false },
			{ did: HOST + 'x', handle: 'friend.example.com', answer: 'going', answerUnread: false }
		];
		render(EventPage, { data: eventView(guests) } as never);
		await expect
			.poll(() => shownText('calendar-guests'))
			.toContain('guest.example.com No answer yet');
		await page.getByRole('button', { name: 'Interested', exact: true }).click();
		await expect.poll(() => shownText('calendar-guests')).toContain('guest.example.com Interested');
	});

	it('never offers it to the host', async () => {
		mocks.user.did = HOST;
		const guests = [{ did: GUEST, handle: 'guest.example.com', answer: null, answerUnread: false }];
		render(EventPage, {
			data: { ...eventView(guests, false, true), viewerRsvpStatus: 'going' }
		} as never);
		await expect.poll(() => shownText('calendar-guests')).toContain('guest.example.com');
		expect(page.getByTestId('find-again').elements()).toHaveLength(0);
	});

	it('tells the host when there may be more people on the calendar than it lists', async () => {
		mocks.user.did = HOST;
		const guests = [{ did: GUEST, handle: 'guest.example.com', answer: null, answerUnread: false }];
		render(EventPage, { data: eventView(guests, true, true) } as never);
		await expect
			.poll(() => shownText('calendar-guests'))
			.toContain('There may be more people on it than these.');
	});

	it('sends its host to this event’s own editor on the calendar', async () => {
		mocks.user.did = HOST;
		render(EventPage, { data: eventView([]) } as never);
		await expect
			.element(page.getByRole('link', { name: 'Edit Event' }))
			.toHaveAttribute('href', `/p/host.example.com/calendar/${KEY}/3kabc/edit`);
	});

	it('asks nothing of a GIF host when it opens, and offers to load the GIF', async () => {
		const seen: string[] = [];
		vi.stubGlobal('fetch', async (input: unknown) => {
			seen.push(String(input));
			return Response.json([]);
		});
		try {
			const view = eventView();
			render(EventPage, {
				data: {
					...view,
					eventData: { ...view.eventData, description: `Bring snacks\n\n${GIF}` },
					description: WITH_GIF
				}
			} as never);
			await expect.element(page.getByText('Bring snacks', { exact: false })).toBeVisible();
			await expect.element(page.getByRole('button', { name: /^Load / })).toBeVisible();
			expect(gifHostRequests(seen)).toEqual([]);
		} finally {
			vi.unstubAllGlobals();
		}
	});
});
