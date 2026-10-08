// A member's RSVP to a members-only event, written from their own session into
// the group's calendar space, in their own repo there. Never into their public
// repo, and nothing falls back to one. (Spec: FR-113, FR-114.)
//
// The member's PDS is a fake that answers the way the spaces PDS does: a put
// creates or replaces the record at its key, a delete succeeds whether or not
// the record was there, and a read of a missing record is 400 RecordNotFound.
// Each case asserts every request the member's session sent, so "sent nothing"
// is a count, not a reading of the result.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CallerMembership, GroupRow } from '../types';
import type { MemberSession } from './acceptance';
import { acceptanceGrant } from './member-grants';
import {
	RSVP_NO_SPACES,
	RSVP_RETRY_LATER,
	deleteMembersOnlyRsvp,
	putMembersOnlyRsvp,
	readOwnMembersOnlyRsvp
} from './member-rsvp';

const MEMBER = 'did:plc:hkymspvcjhy6sbujuydfj7sv';
const GROUP_DID = 'did:plc:jcwgw6fcnb5vyoid7nz7sl26';
// Written out, so a wrong type, key or URI form in the code under test fails here.
const CALENDAR = `at://${GROUP_DID}/space/net.openmeet.space.calendar/self`;
const RSVP = 'community.lexicon.calendar.rsvp';
const MEETING_URI = `${CALENDAR}/${GROUP_DID}/community.lexicon.calendar.event/3lmeeting`;
const BASE_SCOPE = 'atproto rpc:app.bsky.actor.getProfile?aud=*';
/** What a sign-in grants today. */
const GRANTED = `${BASE_SCOPE} ${acceptanceGrant(GROUP_DID)}`;
/** What a sign-in granted before RSVPs joined the grant, written out. */
const ACCEPTANCE_ONLY = `${BASE_SCOPE} space:*?authority=${GROUP_DID}&collection=group.opensocial.acceptance&action=create&action=update&action=delete`;

const group = { group_did: GROUP_DID } as GroupRow;

function standing(onRoster: boolean): CallerMembership {
	return {
		did: MEMBER,
		role: onRoster ? 'member' : null,
		status: onRoster ? 'active' : null,
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

/** A reauthorize() that records each call and answers `url`. */
function reauthorizer(url: string | null) {
	const fn = vi.fn(async () => url);
	return fn;
}

let pds: MemberPds;

beforeEach(() => {
	pds = memberPds();
});

afterEach(() => vi.restoreAllMocks());

describe('putMembersOnlyRsvp and deleteMembersOnlyRsvp, for a member holding the grant', () => {
	it("a members-only RSVP is written from the member's session into the calendar space at the event's key", async () => {
		const reauthorize = reauthorizer('https://never.test');
		const member = pds.session(GRANTED);

		const going = await putMembersOnlyRsvp({
			membership: onRoster,
			group,
			member,
			rkey: '3lmeeting',
			status: 'going',
			asked: false,
			reauthorize
		});

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
						subject: { uri: MEETING_URI },
						createdAt: expect.any(String)
					}
				},
				query: {}
			}
		]);
		const record = pds.calls[0].body!.record as { createdAt: string };
		expect(new Date(record.createdAt).toISOString()).toBe(record.createdAt);

		// A change of mind is the same record at the same key, so a member holds
		// one RSVP per event. Whether the page says it asked for the grant changes
		// nothing for a session that holds it.
		const notGoing = await putMembersOnlyRsvp({
			membership: onRoster,
			group,
			member,
			rkey: '3lmeeting',
			status: 'notgoing',
			asked: true,
			reauthorize
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
		const target = {
			membership: onRoster,
			group,
			member,
			rkey: '3lmeeting',
			asked: false,
			reauthorize
		};
		await putMembersOnlyRsvp({ ...target, status: 'interested' });
		expect(await readOwnMembersOnlyRsvp(onRoster, group, member, '3lmeeting')).toEqual({
			status: 'interested',
			rkey: '3lmeeting'
		});
		pds.calls.length = 0;

		expect(await deleteMembersOnlyRsvp(target)).toEqual({ ok: true });

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
		await putMembersOnlyRsvp({ ...target, member: bare, status: 'going' });
		await putMembersOnlyRsvp({ ...target, member: bare, status: 'going', asked: true });
		await deleteMembersOnlyRsvp({ ...target, member: bare });
		await readOwnMembersOnlyRsvp(onRoster, group, bare, '3lmeeting');
		pds.refuseWrites = Response.json({ error: 'InternalServerError' }, { status: 500 });
		vi.spyOn(console, 'error').mockImplementation(() => {});
		await putMembersOnlyRsvp({ ...target, status: 'going' });
		await deleteMembersOnlyRsvp(target);
		expect(pds.calls.length).toBeGreaterThan(0);
		expect(pds.calls.filter((c) => c.nsid.startsWith('com.atproto.repo.'))).toEqual([]);
		expect(pds.calls.every((c) => c.nsid.startsWith('com.atproto.space.'))).toBe(true);
	});
});

