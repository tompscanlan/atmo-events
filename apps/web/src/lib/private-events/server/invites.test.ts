import type { Cookies } from '@sveltejs/kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SpaceAccessDenied } from '#lib/spaces/server/space-credential.js';
import { inboxSpace, INVITE_COLLECTION, privateEventSpace, privateEventUri } from '../ids';
import { GUEST_SCOPE, INBOX_OWNER_SCOPE, INVITER_SCOPE } from '../scopes';
import type { CallerSession } from './caller';

const reader = { get: vi.fn(), list: vi.fn(), writers: vi.fn() };
vi.mock('#lib/spaces/server/space-read.js', () => ({ credentialSpaceReader: () => reader }));
vi.mock('./people', () => ({
	verifiedHandle: async (did: string) =>
		did.includes('nohandle') ? null : `${did.split(':').at(-1)}.example.com`
}));

const { ensureInbox, readInvitations, sendInvite, takeBackInvite } = await import('./invites');

const ME = 'did:plc:guestguestguestguestgues';
const HOST = 'did:plc:hosthosthosthosthosthost';
const OTHER = 'did:plc:otherotherotherotherothe';
const RKEY = '3lzzzzzzzzzzz';
const OWNER = `${GUEST_SCOPE} ${INBOX_OWNER_SCOPE}`;
const URL_HTTPS = new URL('https://atmo.example/private');

type Sent = { nsid: string; body?: Record<string, unknown> };

function caller(
	did: string,
	scope: string,
	answer: (nsid: string) => Response | null = () => null
) {
	const sent: Sent[] = [];
	const session: CallerSession = {
		did,
		scope,
		handle: async (pathname, init) => {
			const nsid = new URL(pathname, 'https://pds.example.com').pathname.replace('/xrpc/', '');
			sent.push({ nsid, ...(init.body ? { body: JSON.parse(String(init.body)) } : {}) });
			return answer(nsid) ?? Response.json({});
		}
	};
	return { session, sent };
}

function cookieJar(initial: Record<string, string> = {}) {
	const jar = new Map(Object.entries(initial));
	const set = vi.fn<Cookies['set']>((name, value) => {
		jar.set(name, value);
	});
	return { get: (name: string) => jar.get(name), set };
}

const invite = (host: string, rkey: string, createdAt = '2026-11-10T12:00:00.000Z') => ({
	rkey,
	cid: `cid-${rkey}`,
	value: { $type: INVITE_COLLECTION, subject: { uri: privateEventUri(host, rkey) }, createdAt }
});

/** An inbox whose writers each list the given invites. */
function theInboxHolds(byWriter: Record<string, unknown[] | Error>) {
	reader.writers.mockResolvedValue(Object.keys(byWriter));
	reader.list.mockImplementation(async ({ repo }: { repo: string }) => {
		const theirs = byWriter[repo];
		if (theirs instanceof Error) throw theirs;
		return { records: theirs, more: false };
	});
}

beforeEach(() => {
	reader.get.mockReset();
	reader.list.mockReset();
	reader.writers.mockReset();
	vi.spyOn(console, 'error').mockImplementation(() => {});
	vi.spyOn(console, 'info').mockImplementation(() => {});
});

describe('ensureInbox', () => {
	it('makes a space only its owner reads and anyone may write to, under their own DID', async () => {
		const { session, sent } = caller(ME, OWNER);
		await ensureInbox(session, cookieJar(), URL_HTTPS);
		expect(sent).toEqual([
			{
				nsid: 'com.atproto.space.createSpace',
				body: {
					spaceType: 'rsvp.atmo.dev.inbox',
					skey: 'self',
					policy: { $type: 'com.atproto.memberspace.policy', publicWrite: true }
				}
			}
		]);
		expect(JSON.stringify(sent[0].body)).not.toContain('publicRead');
	});

	it('remembers it in this browser, so the next page makes no call', async () => {
		const { session, sent } = caller(ME, OWNER);
		const cookies = cookieJar();
		await ensureInbox(session, cookies, URL_HTTPS);
		await ensureInbox(session, cookies, URL_HTTPS);
		expect(sent).toHaveLength(1);
		expect(cookies.set.mock.calls[0][2]).toMatchObject({ httpOnly: true, secure: true });
	});

	it('takes an inbox that is already there as made', async () => {
		const { session } = caller(ME, OWNER, () =>
			Response.json({ error: 'SpaceAlreadyExists' }, { status: 400 })
		);
		const cookies = cookieJar();
		await ensureInbox(session, cookies, URL_HTTPS);
		expect(cookies.set).toHaveBeenCalledOnce();
	});

	it('tries again on the next page when the PDS did not make it', async () => {
		const { session, sent } = caller(ME, OWNER, () =>
			Response.json({ error: 'InternalServerError' }, { status: 500 })
		);
		const cookies = cookieJar();
		await ensureInbox(session, cookies, URL_HTTPS);
		await ensureInbox(session, cookies, URL_HTTPS);
		expect(cookies.set).not.toHaveBeenCalled();
		expect(sent).toHaveLength(2);
	});

	it('makes it again when told the PDS no longer has it, whatever this browser remembers', async () => {
		const { session, sent } = caller(ME, OWNER);
		await ensureInbox(session, cookieJar({ atmo_private_inbox: ME }), URL_HTTPS, true);
		expect(sent).toHaveLength(1);
	});

	it('makes one for whoever is signed in now, not for whoever this browser last made one', async () => {
		const { session, sent } = caller(ME, OWNER);
		await ensureInbox(session, cookieJar({ atmo_private_inbox: OTHER }), URL_HTTPS);
		expect(sent).toHaveLength(1);
	});

	it('calls no PDS without the grant, as for someone who allowed private events before invitations', async () => {
		const { session, sent } = caller(ME, GUEST_SCOPE);
		const cookies = cookieJar();
		await ensureInbox(session, cookies, URL_HTTPS);
		expect(sent).toHaveLength(0);
		expect(cookies.set).not.toHaveBeenCalled();
	});
});

