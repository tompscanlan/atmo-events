// A group's calendar space at its group host, for tests: the group's session, which writes as the
// group, a member's session at their own PDS, and the host's credential and its reads, which a test
// routes its network through. The host gives a credential only to a holder the test lets read.
import { fakeKemHost } from '#lib/spaces/server/__fixtures__/space-mac-host.js';
import type { SpaceHosts } from '#lib/spaces/server/space-credential.js';
import type { XrpcHandle } from '../xrpc';

export const GROUP = 'did:plc:group';
export const CALENDAR = `at:space/${GROUP}/community.lexicon.calendar.collection/self`;
const EVENT = 'community.lexicon.calendar.event';
const RSVP = 'community.lexicon.calendar.rsvp';
const HOST = 'https://host.example';

const kem = await fakeKemHost();

type Body = Record<string, unknown>;
const fail = (status: number, error: string) => Response.json({ error }, { status });

export function fakeCalendar() {
	const state = {
		/** The space's policy as kept, or null while there is no space. */
		policy: null as Body | null,
		/** The group's events in the space, by key. */
		events: new Map<string, Body>(),
		/** The group's public repo, by key. */
		publicRepo: new Map<string, Body>(),
		/** Members' RSVPs in the space, by `<did>/<rkey>`. */
		rsvps: new Map<string, Body>(),
		/** Who the host gives a credential: `group`, or a person's DID. */
		readers: new Set<string>(),
		/** Every call made as the group or a person, as `[who, nsid, body or query]`. */
		sent: [] as [string, string, Body][],
		/** What the next call as the group answers instead, by method. */
		refuse: new Map<string, Response>()
	};

	const pds =
		(who: string): XrpcHandle =>
		async (pathname, init) => {
			const url = new URL(pathname, 'https://pds.example');
			const nsid = url.pathname.replace('/xrpc/', '');
			const body: Body = init.body
				? JSON.parse(String(init.body))
				: Object.fromEntries(url.searchParams);
			state.sent.push([who, nsid, body]);
			const refused = state.refuse.get(nsid);
			if (refused) return refused;
			if (nsid === 'com.atproto.space.getDelegationToken') {
				return Response.json({ token: `delegation:${who}` });
			}
			if (who !== 'group') {
				const key = `${who}/${body.rkey}`;
				if (body.space !== CALENDAR || body.repo !== who) return fail(400, 'InvalidRequest');
				if (nsid === 'com.atproto.space.putRecord') state.rsvps.set(key, body.record as Body);
				else if (nsid === 'com.atproto.space.deleteRecord') state.rsvps.delete(key);
				return Response.json({});
			}
			const rkey = String(body.rkey ?? '');
			switch (nsid) {
				case 'com.atproto.space.getSpace':
					return state.policy
						? Response.json({ space: body.space, policy: state.policy })
						: fail(400, 'SpaceNotFound');
				case 'com.atproto.space.createSpace':
					if (state.policy) return fail(400, 'SpaceAlreadyExists');
					state.policy = body.policy as Body;
					return Response.json({ space: CALENDAR });
				case 'com.atproto.space.putRecord':
					state.events.set(rkey, body.record as Body);
					return Response.json({ uri: `${CALENDAR}/${GROUP}/${EVENT}/${rkey}`, cid: 'cid' });
				case 'com.atproto.space.deleteRecord':
					state.events.delete(rkey);
					return Response.json({});
				case 'com.atproto.repo.getRecord': {
					const value = state.publicRepo.get(rkey);
					return value
						? Response.json({ uri: `at://${GROUP}/${EVENT}/${rkey}`, cid: 'c', value })
						: fail(400, 'RecordNotFound');
				}
				case 'com.atproto.repo.putRecord':
					state.publicRepo.set(rkey, body.record as Body);
					return Response.json({ uri: `at://${GROUP}/${EVENT}/${rkey}`, cid: 'c' });
				default:
					return fail(400, 'InvalidRequest');
			}
		};

	/** The host's side of a credential and the reads made with it. */
	async function fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
		const url = new URL(String(input));
		if (url.pathname.endsWith('authorizeSpaceSync')) {
			const { delegationToken, space } = JSON.parse(String(init?.body)) as Body;
			const who = String(delegationToken).replace('delegation:', '');
			if (!state.policy || space !== CALENDAR) return fail(400, 'SpaceNotFound');
			if (!state.readers.has(who)) return fail(403, 'NotAuthorized');
			return Response.json({ credential: `credential:${who}` });
		}
		const q = url.searchParams;
		if (url.pathname.endsWith('listRecords')) {
			const records = [...state.events].map(([rkey, value]) => ({
				collection: EVENT,
				rkey,
				cid: `cid-${rkey}`,
				value
			}));
			return Response.json({ records, cursor: null });
		}
		if (url.pathname.endsWith('getRecord')) {
			const repo = q.get('repo')!;
			const rkey = q.get('rkey')!;
			const value =
				repo === GROUP && q.get('collection') === EVENT
					? state.events.get(rkey)
					: q.get('collection') === RSVP
						? state.rsvps.get(`${repo}/${rkey}`)
						: undefined;
			if (!value) return fail(400, 'RecordNotFound');
			const uri = `${q.get('space')}/${repo}/${q.get('collection')}/${rkey}`;
			const answered = await kem.recordAnswer(new Headers(init?.headers), { uri, cid: 'c', value });
			return Response.json({ uri, cid: answered.cid, value }, { headers: answered.headers });
		}
		return fail(404, 'NotFound');
	}

	return {
		state,
		groupHandle: pds('group'),
		personHandle: (did: string) => pds(did),
		fetch
	};
}

export const calendarHosts: SpaceHosts = {
	repoHost: async () => HOST,
	kemKey: async () => kem.did
};

/** The calendar space's policy as the host keeps it once turned on. */
export const READY_POLICY = {
	$type: 'org.atgrp.policy',
	publicRead: false,
	grants: [{ role: 'member', read: true, write: true }]
};

export const event = (name: string, startsAt = '2099-01-01T18:00:00.000Z') => ({
	$type: EVENT,
	name,
	createdAt: '2026-11-01T00:00:00.000Z',
	startsAt
});
