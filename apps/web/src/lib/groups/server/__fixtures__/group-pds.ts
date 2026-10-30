// A group's own PDS as this site writes to it as the group: the declaration and public events
// in its repo, the profile and access records in its meta space, and the calendar space with
// its members-only events. It refuses a call naming another repo or another group's space,
// answers a read in a calendar space never made as the PDS does, and keeps the order the
// writes landed in.
import { vi } from 'vitest';
import {
	CALENDAR_SPACE_TYPE,
	calendarSpaceUri,
	GROUP_ACCESS_COLLECTION,
	GROUP_DECLARATION_COLLECTION,
	GROUP_EVENT_COLLECTION,
	GROUP_PROFILE_COLLECTION,
	metaSpaceUri
} from '../../ids';
import type { GroupWriter } from '../context';
import type { XrpcHandle } from '../xrpc';

type Value = Record<string, unknown>;

export interface GroupPdsState {
	profile: Value | null;
	access: Value | null;
	declared: boolean;
	/** The calendar space's access record; null until the space is made. */
	calendar: Value | null;
	/** Public events, by rkey. */
	events: Record<string, Value>;
	/** Members-only events in the calendar space, by rkey. */
	membersEvents: Record<string, Value>;
}

export type GroupPdsWrite =
	| 'profile'
	| 'access'
	| 'declare'
	| 'withdraw'
	| 'calendar'
	| 'event'
	| 'delete event'
	| 'members event'
	| 'delete members event';

export interface GroupPds {
	writer: GroupWriter;
	state: GroupPdsState;
	writes: GroupPdsWrite[];
	/** The next write of this kind answers 500 and changes nothing. */
	failNext: GroupPdsWrite | null;
	/** Runs as each write arrives, before it lands. */
	beforeWrite: (write: GroupPdsWrite) => unknown;
}

const refused = (status: number, error: string) => Response.json({ error }, { status });
const DELETES = ['com.atproto.repo.deleteRecord', 'com.atproto.space.deleteRecord'];

export function groupPds(groupDid: string, initial: Partial<GroupPdsState> = {}): GroupPds {
	const pds: GroupPds = {
		writer: { did: groupDid, handle: vi.fn<XrpcHandle>(answer) },
		state: {
			profile: null,
			access: null,
			declared: false,
			calendar: null,
			events: {},
			membersEvents: {},
			...initial
		},
		writes: [],
		failNext: null,
		beforeWrite: () => {}
	};
	const META = metaSpaceUri(groupDid);
	const CALENDAR = calendarSpaceUri(groupDid);

	/** What a write is, or null for a call this PDS does not take. */
	function writeOf(nsid: string, args: Value): GroupPdsWrite | null {
		const deleting = DELETES.includes(nsid);
		if (nsid === 'group.opensocial.createSpace') return 'calendar';
		if (args.space === META) {
			return args.collection === GROUP_PROFILE_COLLECTION ? 'profile' : 'access';
		}
		if (args.space === CALENDAR && args.collection === GROUP_EVENT_COLLECTION) {
			return deleting ? 'delete members event' : 'members event';
		}
		if (args.space !== undefined) return null;
		if (args.collection === GROUP_DECLARATION_COLLECTION) return deleting ? 'withdraw' : 'declare';
		if (args.collection === GROUP_EVENT_COLLECTION) return deleting ? 'delete event' : 'event';
		return null;
	}

	function read(args: Value): Value | null | 'no-space' {
		const { state } = pds;
		const rkey = String(args.rkey);
		if (args.space === META) {
			return args.collection === GROUP_PROFILE_COLLECTION ? state.profile : state.access;
		}
		if (args.space === CALENDAR) {
			if (!state.calendar) return 'no-space';
			return args.collection === GROUP_ACCESS_COLLECTION
				? state.calendar
				: (state.membersEvents[rkey] ?? null);
		}
		if (args.collection === GROUP_DECLARATION_COLLECTION) {
			return state.declared ? { $type: GROUP_DECLARATION_COLLECTION } : null;
		}
		return state.events[rkey] ?? null;
	}

	function land(write: GroupPdsWrite, args: Value) {
		const { state } = pds;
		const rkey = String(args.rkey);
		const record = (args.record as Value | undefined) ?? null;
		if (write === 'profile') state.profile = record;
		else if (write === 'access') state.access = record;
		else if (write === 'declare' || write === 'withdraw') state.declared = write === 'declare';
		else if (write === 'calendar') state.calendar = args.access as Value;
		else if (write === 'event') state.events[rkey] = record as Value;
		else if (write === 'delete event') delete state.events[rkey];
		else if (write === 'members event') state.membersEvents[rkey] = record as Value;
		else delete state.membersEvents[rkey];
	}

	async function answer(pathname: string, init: RequestInit): Promise<Response> {
		const url = new URL(pathname, 'https://pds.example');
		const nsid = url.pathname.slice('/xrpc/'.length);
		const args = (
			init.method === 'GET' ? Object.fromEntries(url.searchParams) : JSON.parse(String(init.body))
		) as Value;
		const createSpace = nsid === 'group.opensocial.createSpace';
		if (!createSpace && args.repo !== groupDid) return refused(400, 'InvalidRequest');
		if (args.space !== undefined && args.space !== META && args.space !== CALENDAR) {
			return refused(400, 'InvalidRequest');
		}

		if (init.method === 'GET') {
			const value = read(args);
			if (value === 'no-space') return refused(400, 'SpaceNotFound');
			return value
				? Response.json({ value, cid: `cid-${args.rkey}` })
				: refused(400, 'RecordNotFound');
		}

		const write = writeOf(nsid, args);
		if (!write) return refused(400, 'InvalidRequest');
		if (createSpace && (args.type !== CALENDAR_SPACE_TYPE || args.skey !== 'self')) {
			return refused(400, 'InvalidRequest');
		}
		await pds.beforeWrite(write);
		if (pds.failNext === write) {
			pds.failNext = null;
			return refused(500, 'InternalServerError');
		}
		if (createSpace && pds.state.calendar) return refused(400, 'SpaceAlreadyExists');
		pds.writes.push(write);
		land(write, args);
		if (createSpace) return Response.json({ space: CALENDAR });
		const at = args.space ? `${args.space}/${groupDid}` : `at://${groupDid}`;
		return Response.json({ uri: `${at}/${args.collection}/${args.rkey}`, cid: `cid-${args.rkey}` });
	}

	return pds;
}
