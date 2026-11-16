import { render } from 'svelte/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	CALENDAR_COLLECTION,
	EVENT_COLLECTION,
	privateEventPath,
	privateEventSpace
} from '#lib/private-events/ids.js';
import { CALENDAR_SCOPE, GUEST_SCOPE, HOST_SCOPE } from '#lib/private-events/scopes.js';

const HOST = 'did:plc:hosthosthosthosthosthost';
const GUEST = 'did:plc:guestguestguestguestgues';
const RKEY = '3lzzzzzzzzzzz';
const PATH = privateEventPath(HOST, RKEY);
const NAME = 'Dinner at the secret place';
const RECORD = {
	$type: EVENT_COLLECTION,
	name: NAME,
	createdAt: '2026-11-04T00:00:00.000Z',
	startsAt: '2026-11-07T00:00:00.000Z'
};

const setHeaders = vi.fn();
const reader = { get: vi.fn(), list: vi.fn(), writers: vi.fn() };
const credentialSpaceReader = vi.fn(() => reader);
vi.mock('#lib/spaces/server/space-read.js', () => ({
	credentialSpaceReader: () => credentialSpaceReader()
}));
vi.mock('#lib/actor.js', () => ({ getActor: async (actor: string) => actor, actorToDid: vi.fn() }));
vi.mock('#lib/private-events/server/people.js', () => ({
	verifiedHandle: async (did: string) => `${did.split(':').at(-1)}.example.com`
}));
vi.mock('#lib/private-events/server/enabled.js', () => ({
	privateEventsEnabled: () => true,
	spacesServer: () => null
}));
vi.mock('#lib/private-events/private-events.remote', () => ({
	addGuest: vi.fn(),
	removeGuest: vi.fn(),
	renameCalendar: vi.fn(),
	rsvpToPrivateEvent: vi.fn(),
	cancelPrivateRsvp: vi.fn()
}));
vi.mock('#lib/atproto/auth.svelte.js', () => ({ user: { isLoggedIn: true, did: GUEST } }));
vi.mock('#lib/components/LoginModal.svelte', () => ({ atProtoLoginModalState: { show: vi.fn() } }));
vi.mock('$app/state', () => ({ page: { url: new URL(`https://atmo.example.com${PATH}`) } }));

const route = await import('./+page.server');
const { default: EventPage } = await import('./+page.svelte');

/** The browser's cookies, which outlive a request. */
function browser() {
	const jar = new Map<string, string>();
	return {
		get: (name: string) => jar.get(name),
		set: (name: string, value: string) => void jar.set(name, value),
		delete: (name: string) => void jar.delete(name),
		size: () => jar.size
	};
}

function request(
	did: string | null,
	scope: string,
	cookies: ReturnType<typeof browser>,
	url = `https://atmo.example.com${PATH}`,
	answers: Record<string, unknown> = {}
) {
	const session = did && {
		did,
		getTokenInfo: async () => ({ scope }),
		handle: async () => Response.json(answers)
	};
	return {
		params: { actor: HOST, rkey: RKEY },
		locals: { session },
		cookies,
		url: new URL(url),
		setHeaders
	} as never;
}

const load = (event: never) => route.load(event) as Promise<Record<string, unknown>>;
const page = (data: unknown) => render(EventPage, { props: { data } as never }).body;

/** The host's space holds this event and nothing else. */
function spaceHolds(value: Record<string, unknown>) {
	return async ({ collection }: { collection: string }) =>
		collection === EVENT_COLLECTION
			? {
					uri: `${privateEventSpace(HOST, RKEY)}/${HOST}/${EVENT_COLLECTION}/${RKEY}`,
					cid: 'cid',
					collection,
					rkey: RKEY,
					value
				}
			: null;
}

