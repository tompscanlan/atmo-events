import { render } from 'svelte/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	EVENT_COLLECTION,
	INVITE_COLLECTION,
	privateEventSpace,
	privateEventUri
} from '#lib/private-events/ids.js';
import { GUEST_SCOPE, INBOX_OWNER_SCOPE } from '#lib/private-events/scopes.js';

const setHeaders = vi.fn();
const beta = vi.hoisted(() => vi.fn());
vi.mock('#lib/private-events/server/beta.js', () => ({ privateEventsBeta: beta }));
const reader = { get: vi.fn(), list: vi.fn(), writers: vi.fn() };
vi.mock('#lib/spaces/server/space-read.js', () => ({ credentialSpaceReader: () => reader }));
vi.mock('#lib/actor.js', () => ({ actorToDid: vi.fn() }));
vi.mock('#lib/private-events/server/people.js', () => ({
	verifiedHandle: async (did: string) => `${did.split(':').at(-1)}.example.com`
}));
const invitationsOn = vi.hoisted(() => ({ value: true }));
vi.mock('#lib/private-events/server/enabled.js', () => ({
	privateEventsEnabled: () => true,
	invitationsEnabled: () => invitationsOn.value,
	spacesServer: () => null
}));

const { load } = await import('./+page.server');
const { default: PrivatePage } = await import('./+page.svelte');

const GUEST = 'did:plc:guestguestguestguestgues';
const HOST = 'did:plc:hosthosthosthosthosthost';
const SOUND = privateEventSpace(HOST, '3laaaaaaaaaaa');
const BROKEN = privateEventSpace(HOST, '3lbbbbbbbbbbb');
const RECORD = {
	$type: EVENT_COLLECTION,
	name: 'Dinner',
	createdAt: '2026-11-04T00:00:00.000Z',
	startsAt: '2026-11-07T00:00:00.000Z'
};

/** A guest of both events, signed in, whose PDS lists both spaces. */
async function renderedPrivatePage(scope = GUEST_SCOPE) {
	const session = {
		did: GUEST,
		getTokenInfo: async () => ({ scope }),
		handle: async () => Response.json({ spaces: [{ uri: SOUND }, { uri: BROKEN }] })
	};
	const data = await load({
		locals: { session },
		cookies: { get: () => undefined, set: () => {}, delete: () => {} },
		setHeaders,
		url: new URL('https://atmo.example/private')
	} as never);
	return render(PrivatePage, { props: { data } as never }).body;
}

beforeEach(() => {
	invitationsOn.value = true;
	reader.get.mockReset();
	reader.list.mockReset();
	reader.writers.mockReset();
	beta.mockResolvedValue(false);
	vi.spyOn(console, 'error').mockImplementation(() => {});
	vi.spyOn(console, 'info').mockImplementation(() => {});
});

describe('what a browser or cache keeps', () => {
	it('keeps no copy of the list', async () => {
		reader.get.mockResolvedValue(null);
		await renderedPrivatePage();
		expect(setHeaders).toHaveBeenCalledWith({ 'cache-control': 'no-store' });
	});
});

describe('/private when a host’s server is down', () => {
	it('does not say there are none', async () => {
		reader.get.mockRejectedValue(new Error('503'));
		const body = await renderedPrivatePage();
		expect(body).not.toContain('None yet');
		expect(body).toContain('data-testid="private-events-incomplete"');
	});

	it('shows what it could read, and says there may be more', async () => {
		reader.get.mockImplementation(async ({ space, rkey }: { space: string; rkey: string }) => {
			if (space === BROKEN) throw new Error('503');
			return {
				uri: `${space}/${HOST}/${EVENT_COLLECTION}/${rkey}`,
				cid: `cid-of-${rkey}`,
				rkey,
				value: RECORD
			};
		});
		const body = await renderedPrivatePage();
		expect(body).toContain('Dinner');
		expect(body).toContain('data-testid="private-events-incomplete"');
	});

	it('says nothing of the kind when all is read', async () => {
		reader.get.mockImplementation(async ({ space, rkey }: { space: string; rkey: string }) => ({
			uri: `${space}/${HOST}/${EVENT_COLLECTION}/${rkey}`,
			cid: `cid-of-${rkey}`,
			rkey,
			value: RECORD
		}));
		const body = await renderedPrivatePage();
		expect(body).not.toContain('data-testid="private-events-incomplete"');
	});
});

describe('/private with a record a host wrote badly', () => {
	it.each([
		['a mode that is not a string', { mode: 7 }],
		['a name that is not a string', { name: 7 }],
		['a start that is not a date', { startsAt: 'soon' }]
	])('still renders for their guest, without it: %s', async (_, broken) => {
		reader.get.mockImplementation(async ({ space, rkey }: { space: string; rkey: string }) => ({
			uri: `${space}/${HOST}/${EVENT_COLLECTION}/${rkey}`,
			cid: `cid-of-${rkey}`,
			rkey,
			value: space === BROKEN ? { ...RECORD, name: 'Broken', ...broken } : RECORD
		}));

		const body = await renderedPrivatePage();

		expect(body).toContain('Dinner');
		expect(body).not.toContain('Broken');
		expect(body.match(/\/private\/3l[a-z]+/g)).toEqual(['/private/3laaaaaaaaaaa']);
	});
});