describe('who sends nothing', () => {
	it('a caller off the roster sends no RSVP request', async () => {
		const reauthorize = reauthorizer('https://pds.test/oauth/authorize?request_uri=urn:x');
		// A session that holds the grant, so the roster is the only thing that stops it.
		for (const asked of [false, true]) {
			const target = {
				membership: offRoster,
				group,
				member: pds.session(GRANTED),
				rkey: '3lmeeting',
				asked,
				reauthorize
			};
			expect(await putMembersOnlyRsvp({ ...target, status: 'going' })).toEqual({
				ok: false,
				reason: 'not-member'
			});
			expect(await deleteMembersOnlyRsvp(target)).toEqual({ ok: false, reason: 'not-member' });
			expect(await readOwnMembersOnlyRsvp(offRoster, group, target.member, '3lmeeting')).toBeNull();
		}
		expect(pds.calls).toEqual([]);
		expect(reauthorize).not.toHaveBeenCalled();
	});

	it('a member whose session lacks the RSVP grant is sent to re-authorize', async () => {
		const url = 'https://pds.test/oauth/authorize?request_uri=urn:ietf:params:oauth:request_uri:x';
		// A session granted before RSVPs joined the grant, one whose PDS dropped
		// the grant, and no session at all.
		for (const member of [pds.session(ACCEPTANCE_ONLY), pds.session(BASE_SCOPE), null]) {
			const putting = reauthorizer(url);
			expect(
				await putMembersOnlyRsvp({
					membership: onRoster,
					group,
					member,
					rkey: '3lmeeting',
					status: 'going',
					asked: false,
					reauthorize: putting
				})
			).toEqual({ ok: false, reason: 'reauthorize', url });
			expect(putting).toHaveBeenCalledTimes(1);

			const cancelling = reauthorizer(url);
			expect(
				await deleteMembersOnlyRsvp({
					membership: onRoster,
					group,
					member,
					rkey: '3lmeeting',
					asked: false,
					reauthorize: cancelling
				})
			).toEqual({ ok: false, reason: 'reauthorize', url });
			expect(cancelling).toHaveBeenCalledTimes(1);
		}
		// Re-authorizing is the page's to do: nothing went to the member's PDS.
		expect(pds.calls).toEqual([]);
	});

	it('after a re-authorization that asked for it, a session still without the grant gets the no-spaces message and sends nothing', async () => {
		const reauthorize = reauthorizer('https://pds.test/oauth/authorize?request_uri=urn:x');
		for (const member of [pds.session(BASE_SCOPE), pds.session(ACCEPTANCE_ONLY)]) {
			const target = { membership: onRoster, group, member, rkey: '3lmeeting', asked: true };
			expect(await putMembersOnlyRsvp({ ...target, status: 'going', reauthorize })).toEqual({
				ok: false,
				reason: 'no-spaces',
				message: RSVP_NO_SPACES
			});
			expect(await deleteMembersOnlyRsvp({ ...target, reauthorize })).toEqual({
				ok: false,
				reason: 'no-spaces',
				message: RSVP_NO_SPACES
			});
		}
		expect(RSVP_NO_SPACES).toBe(
			"Your PDS can't RSVP to members-only events yet, so nothing was saved."
		);
		// No second trip through consent, and nothing sent.
		expect(reauthorize).not.toHaveBeenCalled();
		expect(pds.calls).toEqual([]);

		// Without that marker, a re-authorization that came back with no URL (an
		// invalid_scope on every grant set) says to try again shortly instead.
		const refused = reauthorizer(null);
		expect(
			await putMembersOnlyRsvp({
				membership: onRoster,
				group,
				member: pds.session(BASE_SCOPE),
				rkey: '3lmeeting',
				status: 'going',
				asked: false,
				reauthorize: refused
			})
		).toEqual({ ok: false, reason: 'retry-later', message: RSVP_RETRY_LATER });
		expect(refused).toHaveBeenCalledTimes(1);
		expect(RSVP_RETRY_LATER).toBe(
			"Your RSVP couldn't be saved just now. Try again in a few minutes."
		);
		expect(pds.calls).toEqual([]);
	});
});

