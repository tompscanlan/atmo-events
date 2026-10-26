// A member's RSVP to a members-only event: what is written where, and every way it is not.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GroupSpaceReader, GroupSpaceRecord } from './about-read';
import type { CallerSession } from './caller';
import { holdsRsvpGrant } from './member-grants';
import {
	RSVP_EVENT_CHANGED,
	RSVP_NO_EVENT,
	RSVP_NO_SPACES,
	RSVP_REFUSED,
	RSVP_RETRY_LATER,
	deleteMembersOnlyRsvp,
	putMembersOnlyRsvp,
	readOwnMembersOnlyRsvp,
	type MembersOnlyRsvpInput
} from './member-rsvp';
import { CALENDAR_RSVP_SCOPE } from './sign-in-grants';
import { NO_GRANTS } from '../scopes';
import type { CallerMembership } from '../types';

const GROUP_DID = 'did:plc:jcwgw6fcnb5vyoid7nz7sl26';
const MEMBER = 'did:plc:hkymspvcjhy6sbujuydfj7sv';
const CALENDAR = `at://${GROUP_DID}/space/rsvp.atmo.group.calendar/self`;
const EVENT = 'community.lexicon.calendar.event';
const RSVP = 'community.lexicon.calendar.rsvp';
const EVENT_URI = `${CALENDAR}/${GROUP_DID}/${EVENT}/3lmeeting`;
const GRANTED = `atproto ${CALENDAR_RSVP_SCOPE}`;

const MEETING: GroupSpaceRecord = {
	uri: EVENT_URI,
	cid: 'bafymeeting',
	collection: EVENT,
	rkey: '3lmeeting',
	value: { $type: EVENT, name: 'Committee call', startsAt: '2026-11-02T18:00:00.000Z' }
};

const membership = (onRoster: boolean): CallerMembership => ({
	did: MEMBER,
	role: onRoster ? 'member' : null,
	pendingRequestId: null,
	permissions: new Set(),
	grants: NO_GRANTS,
	onRoster
});

let calls: { nsid: string; body?: unknown; query?: Record<string, string> }[];
let answer: Response | null;

function session(scope: string): CallerSession {
	return {
		did: MEMBER,
		scope,
		async handle(pathname, init) {
			const url = new URL(pathname, 'https://pds.test');
			calls.push({
				nsid: url.pathname.slice('/xrpc/'.length),
				...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
				...(url.search ? { query: Object.fromEntries(url.searchParams) } : {})
			});
			return answer ?? Response.json({ uri: 'at://written', cid: 'bafyrsvp' });
		}
	};
}

const reader = (records: GroupSpaceRecord[]): GroupSpaceReader => ({
	get: async (q) => records.find((r) => r.collection === q.collection && r.rkey === q.rkey) ?? null,
	list: async () => records
});

function input(overrides: Partial<MembersOnlyRsvpInput> = {}): MembersOnlyRsvpInput {
	return {
		membership: membership(true),
		group: { group_did: GROUP_DID },
		member: session(GRANTED),
		rkey: '3lmeeting',
		reauthorized: false,
		reauthorize: async () => 'https://pds.test/oauth/authorize?again',
		status: 'going',
		cid: 'bafymeeting',
		reader: async () => reader([MEETING]),
		...overrides
	};
}