describe('/private and the beta', () => {
	it('warns that private events made in the beta will be lost', async () => {
		reader.get.mockResolvedValue(null);
		expect(await renderedPrivatePage()).toContain('will be lost');
	});
	it('points someone without the beta at Settings to make their own', async () => {
		reader.get.mockResolvedValue(null);
		expect(await renderedPrivatePage()).toMatch(/turn on private events in\s*<a href="\/settings"/);
	});
	it('does not, once they turned it on', async () => {
		beta.mockResolvedValue(true);
		reader.get.mockResolvedValue(null);
		expect(await renderedPrivatePage()).not.toContain('turn on private events in');
	});
});

describe('/private and invitations', () => {
	const WITH_INBOX = `${GUEST_SCOPE} ${INBOX_OWNER_SCOPE}`;
	const NEW = '3lccccccccccc';
	const invite = (rkey: string) => ({
		rkey,
		cid: `cid-${rkey}`,
		value: {
			$type: INVITE_COLLECTION,
			subject: { uri: privateEventUri(HOST, rkey) },
			createdAt: '2026-11-10T12:00:00.000Z'
		}
	});
	const everyEventReads = () =>
		reader.get.mockImplementation(async ({ space, rkey }: { space: string; rkey: string }) => ({
			uri: `${space}/${HOST}/${EVENT_COLLECTION}/${rkey}`,
			cid: `cid-of-${rkey}`,
			rkey,
			value: RECORD
		}));

	it('shows an invitation the person has not answered, with who sent it and the way there', async () => {
		everyEventReads();
		reader.writers.mockResolvedValue([HOST]);
		reader.list.mockResolvedValue({ records: [invite(NEW)], more: false });
		const body = await renderedPrivatePage(WITH_INBOX);
		expect(body).toContain('data-testid="invitations"');
		expect(body).toContain('hosthosthosthosthosthost.example.com invited you');
		expect(body).toContain(`href="/p/hosthosthosthosthosthost.example.com/private/${NEW}"`);
	});

	it('does not load the event when a pointer passes over the invitation’s link', async () => {
		everyEventReads();
		reader.writers.mockResolvedValue([HOST]);
		reader.list.mockResolvedValue({ records: [invite(NEW)], more: false });
		const body = await renderedPrivatePage(WITH_INBOX);
		expect(body).toMatch(
			new RegExp(`<a[^>]*href="[^"]*/private/${NEW}"[^>]*data-sveltekit-preload-data="off"`)
		);
	});

	it('shows nothing of the invited event itself, which is read only once the guest opens it', async () => {
		everyEventReads();
		reader.writers.mockResolvedValue([HOST]);
		reader.list.mockResolvedValue({ records: [invite(NEW)], more: false });
		await renderedPrivatePage(WITH_INBOX);
		expect(reader.get.mock.calls.map(([q]) => q.rkey)).not.toContain(NEW);
	});

	it('does not call an event already on their list an invitation', async () => {
		everyEventReads();
		reader.writers.mockResolvedValue([HOST]);
		reader.list.mockResolvedValue({ records: [invite('3laaaaaaaaaaa')], more: false });
		const body = await renderedPrivatePage(WITH_INBOX);
		expect(body).not.toContain('data-testid="invitations"');
		expect(body).toContain('Dinner');
	});

	it('still lists their events when the inbox cannot be read, and says invitations may be missing', async () => {
		everyEventReads();
		reader.writers.mockRejectedValue(new Error('503'));
		const body = await renderedPrivatePage(WITH_INBOX);
		expect(body).toContain('Dinner');
		expect(body).toContain('data-testid="invitations-incomplete"');
	});

	it('no longer says the link is the only way, once they have an inbox', async () => {
		everyEventReads();
		reader.writers.mockResolvedValue([]);
		const body = await renderedPrivatePage(WITH_INBOX);
		expect(body).not.toContain('data-testid="link-is-invitation"');
		expect(body).toContain('data-testid="how-invitations-arrive"');
	});

	it('works as before for someone who allowed private events before invitations, and offers them', async () => {
		everyEventReads();
		const body = await renderedPrivatePage(GUEST_SCOPE);
		expect(reader.writers).not.toHaveBeenCalled();
		expect(body).toContain('Dinner');
		expect(body).toContain('data-testid="link-is-invitation"');
		expect(body).toContain('Allow invitations');
	});

	it('reads no inbox and offers nothing where the deployment leaves invitations off, whatever grant is held', async () => {
		invitationsOn.value = false;
		everyEventReads();
		const body = await renderedPrivatePage(WITH_INBOX);
		expect(reader.writers).not.toHaveBeenCalled();
		expect(body).toContain('Dinner');
		expect(body).toContain('data-testid="link-is-invitation"');
		expect(body).not.toContain('Allow invitations');
	});

	it('makes the inbox again when the PDS no longer has the one this browser remembers', async () => {
		const { SpaceAccessDenied } = await import('#lib/spaces/server/space-credential.js');
		everyEventReads();
		reader.writers.mockRejectedValue(new SpaceAccessDenied('at://x', '400 SpaceNotFound'));
		const made: string[] = [];
		const session = {
			did: GUEST,
			getTokenInfo: async () => ({ scope: WITH_INBOX }),
			handle: async (pathname: string) => {
				if (pathname.includes('createSpace')) made.push(pathname);
				return Response.json({ spaces: [] });
			}
		};
		await load({
			locals: { session },
			cookies: { get: () => GUEST, set: () => {}, delete: () => {} },
			setHeaders,
			url: new URL('https://atmo.example/private')
		} as never);
		expect(made).toHaveLength(1);
	});
});
