// A group's calendar space at its group host, for tests: the group's session, which writes as the
// group, a member's session at their own PDS, and the host's credential and its reads, which a test
// routes its network through. The host gives a credential only to a holder the test lets read.
// Beside the group's own `self` calendar, it may have others another app made, and an index of
// them in its members space, as the group host keeps one.
import { fakeKemHost } from '#lib/spaces/server/__fixtures__/space-mac-host.js';
import type { SpaceHosts } from '#lib/spaces/server/space-credential.js';
import { GROUP_META_READ_SCOPE, MEMBERS_ONLY_SCOPES } from '../../scopes';
import type { XrpcHandle } from '../xrpc';

export const GROUP = 'did:plc:group';
/** The group's calendar space at `skey`. */
export const calendarAt = (skey: string) =>
	`at:space/${GROUP}/community.lexicon.calendar.collection/${skey}`;
export const CALENDAR = calendarAt('self');
export const MEMBERS = `at:space/${GROUP}/org.atgrp.members/self`;
const EVENT = 'community.lexicon.calendar.event';
const RSVP = 'community.lexicon.calendar.rsvp';
const INDEX = 'org.atgrp.space';
const POLICY = 'com.atproto.space.policy';
const HOST = 'https://host.example';

/** A calendar space as the host keeps it: its policy, the group's events there, and the group's
 *  other records there, by key, as another app may write them. */
export interface FakeSpace {
	policy: Body | null;
	events: Map<string, Body>;
	others: Map<string, { collection: string; value: Body }>;
}

const kem = await fakeKemHost();

type Body = Record<string, unknown>;
const fail = (status: number, error: string) => Response.json({ error }, { status });

/** The scope a group host grants a session as the group, from what this site asks for: its
 *  `authority=self` made the group's DID, as the host makes it. */
export const grantedAsGroup = (asked: string) =>
	asked.replaceAll('authority=self', `authority=${GROUP}`);

/** As the group host reads a session's scope for a space (`at:space/<did>/<type>/<skey>`): a
 *  `space:` scope of its type or any, for its authority (none is the group's own) or any, at its
 *  key or any (none is any), granting `action`, every one when it names none. A read is never
 *  limited by the collections a scope names. `manage` asks for that instead of an action. */