describe('sendInvite and takeBackInvite', () => {
	it('write into the guest’s inbox from the host’s own repo, under the event’s key', async () => {
		const { session, sent } = caller(HOST, INVITER_SCOPE);
		await sendInvite(session, ME, RKEY);
		await takeBackInvite(session, ME, RKEY);
		const at = { space: inboxSpace(ME), repo: HOST, collection: INVITE_COLLECTION, rkey: RKEY };
		expect(sent[0]).toMatchObject({ nsid: 'com.atproto.space.putRecord', body: at });
		expect(sent[1]).toEqual({ nsid: 'com.atproto.space.deleteRecord', body: at });
	});

	it('never throw, whatever the PDS answers', async () => {
		const { session } = caller(HOST, INVITER_SCOPE, () =>
			Response.json({ error: 'InternalServerError' }, { status: 500 })
		);
		await expect(sendInvite(session, ME, RKEY)).resolves.toBeUndefined();
		await expect(takeBackInvite(session, ME, RKEY)).resolves.toBeUndefined();
	});

	it('call no PDS without the inviter grant', async () => {
		const { session, sent } = caller(HOST, OWNER);
		await sendInvite(session, ME, RKEY);
		await takeBackInvite(session, ME, RKEY);
		expect(sent).toHaveLength(0);
	});
});