beforeEach(() => {
	calls = [];
	answer = null;
	vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('holdsRsvpGrant', () => {
	it("takes sign-in's grant for any group, by the calendar type and the RSVP collection", () => {
		expect(holdsRsvpGrant(GRANTED, GROUP_DID, 'create')).toBe(true);
		expect(holdsRsvpGrant(GRANTED, GROUP_DID, 'read')).toBe(true);
		const other = `space:rsvp.atmo.group.calendar?authority=*&collection=${EVENT}&action=create`;
		expect(holdsRsvpGrant(other, GROUP_DID, 'create')).toBe(false);
		expect(holdsRsvpGrant('atproto', GROUP_DID, 'create')).toBe(false);
	});
});

describe('putMembersOnlyRsvp', () => {
	it("writes into the member's own repo in the calendar space, citing the event's space URI and cid", async () => {
		expect(await putMembersOnlyRsvp(input())).toEqual({ ok: true, uri: 'at://written' });
		expect(calls).toEqual([
			{
				nsid: 'com.atproto.space.putRecord',
				body: {
					space: CALENDAR,
					repo: MEMBER,
					collection: RSVP,
					rkey: '3lmeeting',
					record: {
						$type: RSVP,
						status: `${RSVP}#going`,
						subject: { uri: EVENT_URI, cid: 'bafymeeting' },
						createdAt: expect.any(String)
					}
				}
			}
		]);
	});

	it('sends nothing for a caller off the roster', async () => {
		expect(await putMembersOnlyRsvp(input({ membership: membership(false) }))).toEqual({
			ok: false,
			reason: 'not-member'
		});
		expect(calls).toEqual([]);
	});

	it('sends a member without the grant to sign in again once, then says their PDS cannot', async () => {
		const without = session('atproto');
		expect(await putMembersOnlyRsvp(input({ member: without }))).toEqual({
			ok: false,
			reason: 'reauthorize',
			url: 'https://pds.test/oauth/authorize?again'
		});
		expect(await putMembersOnlyRsvp(input({ member: without, reauthorized: true }))).toEqual({
			ok: false,
			reason: 'no-spaces',
			message: RSVP_NO_SPACES
		});
		expect(
			await putMembersOnlyRsvp(input({ member: without, reauthorize: async () => null }))
		).toEqual({
			ok: false,
			reason: 'retry-later',
			message: RSVP_RETRY_LATER
		});
		expect(calls).toEqual([]);
	});

	it('saves nothing for an event that changed since the page showed it, or is gone', async () => {
		expect(await putMembersOnlyRsvp(input({ cid: 'bafyolder' }))).toEqual({
			ok: false,
			reason: 'changed',
			message: RSVP_EVENT_CHANGED
		});
		expect(await putMembersOnlyRsvp(input({ reader: async () => reader([]) }))).toEqual({
			ok: false,
			reason: 'refused',
			message: RSVP_NO_EVENT
		});
		expect(calls).toEqual([]);
	});

	it('tells the member when their PDS refuses the write', async () => {
		answer = Response.json({ error: 'InvalidRequest' }, { status: 400 });
		expect(await putMembersOnlyRsvp(input())).toEqual({
			ok: false,
			reason: 'refused',
			message: RSVP_REFUSED
		});
	});
});

describe('deleteMembersOnlyRsvp', () => {
	it('deletes the RSVP at the event key, reading no event', async () => {
		expect(await deleteMembersOnlyRsvp(input())).toEqual({ ok: true });
		expect(calls).toEqual([
			{
				nsid: 'com.atproto.space.deleteRecord',
				body: { space: CALENDAR, repo: MEMBER, collection: RSVP, rkey: '3lmeeting' }
			}
		]);
	});
});

describe('readOwnMembersOnlyRsvp', () => {
	const read = (member: CallerSession | null) =>
		readOwnMembersOnlyRsvp(membership(true), { group_did: GROUP_DID }, member, '3lmeeting');

	it("reads the member's answer to this event", async () => {
		answer = Response.json({
			value: { status: `${RSVP}#interested`, subject: { uri: EVENT_URI, cid: 'bafymeeting' } }
		});
		expect(await read(session(GRANTED))).toEqual({ status: 'interested', rkey: '3lmeeting' });
		expect(calls[0]).toMatchObject({ nsid: 'com.atproto.space.getRecord' });
	});

	it('shows none for another subject, a missing record, or a session without the grant', async () => {
		answer = Response.json({ value: { status: `${RSVP}#going`, subject: { uri: 'at://else' } } });
		expect(await read(session(GRANTED))).toBeNull();
		answer = Response.json({ error: 'RecordNotFound' }, { status: 400 });
		expect(await read(session(GRANTED))).toBeNull();
		calls = [];
		expect(await read(session('atproto'))).toBeNull();
		expect(calls).toEqual([]);
	});
});