beforeEach(() => {
	credentialSpaceReader.mockClear();
	reader.get.mockReset();
	reader.writers.mockReset();
	reader.writers.mockResolvedValue([]);
	reader.get.mockImplementation(spaceHolds(RECORD));
	vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('once its host names its space', () => {
	const named = (name: string) => {
		const event = spaceHolds(RECORD);
		reader.get.mockImplementation(async (q: { collection: string }) =>
			q.collection === CALENDAR_COLLECTION
				? { uri: 'at://x', cid: 'c', rkey: 'self', value: { name } }
				: event(q)
		);
		reader.list.mockResolvedValue({
			records: [GUEST, 'did:plc:otherotherotherotherothe'].map((did) => ({
				uri: 'at://x',
				cid: 'c',
				rkey: did,
				value: { read: true, write: true }
			})),
			capped: false
		});
	};

	it('offers its host to save its guests as a shared calendar while it has no name', async () => {
		const data = await load(
			request(HOST, `${HOST_SCOPE} ${CALENDAR_SCOPE}`, browser(), undefined, { members: [] })
		);
		expect(data).toMatchObject({ calendar: null, canName: true });
		expect(page(data)).toContain('Save these people as a shared calendar');
	});

	it('does not offer it without the permission to name a calendar', async () => {
		const data = await load(request(HOST, HOST_SCOPE, browser(), undefined, { members: [] }));
		expect(data.canName).toBe(false);
		const body = page(data);
		expect(body).not.toContain('Save these people as a shared calendar');
		expect(body).toContain('data-testid="calendars-need-allowing"');
		expect(body).toMatch(/allow shared calendars first, under\s*<a href="\/private"/);
	});

	it('shows a guest the calendar it is on, and who else is on it, at the same address', async () => {
		named('Supper club');
		const data = await load(request(GUEST, GUEST_SCOPE, browser()));
		expect(data).toMatchObject({ view: 'event', calendar: { key: RKEY, name: 'Supper club' } });
		const body = page(data).replace(/<!--.*?-->/g, '');
		expect(body).toContain(NAME);
		expect(body).toContain('data-testid="private-to"');
		expect(body).toMatch(/href="\/p\/[^"]+\/calendar\/3lzzzzzzzzzzz"[^>]*>Supper club<\/a>/);
		expect(body).toContain('otherotherotherotherothe');
		expect(body).not.toContain('Only people the host added can see it');
	});

	it('shows its host the calendar, and no longer offers to name it', async () => {
		named('Supper club');
		const data = await load(
			request(HOST, `${HOST_SCOPE} ${CALENDAR_SCOPE}`, browser(), undefined, {
				members: [{ did: GUEST }]
			})
		);
		expect(data).toMatchObject({ calendar: { name: 'Supper club' }, canName: false });
		expect(page(data)).not.toContain('Save these people as a shared calendar');
	});
});

describe('a description written in Markdown', () => {
	it('is formatted the way a public event page formats it, with HTML kept as text', async () => {
		const description = '## Plan\n\nBring **snacks** <script>x</script>';
		reader.get.mockImplementation(spaceHolds({ ...RECORD, description }));
		const data = await load(
			request(HOST, HOST_SCOPE, browser(), `https://atmo.example.com${PATH}`, { members: [] })
		);
		const body = page(data).replace(/<!--.*?-->/g, '');
		expect(body).toMatch(/<h3[^>]*>Plan<\/h3>/);
		expect(body).toMatch(/<strong[^>]*>snacks<\/strong>/);
		expect(body).not.toContain('**snacks**');
		expect(body).toContain('&lt;script>x&lt;/script>');
	});
});

describe('a host whose guests’ answers could not be read', () => {
	it('is told so, rather than that nobody has answered', async () => {
		reader.writers.mockRejectedValue(new Error('503'));
		const answers = { members: [{ did: GUEST }] };
		const data = await load(
			request(HOST, HOST_SCOPE, browser(), `https://atmo.example.com${PATH}`, answers)
		);
		const body = page(data);
		expect(body).toContain('data-testid="answers-unread"');
		expect(body).not.toContain('hasn&#39;t answered');
		expect(body).not.toContain("hasn't answered");
	});
});
