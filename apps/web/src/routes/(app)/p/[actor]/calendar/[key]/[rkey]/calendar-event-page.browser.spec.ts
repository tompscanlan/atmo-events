import { afterEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
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

/** The text a person reads, with the template's line breaks and indents collapsed. */
function shownText(testId: string): string {
	const found = page.getByTestId(testId).elements()[0];
	return (found?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

afterEach(() => {
	mocks.user.did = GUEST;
	mocks.rsvp.mockClear();
});

describe('an event on a shared calendar', () => {
	it('tells a guest that only the people on the calendar can see it', async () => {
		render(EventPage, { data: eventView() } as never);
		await expect
			.poll(() => shownText('private-note'))
			.toContain('Private event. Only the people on Supper club can see it.');
		await expect
			.element(page.getByRole('link', { name: 'Supper club' }).first())
			.toHaveAttribute('href', `/p/host.example.com/calendar/${KEY}`);
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

	it('shows the host the calendar’s people and their answers, and where to change the list', async () => {
		mocks.user.did = HOST;
		const guests = [
			{ did: GUEST, handle: 'guest.example.com', answer: 'going', answerUnread: false }
		];
		render(EventPage, { data: eventView(guests, false, true) } as never);
		await expect
			.poll(() => shownText('private-note'))
			.toContain('Private event. Only the people on Supper club can see it.');
		await expect.poll(() => shownText('calendar-guests')).toContain('guest.example.com Going');
		await expect
			.poll(() => shownText('calendar-guests'))
			.toContain('To add or remove people, go to the calendar.');
		expect(page.getByRole('textbox').elements()).toHaveLength(0);
		expect(page.getByRole('button', { name: 'Remove' }).elements()).toHaveLength(0);
	});

	it('shows someone on it the calendar’s people and their answers, and asks them to answer', async () => {
		const guests = [
			{ did: GUEST, handle: 'guest.example.com', answer: null, answerUnread: false },
			{ did: HOST + 'x', handle: 'friend.example.com', answer: 'going', answerUnread: false }
		];
		render(EventPage, { data: eventView(guests) } as never);
		await expect.poll(() => shownText('calendar-guests')).toContain('friend.example.com Going');
		await expect
			.poll(() => shownText('calendar-guests'))
			.toContain("guest.example.com Hasn't answered");
		expect(shownText('calendar-guests')).not.toContain('To add or remove people');
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
			.toContain("guest.example.com Hasn't answered");
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
});