export function scopeHolds(
	scope: string,
	space: string,
	want: { action?: string; manage?: string }
) {
	const [authority, type, skey] = space.replace('at:space/', '').split('/');
	return scope.split(' ').some((token) => {
		if (!token.startsWith('space:')) return false;
		const at = token.indexOf('?');
		const kind = token.slice('space:'.length, at === -1 ? undefined : at);
		const params = new URLSearchParams(at === -1 ? '' : token.slice(at + 1));
		const by = params.get('authority') ?? 'self';
		const actions = params.getAll('action');
		const granted = actions.length > 0 ? actions : ['read', 'create', 'update', 'delete'];
		const holds = want.manage
			? params.getAll('manage').includes(want.manage)
			: granted.includes(want.action!) || (want.action === 'read_self' && granted.includes('read'));
		return (
			[type, '*'].includes(kind) &&
			[authority, '*'].includes(by === 'self' ? GROUP : by) &&
			[skey, '*'].includes(params.get('skey') ?? '*') &&
			holds
		);
	});
}

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
		/** The group's other records in the `self` space. */
		others: new Map<string, { collection: string; value: Body }>(),
		/** The group's calendar spaces but `self`, by URI. */
		spaces: new Map<string, FakeSpace>(),
		/** The group's index of its spaces, in its members space: `org.atgrp.space` records. */
		index: [] as { space: string; createdAt: string }[],
		/** The scope the host granted the group's session: by default the space scopes this site
		 *  asks a group's session for (../sign-in.ts), as an admin's approval keeps them. The host
		 *  gives the session no delegation token for a space its scope does not read, nor that
		 *  space's policy, and makes no space it does not manage. */
		groupScope: grantedAsGroup([GROUP_META_READ_SCOPE, ...MEMBERS_ONLY_SCOPES].join(' ')),
		/** Who the host gives a credential for the members space, where the index is, as their roles
		 *  read it: the group's session for the member who approved it, or a person's DID. */
		indexReaders: new Set<string>(['group']),
		/** Who the host gives a credential for a calendar space: `group`, or a person's DID. */
		readers: new Set<string>(),
		/** Every call made as the group or a person, as `[who, nsid, body or query]`. */
		sent: [] as [string, string, Body][],
		/** What the next call as the group answers instead, by method. */
		refuse: new Map<string, Response>()
	};

	/** The calendar space at `uri`, while there is one. */
	const spaceAt = (uri: unknown): FakeSpace | null => {
		const space =
			uri === CALENDAR
				? { policy: state.policy, events: state.events, others: state.others }
				: state.spaces.get(String(uri));
		return space?.policy ? space : null;
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
				if (
					who === 'group' &&
					!scopeHolds(state.groupScope, String(body.space), { action: 'read' })
				)
					return fail(403, 'ScopeMissing');
				return Response.json({ token: `delegation:${who}` });
			}
			if (who !== 'group') {
				const key = `${who}/${body.rkey}`;
				if (!spaceAt(body.space) || body.repo !== who) return fail(400, 'InvalidRequest');
				if (nsid === 'com.atproto.space.putRecord') state.rsvps.set(key, body.record as Body);
				else if (nsid === 'com.atproto.space.deleteRecord') state.rsvps.delete(key);
				return Response.json({});
			}
			const rkey = String(body.rkey ?? '');
			switch (nsid) {
				case 'com.atproto.space.getSpace': {
					const space = spaceAt(body.space);
					if (space && !scopeHolds(state.groupScope, String(body.space), { action: 'read_self' }))
						return fail(403, 'ScopeMissing');
					return space
						? Response.json({ space: body.space, policy: space.policy })
						: fail(400, 'SpaceNotFound');
				}
				case 'com.atproto.space.createSpace': {
					const uri = calendarAt(String(body.skey ?? '3lmadehere'));
					if (!scopeHolds(state.groupScope, uri, { manage: 'create' }))
						return fail(403, 'ScopeMissing');
					if (spaceAt(uri)) return fail(400, 'SpaceAlreadyExists');
					if (uri === CALENDAR) state.policy = body.policy as Body;
					else
						state.spaces.set(uri, {
							policy: body.policy as Body,
							events: new Map(),
							others: new Map()
						});
					return Response.json({ space: uri });
				}
				case 'com.atproto.space.putRecord': {
					const space = spaceAt(body.space);
					if (!space) return fail(400, 'InvalidRequest');
					space.events.set(rkey, body.record as Body);
					return Response.json({ uri: `${body.space}/${GROUP}/${EVENT}/${rkey}`, cid: 'cid' });
				}
				case 'com.atproto.space.deleteRecord':
					spaceAt(body.space)?.events.delete(rkey);
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
			if (space === MEMBERS) {
				if (!state.indexReaders.has(who)) return fail(403, 'NotAuthorized');
				return Response.json({ credential: `credential:${who}` });
			}
			if (!spaceAt(space)) return fail(400, 'SpaceNotFound');
			if (!state.readers.has(who)) return fail(403, 'NotAuthorized');
			return Response.json({ credential: `credential:${who}` });
		}
		const q = url.searchParams;
		if (url.pathname.endsWith('listRecords')) {
			if (q.get('space') === MEMBERS) {
				const records = state.index.map((entry, i) => ({
					collection: INDEX,
					rkey: `3lindex${i}`,
					cid: `cid-index-${i}`,
					value: { $type: INDEX, ...entry }
				}));
				return Response.json({ records, cursor: null });
			}
			// Every record the group has there, whatever collection was asked for.
			const space = spaceAt(q.get('space'));
			const records = [
				...[...(space?.events ?? [])].map(([rkey, value]) => ({ collection: EVENT, rkey, value })),
				...[...(space?.others ?? [])].map(([rkey, other]) => ({ rkey, ...other }))
			].map((record) => ({ ...record, cid: `cid-${record.rkey}` }));
			return Response.json({ records, cursor: null });
		}
		if (url.pathname.endsWith('getRecord')) {
			const repo = q.get('repo')!;
			const rkey = q.get('rkey')!;
			const policy = spaceAt(q.get('space'))?.policy;
			const value =
				repo === GROUP && q.get('collection') === EVENT
					? spaceAt(q.get('space'))?.events.get(rkey)
					: q.get('collection') === RSVP
						? state.rsvps.get(`${repo}/${rkey}`)
						: // The space's policy, as the host publishes it there as the group's.
							repo === GROUP && q.get('collection') === POLICY && rkey === 'self' && policy
							? { $type: POLICY, policy }
							: undefined;
			if (!value) return fail(400, 'RecordNotFound');
			const uri = `${q.get('space')}/${repo}/${q.get('collection')}/${rkey}`;
			const answered = await kem.recordAnswer(new Headers(init?.headers), { uri, cid: 'c', value });
			return Response.json({ uri, cid: answered.cid, value }, { headers: answered.headers });
		}
		return fail(404, 'NotFound');
	}

	/** A calendar space another app made the group under `policy`, at `skey`, and listed in its
	 *  index at `createdAt`. */
	function anotherAppsCalendar(skey: string, policy: Body, createdAt = '2026-10-01T00:00:00.000Z') {
		const uri = calendarAt(skey);
		const space = { policy, events: new Map(), others: new Map() };
		if (uri === CALENDAR) state.policy = policy;
		else state.spaces.set(uri, space);
		state.index.push({ space: uri, createdAt });
		return uri === CALENDAR ? spaceAt(uri)! : space;
	}

	return {
		state,
		anotherAppsCalendar,
		groupHandle: pds('group'),
		personHandle: (did: string) => pds(did),
		fetch
	};
}

export const calendarHosts: SpaceHosts = {
	repoHost: async () => HOST,
	kemKey: async () => kem.did
};

/** The calendar space's policy as the host keeps it once turned on: admins post its events as the
 *  group, and members read it. */
export const READY_POLICY = {
	$type: 'org.atgrp.policy',
	publicRead: false,
	grants: [
		{
			role: 'admin',
			permissions: [`space:community.lexicon.calendar.collection?collection=${EVENT}`]
		},
		{ role: 'member', read: true }
	]
};

export const event = (name: string, startsAt = '2099-01-01T18:00:00.000Z') => ({
	$type: EVENT,
	name,
	createdAt: '2026-11-01T00:00:00.000Z',
	startsAt
});