describe('readInvitations', () => {
	const me = () => caller(ME, OWNER).session;

	it('lists each invite with who sent it, when, and the event’s page, newest first', async () => {
		theInboxHolds({
			[HOST]: [invite(HOST, '3laaaaaaaaaaa', '2026-11-01T00:00:00.000Z')],
			[OTHER]: [invite(OTHER, '3lbbbbbbbbbbb', '2026-11-09T00:00:00.000Z')]
		});
		expect(await readInvitations(me())).toEqual({
			invitations: [
				{
					space: privateEventSpace(OTHER, '3lbbbbbbbbbbb'),
					host: OTHER,
					hostHandle: 'otherotherotherotherothe.example.com',
					invitedAt: '2026-11-09T00:00:00.000Z',
					href: '/p/otherotherotherotherothe.example.com/private/3lbbbbbbbbbbb'
				},
				{
					space: privateEventSpace(HOST, '3laaaaaaaaaaa'),
					host: HOST,
					hostHandle: 'hosthosthosthosthosthost.example.com',
					invitedAt: '2026-11-01T00:00:00.000Z',
					href: '/p/hosthosthosthosthosthost.example.com/private/3laaaaaaaaaaa'
				}
			],
			incomplete: false,
			noInbox: false
		});
	});

	it('reads the inbox under the person’s own DID, and each inviter’s invites from that inviter', async () => {
		theInboxHolds({ [HOST]: [] });
		await readInvitations(me());
		expect(reader.writers).toHaveBeenCalledWith(inboxSpace(ME));
		expect(reader.list).toHaveBeenCalledWith(
			expect.objectContaining({ space: inboxSpace(ME), repo: HOST, collection: INVITE_COLLECTION })
		);
	});

	it('reads only the invites from an inviter’s server, never the event, so not which one they open', async () => {
		theInboxHolds({ [HOST]: [invite(HOST, RKEY)] });
		await readInvitations(me());
		expect(reader.get).not.toHaveBeenCalled();
	});

	it('shows no invite to an event of someone other than whoever wrote it', async () => {
		const forged = { ...invite(OTHER, RKEY), rkey: RKEY };
		theInboxHolds({ [HOST]: [forged] });
		expect((await readInvitations(me())).invitations).toEqual([]);
	});

	it.each([
		['whose key is not the event’s', { ...invite(HOST, RKEY), rkey: '3lother' }],
		['with no subject', { rkey: RKEY, cid: 'c', value: { createdAt: '2026-11-10T12:00:00.000Z' } }],
		[
			'with no date',
			{ rkey: RKEY, cid: 'c', value: { subject: { uri: privateEventUri(HOST, RKEY) } } }
		],
		['with a date that is not one', invite(HOST, RKEY, 'soon')],
		['with a date only some clocks would read', invite(HOST, RKEY, 'Nov 10, 2026')],
		['whose key would lead the link somewhere else', invite(HOST, '..')]
	])('ignores an invite %s', async (_, row) => {
		theInboxHolds({ [HOST]: [row, invite(HOST, '3lgoodgoodgoo')] });
		const { invitations } = await readInvitations(me());
		expect(invitations.map((i) => i.space)).toEqual([privateEventSpace(HOST, '3lgoodgoodgoo')]);
	});

	it('shows no one who only once wrote, since the writer list keeps them after a take-back', async () => {
		theInboxHolds({ [HOST]: [] });
		expect(await readInvitations(me())).toMatchObject({ invitations: [], incomplete: false });
	});

	it('names an inviter by DID when their handle does not check out', async () => {
		const host = 'did:plc:nohandlenohandlenohandle';
		theInboxHolds({ [host]: [invite(host, RKEY)] });
		const [only] = (await readInvitations(me())).invitations;
		expect(only).toMatchObject({
			hostHandle: null,
			href: `/p/${encodeURIComponent(host)}/private/${RKEY}`
		});
	});

	it('says so when their PDS has no inbox for them, which is not an empty one', async () => {
		reader.writers.mockRejectedValue(new SpaceAccessDenied(inboxSpace(ME), '400 SpaceNotFound'));
		expect(await readInvitations(me())).toEqual({
			invitations: [],
			incomplete: false,
			noInbox: true
		});
	});

	it('does not pass an outage off as no invitations', async () => {
		reader.writers.mockRejectedValue(new Error('503'));
		expect(await readInvitations(me())).toEqual({
			invitations: [],
			incomplete: true,
			noInbox: false
		});
	});

	it('does not wait on an inviter’s server that stalls, and says there may be more', async () => {
		vi.useFakeTimers();
		try {
			reader.writers.mockResolvedValue([HOST, OTHER]);
			reader.list.mockImplementation(({ repo }: { repo: string }) =>
				repo === HOST
					? Promise.resolve({ records: [invite(HOST, RKEY)], more: false })
					: new Promise(() => {})
			);
			const pending = readInvitations(me());
			await vi.advanceTimersByTimeAsync(4_000);
			const found = await pending;
			expect(found.invitations.map((i) => i.host)).toEqual([HOST]);
			expect(found.incomplete).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	it('does not let an inviter hold theirs at the top with a date ahead of now', async () => {
		theInboxHolds({
			[HOST]: [invite(HOST, '3laaaaaaaaaaa', '2999-01-01T00:00:00.000Z')],
			[OTHER]: [invite(OTHER, '3lbbbbbbbbbbb', new Date().toISOString())]
		});
		const [first] = (await readInvitations(me())).invitations;
		expect(Date.parse(first.invitedAt)).toBeLessThanOrEqual(Date.now());
	});

	it('keeps what it read when one inviter’s server is down, and says there may be more', async () => {
		theInboxHolds({ [HOST]: [invite(HOST, RKEY)], [OTHER]: new Error('503') });
		const found = await readInvitations(me());
		expect(found.invitations).toHaveLength(1);
		expect(found.incomplete).toBe(true);
	});

	it('says there may be more when an inviter has more than it reads', async () => {
		reader.writers.mockResolvedValue([HOST]);
		reader.list.mockResolvedValue({ records: [invite(HOST, RKEY)], more: true });
		expect((await readInvitations(me())).incomplete).toBe(true);
	});

	it('reads only so many inviters, and says so, however many wrote', async () => {
		const many = Array.from(
			{ length: 60 },
			(_, i) => `did:plc:writer${String(i).padStart(18, '0')}`
		);
		theInboxHolds(Object.fromEntries(many.map((did) => [did, []])));
		const found = await readInvitations(me());
		expect(reader.list).toHaveBeenCalledTimes(50);
		expect(found.incomplete).toBe(true);
	});

	it('leaves out what the person wrote in their own inbox', async () => {
		theInboxHolds({ [ME]: [invite(ME, RKEY)] });
		expect((await readInvitations(me())).invitations).toEqual([]);
		expect(reader.list).not.toHaveBeenCalled();
	});
});