describe('a refusal', () => {
	it('a refused space write is reported, and nothing retries it as a public record', async () => {
		const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
		const reauthorize = reauthorizer('https://never.test');
		const target = {
			membership: onRoster,
			group,
			member: pds.session(GRANTED),
			rkey: '3lmeeting',
			asked: false,
			reauthorize
		};

		pds.refuseWrites = Response.json(
			{ error: 'ScopeMissingError', message: 'Missing required scope' },
			{ status: 403 }
		);
		const put = await putMembersOnlyRsvp({ ...target, status: 'going' });
		expect(put).toEqual({ ok: false, reason: 'refused', message: expect.any(String) });
		expect(put.ok === false && 'message' in put && put.message).not.toBe(RSVP_NO_SPACES);
		const cancel = await deleteMembersOnlyRsvp(target);
		expect(cancel).toEqual({ ok: false, reason: 'refused', message: expect.any(String) });

		// One attempt each, in the space, and nothing in its place: no second try,
		// no public write, no re-authorization.
		expect(pds.calls.map((c) => c.nsid)).toEqual([
			'com.atproto.space.putRecord',
			'com.atproto.space.deleteRecord'
		]);
		expect(pds.records.size).toBe(0);
		expect(reauthorize).not.toHaveBeenCalled();
		// Logged as the group's, with what the PDS said.
		expect(logged).toHaveBeenCalledTimes(2);
		for (const call of logged.mock.calls) {
			expect(call.map(String).join(' ')).toMatch(
				new RegExp(`^\\[groups\\] ${GROUP_DID}: .*403 ScopeMissingError`)
			);
		}

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
		expect(await putMembersOnlyRsvp({ ...target, member: unreachable, status: 'going' })).toEqual({
			ok: false,
			reason: 'refused',
			message: expect.any(String)
		});
		expect(pds.calls.map((c) => c.nsid)).toEqual(['/xrpc/com.atproto.space.putRecord']);
		expect(logged).toHaveBeenCalledTimes(1);
	});
});

describe('readOwnMembersOnlyRsvp', () => {
	it("reads the member's own RSVP by the event's key, and an unreadable one as none", async () => {
		const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
		const member = pds.session(GRANTED);
		pds.records.set(`${CALENDAR}|${RSVP}|3lmeeting`, {
			$type: RSVP,
			status: `${RSVP}#going`,
			subject: { uri: MEETING_URI },
			createdAt: '2026-10-08T12:00:00.000Z'
		});

		expect(await readOwnMembersOnlyRsvp(onRoster, group, member, '3lmeeting')).toEqual({
			status: 'going',
			rkey: '3lmeeting'
		});
		expect(pds.calls).toEqual([
			{
				method: 'GET',
				nsid: 'com.atproto.space.getRecord',
				body: null,
				query: { space: CALENDAR, repo: MEMBER, collection: RSVP, rkey: '3lmeeting' }
			}
		]);
		// No RSVP yet is no RSVP, with nothing logged.
		expect(await readOwnMembersOnlyRsvp(onRoster, group, member, '3lother')).toBeNull();
		expect(logged).not.toHaveBeenCalled();

		// A record at the key that names some other event, or no status this page
		// knows, is not an RSVP to this event.
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

		// Any other failure is no RSVP, logged as the group's.
		pds.calls.length = 0;
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
		expect(String(logged.mock.calls[0][0])).toMatch(new RegExp(`^\\[groups\\] ${GROUP_DID}: `));

		// No session, or one without the read grant: no RSVP, and no request.
		expect(await readOwnMembersOnlyRsvp(onRoster, group, null, '3lmeeting')).toBeNull();
		expect(
			await readOwnMembersOnlyRsvp(onRoster, group, pds.session(ACCEPTANCE_ONLY), '3lmeeting')
		).toBeNull();
		expect(pds.calls).toEqual([]);
	});
});
