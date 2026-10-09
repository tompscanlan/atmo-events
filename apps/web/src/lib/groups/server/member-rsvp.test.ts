// A member's RSVP to a members-only event, written from their own session into
// the group's calendar space, in their own repo there. Never into their public
// repo, and nothing falls back to one. (Spec: FR-113, FR-114.)
//
// The member's PDS is a fake that answers the way the spaces PDS does: a put
// creates or replaces the record at its key, a delete succeeds whether or not
// the record was there, and a read of a missing record is 400 RecordNotFound.
// Each case asserts every request the member's session sent, so "sent nothing"
// is a count, not a reading of the result. The group's host is a fake space
// reader holding the events the RSVP names, and every read it serves goes into
// the same sequence as the member's requests, so a test can tell which came
// first.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CallerMembership, GroupRow } from '../types';
import type { GroupSpaceReader } from './about-read';
import {
	spaceReader,
	type FakeSpaceReader,
	type SpaceRecordInput
} from './__fixtures__/space-reader';
import type { MemberSession } from './acceptance';
import { memberGrant } from './member-grants';
import {
	RSVP_EVENT_CHANGED,
	RSVP_NO_EVENT,
	RSVP_NO_SPACES,
	RSVP_REFUSED,
	RSVP_RETRY_LATER,
	deleteMembersOnlyRsvp,
	putMembersOnlyRsvp,
	readOwnMembersOnlyRsvp
} from './member-rsvp';

const MEMBER = 'did:plc:hkymspvcjhy6sbujuydfj7sv';
const ANOTHER_MEMBER = 'did:plc:ib2wrjcp4ulwqu35a7rtlckv';
const GROUP_DID = 'did:plc:jcwgw6fcnb5vyoid7nz7sl26';
// Written out, so a wrong type, key or URI form in the code under test fails here.
const CALENDAR = `at://${GROUP_DID}/space/rsvp.atmo.group.calendar/self`;
const RSVP = 'community.lexicon.calendar.rsvp';
const EVENT = 'community.lexicon.calendar.event';
const MEETING_URI = `${CALENDAR}/${GROUP_DID}/${EVENT}/3lmeeting`;
/** The meeting's cid as the group's host holds it now. */
const MEETING_CID = 'bafyreimeetingcurrent';
const BASE_SCOPE = 'atproto rpc:app.bsky.actor.getProfile?aud=*';
/** What a sign-in grants today. */
const GRANTED = `${BASE_SCOPE} ${memberGrant(GROUP_DID)}`;
/** What a sign-in granted before RSVPs joined the grant, written out. */
const ACCEPTANCE_ONLY = `${BASE_SCOPE} space:*?authority=${GROUP_DID}&collection=group.opensocial.acceptance&action=create&action=update&action=delete`;
/** Stamps of the member's session before a re-authorization and after it. */
const SESSION = 1_791_000_000_000;
const NEXT_SESSION = 1_791_003_600_000;

const group = { group_did: GROUP_DID } as GroupRow;

function standing(onRoster: boolean): CallerMembership {
	return {
		did: MEMBER,
		role: onRoster ? 'member' : null,
		pendingRequestId: null,
		permissions: new Set(),
		onRoster
	};
}
const onRoster = standing(true);
const offRoster = standing(false);

interface Call {
	method: string;
	nsid: string;
	body: Record<string, unknown> | null;
	query: Record<string, string>;
}

interface MemberPds {
	session(scope: string): MemberSession;
	calls: Call[];
	/** The member's records in the space, by `space|collection|rkey`. */
	records: Map<string, Record<string, unknown>>;
	/** Answers every write with this instead, when set. */
	refuseWrites: Response | null;
}

/** Every request in order, the member's and the group's: `member <nsid>` and
 *  `group get <space> <repo> <collection> <rkey>`. */
let sequence: string[];

function memberPds(): MemberPds {
	const pds: MemberPds = {
		calls: [],
		records: new Map(),
		refuseWrites: null,
		session(scope) {
			return {
				did: MEMBER,
				scope,
				async handle(pathname, init) {
					const url = new URL(pathname, 'https://member.pds.test');
					const nsid = url.pathname.replace(/^\/xrpc\//, '');
					const method = init.method ?? 'GET';
					const body = init.body
						? (JSON.parse(String(init.body)) as Record<string, unknown>)
						: null;
					const query = Object.fromEntries(url.searchParams);
					pds.calls.push({ method, nsid, body, query });
					sequence.push(`member ${nsid}`);
					const at = body ?? query;
					const key = `${at.space}|${at.collection}|${at.rkey}`;
					if (nsid === 'com.atproto.space.getRecord' && method === 'GET') {
						const value = pds.records.get(key);
						if (!value) {
							return Response.json(
								{ error: 'RecordNotFound', message: 'Could not locate record' },
								{ status: 400 }
							);
						}
						return Response.json({
							uri: `${at.space}/${at.repo}/${at.collection}/${at.rkey}`,
							cid: 'bafyrsvp',
							value
						});
					}
					if (pds.refuseWrites) return pds.refuseWrites.clone();
					if (nsid === 'com.atproto.space.putRecord' && method === 'POST') {
						pds.records.set(key, body!.record as Record<string, unknown>);
						return Response.json({
							uri: `${at.space}/${at.repo}/${at.collection}/${at.rkey}`,
							cid: 'bafyrsvp'
						});
					}
					if (nsid === 'com.atproto.space.deleteRecord' && method === 'POST') {
						pds.records.delete(key);
						return Response.json({});
					}
					return Response.json({ error: 'MethodNotImplemented' }, { status: 501 });
				}
			};
		}
	};
	return pds;
}

/** The meeting at `rkey` as the group's host holds it now, at `cid`. */
function meeting(rkey: string, cid: string): SpaceRecordInput {
	return {
		collection: EVENT,
		rkey,
		cid,
		value: { $type: EVENT, name: 'Committee call', startsAt: '2030-11-02T18:00:00.000Z' }
	};
}

/** The group's host, as the group's own space reader sees it: the calendar
 *  space's events by key, each at its current cid. Only one event read by its
 *  key is expected of it, and each call goes into `sequence`. */
function groupHost(events: Record<string, string> = { '3lmeeting': MEETING_CID }): FakeSpaceReader {
	return spaceReader(GROUP_DID, {
		space: CALENDAR,
		records: Object.entries(events).map(([rkey, cid]) => meeting(rkey, cid)),
		onCall: (line) => sequence.push(`group ${line}`),
		fail: (call) =>
			call.method === 'get'
				? undefined
				: new Error(`an RSVP reads one event by its key, never ${call.method}`)
	});
}

/** A reauthorize() that records each call and answers `url`. */
function reauthorizer(url: string | null) {
	const fn = vi.fn(async () => url);
	return fn;
}

/** A cancel's input for the member, on the roster, holding `member`'s session
 *  as it is now (`SESSION`), with no marker from the page. */
function target(member: MemberSession | null, reauthorize = reauthorizer('https://never.test')) {
	return {
		membership: onRoster,
		group,
		member,
		rkey: '3lmeeting',
		callerDid: MEMBER,
		stamp: SESSION,
		asked: null as string | null,
		reauthorize
	};
}

/** An RSVP's input: a cancel's, the answer, the cid the page showed (the
 *  meeting's current one unless a test says otherwise) and the group's host. */
function rsvpInput(
	member: MemberSession | null,
	host: FakeSpaceReader = groupHost(),
	reauthorize = reauthorizer('https://never.test')
) {
	return {
		...target(member, reauthorize),
		status: 'going' as 'going' | 'interested' | 'notgoing',
		cid: MEETING_CID as string | null,
		groupReader: vi.fn(async () => host as GroupSpaceReader | null)
	};
}

/** A marker as the server hands one out with a re-authorize answer: made for
 *  the member under the session they had before signing in again, so it counts
 *  under today's session. */
async function markerFromServer(): Promise<string> {
	const answer = await deleteMembersOnlyRsvp({
		...target(null, reauthorizer('https://consent.test')),
		stamp: SESSION - 1
	});
	return (answer as { marker: string }).marker;
}

let pds: MemberPds;

beforeEach(() => {
	sequence = [];
	pds = memberPds();
});

afterEach(() => vi.restoreAllMocks());

describe('putMembersOnlyRsvp and deleteMembersOnlyRsvp, for a member holding the grant', () => {
	it("a members-only RSVP is written from the member's session into the calendar space at the event's key", async () => {
		const reauthorize = reauthorizer('https://never.test');
		const member = pds.session(GRANTED);

		const going = await putMembersOnlyRsvp(rsvpInput(member, groupHost(), reauthorize));

		expect(going).toEqual({ ok: true, uri: `${CALENDAR}/${MEMBER}/${RSVP}/3lmeeting` });
		expect(pds.calls).toEqual([
			{
				method: 'POST',
				nsid: 'com.atproto.space.putRecord',
				body: {
					space: CALENDAR,
					repo: MEMBER,
					collection: RSVP,
					rkey: '3lmeeting',
					record: {
						$type: RSVP,
						status: `${RSVP}#going`,
						subject: { uri: MEETING_URI, cid: MEETING_CID },
						createdAt: expect.any(String)
					}
				},
				query: {}
			}
		]);
		const record = pds.calls[0].body!.record as { createdAt: string };
		expect(new Date(record.createdAt).toISOString()).toBe(record.createdAt);

		// A change of mind is the same record at the same key, so a member holds
		// one RSVP per event. A marker from the page changes nothing for a session
		// that holds the grant.
		const notGoing = await putMembersOnlyRsvp({
			...rsvpInput(member, groupHost(), reauthorize),
			status: 'notgoing',
			asked: await markerFromServer()
		});
		expect(notGoing).toEqual({ ok: true, uri: `${CALENDAR}/${MEMBER}/${RSVP}/3lmeeting` });
		expect(pds.calls.map((c) => `${c.nsid} ${c.body?.rkey}`)).toEqual([
			'com.atproto.space.putRecord 3lmeeting',
			'com.atproto.space.putRecord 3lmeeting'
		]);
		expect([...pds.records.keys()]).toEqual([`${CALENDAR}|${RSVP}|3lmeeting`]);
		expect(pds.records.get(`${CALENDAR}|${RSVP}|3lmeeting`)?.status).toBe(`${RSVP}#notgoing`);
		expect(reauthorize).not.toHaveBeenCalled();
	});

	it('a members-only RSVP cancel deletes that record, and no call names com.atproto.repo', async () => {
		const reauthorize = reauthorizer(null);
		const member = pds.session(GRANTED);
		await putMembersOnlyRsvp({
			...rsvpInput(member, groupHost(), reauthorize),
			status: 'interested'
		});
		expect(await readOwnMembersOnlyRsvp(onRoster, group, member, '3lmeeting')).toEqual({
			status: 'interested',
			rkey: '3lmeeting'
		});
		pds.calls.length = 0;

		expect(await deleteMembersOnlyRsvp(target(member, reauthorize))).toEqual({ ok: true });

		expect(pds.calls).toEqual([
			{
				method: 'POST',
				nsid: 'com.atproto.space.deleteRecord',
				body: { space: CALENDAR, repo: MEMBER, collection: RSVP, rkey: '3lmeeting' },
				query: {}
			}
		]);
		expect(pds.records.size).toBe(0);
		// Read back, it is gone: one read, and no RSVP.
		expect(await readOwnMembersOnlyRsvp(onRoster, group, member, '3lmeeting')).toBeNull();

		// Every path, with or without the grant, asked or not: no call to the public repo.
		const bare = pds.session(BASE_SCOPE);
		const asked = await markerFromServer();
		await putMembersOnlyRsvp(rsvpInput(bare, groupHost(), reauthorize));
		await putMembersOnlyRsvp({ ...rsvpInput(bare, groupHost(), reauthorize), asked });
		await deleteMembersOnlyRsvp(target(bare, reauthorize));
		await readOwnMembersOnlyRsvp(onRoster, group, bare, '3lmeeting');
		pds.refuseWrites = Response.json({ error: 'InternalServerError' }, { status: 500 });
		vi.spyOn(console, 'error').mockImplementation(() => {});
		await putMembersOnlyRsvp(rsvpInput(member, groupHost(), reauthorize));
		await deleteMembersOnlyRsvp(target(member, reauthorize));
		expect(pds.calls.length).toBeGreaterThan(0);
		expect(pds.calls.filter((c) => c.nsid.startsWith('com.atproto.repo.'))).toEqual([]);
		expect(pds.calls.every((c) => c.nsid.startsWith('com.atproto.space.'))).toBe(true);
	});
});

// The event an RSVP names is read as the group, through the group's own space
// reader, after the roster gate and the grant check and before the write. The
// RSVP cites the version the group read, and only when the page showed that
// same version: a cid from the browser is compared, never written. A cancel
// reads no event. (Spec: FR-113, FR-120.)
describe('the event an RSVP names', () => {
	it("a members-only RSVP names the event's current cid, read as the group before the write", async () => {
		const host = groupHost({ '3lmeeting': MEETING_CID });
		const member = pds.session(GRANTED);
		const input = rsvpInput(member, host);

		expect(await putMembersOnlyRsvp(input)).toEqual({
			ok: true,
			uri: `${CALENDAR}/${MEMBER}/${RSVP}/3lmeeting`
		});

		// One read of the event by its key, as the group, in the calendar space,
		// and then the one write, from the member's session.
		expect(input.groupReader).toHaveBeenCalledTimes(1);
		expect(sequence).toEqual([
			`group get ${CALENDAR} ${GROUP_DID} ${EVENT} 3lmeeting`,
			'member com.atproto.space.putRecord'
		]);
		expect(pds.calls[0].body!.record).toEqual({
			$type: RSVP,
			status: `${RSVP}#going`,
			subject: { uri: MEETING_URI, cid: MEETING_CID },
			createdAt: expect.any(String)
		});
	});

	// A cancel reads no event and checks no cid: it deletes whatever version
	// the RSVP named.
	it('a members-only RSVP cancel reads no event', async () => {
		expect(await deleteMembersOnlyRsvp(target(pds.session(GRANTED)))).toEqual({ ok: true });
		expect(sequence).toEqual(['member com.atproto.space.deleteRecord']);
	});

	it('an RSVP from a page showing an older version of the event, or none, writes nothing and says to reload', async () => {
		const reauthorize = reauthorizer('https://never.test');
		const host = groupHost({ '3lmeeting': MEETING_CID });
		const member = pds.session(GRANTED);

		// An older version's cid, no cid at all, and an empty one.
		for (const cid of ['bafyreimeetingolder', null, '']) {
			expect(await putMembersOnlyRsvp({ ...rsvpInput(member, host, reauthorize), cid })).toEqual({
				ok: false,
				reason: 'changed',
				message: RSVP_EVENT_CHANGED
			});
		}
		// Each press read the event as the group, and nothing was written, sent
		// from the member's session, or retried through re-authorization.
		expect(sequence).toEqual(
			Array(3).fill(`group get ${CALENDAR} ${GROUP_DID} ${EVENT} 3lmeeting`)
		);
		expect(pds.calls).toEqual([]);
		expect(pds.records.size).toBe(0);
		expect(reauthorize).not.toHaveBeenCalled();
	});

	it('an RSVP to a key the calendar space holds no event at writes nothing', async () => {
		const host = groupHost({ '3lmeeting': MEETING_CID });
		const member = pds.session(GRANTED);

		const put = await putMembersOnlyRsvp({ ...rsvpInput(member, host), rkey: '3lgone' });

		expect(put).toEqual({ ok: false, reason: 'refused', message: RSVP_NO_EVENT });
		expect(sequence).toEqual([`group get ${CALENDAR} ${GROUP_DID} ${EVENT} 3lgone`]);

		// A key no record can have names no event, and the host is not asked.
		sequence.length = 0;
		expect(
			await putMembersOnlyRsvp({ ...rsvpInput(member, host), rkey: 'not a key/../x' })
		).toEqual({ ok: false, reason: 'refused', message: RSVP_NO_EVENT });
		expect(sequence).toEqual([]);

		expect(pds.calls).toEqual([]);
		expect(pds.records.size).toBe(0);
	});

	it('an event read that fails, or a group with no session, writes nothing and says to try again', async () => {
		const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
		const member = pds.session(GRANTED);
		const failing = groupHost();
		failing.get = async () => {
			throw new Error('com.atproto.space.getRecord failed: 502');
		};
		// A host that answers the event without a cid gives the RSVP nothing to cite.
		const noCid = groupHost({ '3lmeeting': '' });

		const unlinked = rsvpInput(member);
		unlinked.groupReader.mockResolvedValue(null);
		for (const input of [
			unlinked,
			rsvpInput(member, failing),
			{ ...rsvpInput(member, noCid), cid: '' }
		]) {
			expect(await putMembersOnlyRsvp(input)).toEqual({
				ok: false,
				reason: 'retry-later',
				message: RSVP_RETRY_LATER
			});
		}
		expect(pds.calls).toEqual([]);
		expect(logged).toHaveBeenCalled();
	});
});

describe('who sends nothing', () => {
	it('a caller off the roster sends no RSVP request', async () => {
		const reauthorize = reauthorizer('https://pds.test/oauth/authorize?request_uri=urn:x');
		// A session that holds the grant, so the roster is the only thing that
		// stops it, with and without a marker that would count.
		for (const asked of [null, await markerFromServer()]) {
			const member = pds.session(GRANTED);
			const cancel = { ...target(member, reauthorize), membership: offRoster, asked };
			const put = { ...rsvpInput(member, groupHost(), reauthorize), membership: offRoster, asked };
			expect(await putMembersOnlyRsvp(put)).toEqual({ ok: false, reason: 'not-member' });
			expect(await deleteMembersOnlyRsvp(cancel)).toEqual({ ok: false, reason: 'not-member' });
			expect(await readOwnMembersOnlyRsvp(offRoster, group, member, '3lmeeting')).toBeNull();
			expect(put.groupReader).not.toHaveBeenCalled();
		}
		expect(pds.calls).toEqual([]);
		expect(sequence).toEqual([]);
		expect(reauthorize).not.toHaveBeenCalled();
	});

	it('a member whose session lacks the RSVP grant is sent to re-authorize', async () => {
		const url = 'https://pds.test/oauth/authorize?request_uri=urn:ietf:params:oauth:request_uri:x';
		// A session granted before RSVPs joined the grant, one whose PDS dropped
		// the grant, and no session at all.
		for (const member of [pds.session(ACCEPTANCE_ONLY), pds.session(BASE_SCOPE), null]) {
			const putting = reauthorizer(url);
			const put = rsvpInput(member, groupHost(), putting);
			const first = await putMembersOnlyRsvp(put);
			expect(first).toEqual({ ok: false, reason: 'reauthorize', url, marker: expect.any(String) });
			expect(putting).toHaveBeenCalledTimes(1);
			expect(put.groupReader).not.toHaveBeenCalled();

			const cancelling = reauthorizer(url);
			const cancel = await deleteMembersOnlyRsvp(target(member, cancelling));
			expect(cancel).toEqual({ ok: false, reason: 'reauthorize', url, marker: expect.any(String) });
			expect(cancelling).toHaveBeenCalledTimes(1);
			// The page carries the marker through consent and back. It is made for
			// this member and this session, and the same for both buttons.
			expect(cancel).toEqual(first);
		}
		// Re-authorizing is the page's to do: nothing went to the member's PDS.
		expect(pds.calls).toEqual([]);
	});

	it('after a re-authorization that asked for it, a session still without the grant gets the no-spaces message and sends nothing', async () => {
		const url = 'https://pds.test/oauth/authorize?request_uri=urn:x';
		for (const scope of [BASE_SCOPE, ACCEPTANCE_ONLY]) {
			// The first press, under the session the member had, is sent to
			// re-authorize with a marker for the page to carry.
			const first = await putMembersOnlyRsvp(
				rsvpInput(pds.session(scope), groupHost(), reauthorizer(url))
			);
			expect(first).toMatchObject({ ok: false, reason: 'reauthorize', url });
			const marker = (first as { marker: string }).marker;

			// Back with a session issued since, still without the grant.
			const reauthorize = reauthorizer(url);
			const member = pds.session(scope);
			const after = { stamp: NEXT_SESSION, asked: marker };
			expect(
				await putMembersOnlyRsvp({ ...rsvpInput(member, groupHost(), reauthorize), ...after })
			).toEqual({
				ok: false,
				reason: 'no-spaces',
				message: RSVP_NO_SPACES
			});
			expect(await deleteMembersOnlyRsvp({ ...target(member, reauthorize), ...after })).toEqual({
				ok: false,
				reason: 'no-spaces',
				message: RSVP_NO_SPACES
			});
			// No second trip through consent.
			expect(reauthorize).not.toHaveBeenCalled();
		}
		expect(pds.calls).toEqual([]);

		// Without that marker, a re-authorization that came back with no URL (an
		// invalid_scope on every grant set) says to try again shortly instead.
		const refused = reauthorizer(null);
		expect(
			await putMembersOnlyRsvp(rsvpInput(pds.session(BASE_SCOPE), groupHost(), refused))
		).toEqual({
			ok: false,
			reason: 'retry-later',
			message: RSVP_RETRY_LATER
		});
		expect(refused).toHaveBeenCalledTimes(1);
		expect(pds.calls).toEqual([]);
	});

	// The marker names the member it was made for. One made for someone else, as
	// a shared link would carry it, says nothing about this member's trip
	// through consent, so they are sent to re-authorize like anyone without the
	// grant, not told their PDS can't do it.
	it('a marker made for another member counts for nothing, and the member is sent to re-authorize', async () => {
		const url = 'https://pds.test/oauth/authorize?request_uri=urn:x';
		const theirs = await deleteMembersOnlyRsvp({
			...target(null, reauthorizer('https://consent.test')),
			callerDid: ANOTHER_MEMBER,
			stamp: SESSION - 1
		});
		const reauthorize = reauthorizer(url);

		const answer = await putMembersOnlyRsvp({
			...rsvpInput(pds.session(BASE_SCOPE), groupHost(), reauthorize),
			asked: (theirs as { marker: string }).marker
		});

		expect(answer).toMatchObject({ ok: false, reason: 'reauthorize', url });
		expect(reauthorize).toHaveBeenCalledTimes(1);
		expect(pds.calls).toEqual([]);
	});
});

describe('a refusal', () => {
	it('a refused space write is reported, and nothing retries it as a public record', async () => {
		const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
		const reauthorize = reauthorizer('https://never.test');
		const member = pds.session(GRANTED);

		pds.refuseWrites = Response.json(
			{ error: 'ScopeMissingError', message: 'Missing required scope' },
			{ status: 403 }
		);
		const put = await putMembersOnlyRsvp(rsvpInput(member, groupHost(), reauthorize));
		expect(put).toEqual({ ok: false, reason: 'refused', message: RSVP_REFUSED });
		const cancel = await deleteMembersOnlyRsvp(target(member, reauthorize));
		expect(cancel).toEqual({ ok: false, reason: 'refused', message: RSVP_REFUSED });

		// One attempt each, in the space, and nothing in its place: no second try,
		// no public write, no re-authorization.
		expect(pds.calls.map((c) => c.nsid)).toEqual([
			'com.atproto.space.putRecord',
			'com.atproto.space.deleteRecord'
		]);
		expect(pds.records.size).toBe(0);
		expect(reauthorize).not.toHaveBeenCalled();
		expect(logged).toHaveBeenCalledTimes(2);

		// A request that never got an answer is a refusal too, and is not retried.
		logged.mockClear();
		pds.calls.length = 0;
		const unreachable: MemberSession = {
			did: MEMBER,
			scope: GRANTED,
			handle: async (pathname, init) => {
				pds.calls.push({ method: init.method ?? 'GET', nsid: pathname, body: null, query: {} });
				throw new Error('fetch failed');
			}
		};
		expect(await putMembersOnlyRsvp(rsvpInput(unreachable, groupHost(), reauthorize))).toEqual({
			ok: false,
			reason: 'refused',
			message: RSVP_REFUSED
		});
		expect(pds.calls.map((c) => c.nsid)).toEqual(['/xrpc/com.atproto.space.putRecord']);
		expect(logged).toHaveBeenCalledTimes(1);
	});
});

describe('readOwnMembersOnlyRsvp', () => {
	// A record at the key that names some other event, or no status this page
	// knows, is not an RSVP to this event.
	it('reads a record at the key that names another event, or an unknown status, as no RSVP', async () => {
		const member = pds.session(GRANTED);
		pds.records.set(`${CALENDAR}|${RSVP}|3lmeeting`, {
			$type: RSVP,
			status: `${RSVP}#going`,
			subject: { uri: `at://${GROUP_DID}/community.lexicon.calendar.event/3lmeeting` }
		});
		expect(await readOwnMembersOnlyRsvp(onRoster, group, member, '3lmeeting')).toBeNull();
		pds.records.set(`${CALENDAR}|${RSVP}|3lmeeting`, {
			$type: RSVP,
			status: `${RSVP}#maybe`,
			subject: { uri: MEETING_URI }
		});
		expect(await readOwnMembersOnlyRsvp(onRoster, group, member, '3lmeeting')).toBeNull();
	});

	it('reads a failed read as no RSVP and logs it, and sends nothing without a session that can read', async () => {
		const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
		const failing: MemberSession = {
			did: MEMBER,
			scope: GRANTED,
			handle: async () => Response.json({ error: 'InternalServerError' }, { status: 500 })
		};
		expect(await readOwnMembersOnlyRsvp(onRoster, group, failing, '3lmeeting')).toBeNull();
		const throwing: MemberSession = {
			...failing,
			handle: async () => {
				throw new Error('fetch failed');
			}
		};
		expect(await readOwnMembersOnlyRsvp(onRoster, group, throwing, '3lmeeting')).toBeNull();
		expect(logged).toHaveBeenCalledTimes(2);

		// No session, or one without the read grant: no RSVP, and no request.
		expect(await readOwnMembersOnlyRsvp(onRoster, group, null, '3lmeeting')).toBeNull();
		expect(
			await readOwnMembersOnlyRsvp(onRoster, group, pds.session(ACCEPTANCE_ONLY), '3lmeeting')
		).toBeNull();
		expect(pds.calls).toEqual([]);
	});
});
