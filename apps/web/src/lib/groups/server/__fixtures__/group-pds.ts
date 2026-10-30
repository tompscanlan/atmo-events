// A group's own PDS as settings and create write to it: the profile and access records in
// its meta space, and the declaration in its public repo. It refuses a meta read or write
// outside the group's own meta space, and keeps the order the writes landed in.
import { vi } from 'vitest';
import { GROUP_DECLARATION_COLLECTION, GROUP_PROFILE_COLLECTION, metaSpaceUri } from '../../ids';
import type { GroupWriter } from '../context';
import type { XrpcHandle } from '../xrpc';

export interface GroupPdsState {
	profile: Record<string, unknown> | null;
	access: Record<string, unknown> | null;
	declared: boolean;
}

export type GroupPdsWrite = 'profile' | 'access' | 'declare' | 'withdraw';

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

export function groupPds(groupDid: string, initial: Partial<GroupPdsState> = {}): GroupPds {
	const pds: GroupPds = {
		writer: { did: groupDid, handle: vi.fn<XrpcHandle>(answer) },
		state: { profile: null, access: null, declared: false, ...initial },
		writes: [],
		failNext: null,
		beforeWrite: () => {}
	};

	async function answer(pathname: string, init: RequestInit): Promise<Response> {
		const url = new URL(pathname, 'https://pds.example');
		const nsid = url.pathname.slice('/xrpc/'.length);
		const args = (
			init.method === 'GET' ? Object.fromEntries(url.searchParams) : JSON.parse(String(init.body))
		) as Record<string, unknown>;
		if (args.repo !== groupDid) return refused(400, 'InvalidRequest');
		const inMeta = nsid.startsWith('com.atproto.space.');
		if (inMeta && args.space !== metaSpaceUri(groupDid)) return refused(400, 'InvalidRequest');

		if (init.method === 'GET') {
			const value = inMeta
				? args.collection === GROUP_PROFILE_COLLECTION
					? pds.state.profile
					: pds.state.access
				: pds.state.declared
					? { $type: GROUP_DECLARATION_COLLECTION }
					: null;
			return value ? Response.json({ value }) : refused(400, 'RecordNotFound');
		}

		const write: GroupPdsWrite = inMeta
			? args.collection === GROUP_PROFILE_COLLECTION
				? 'profile'
				: 'access'
			: nsid === 'com.atproto.repo.deleteRecord'
				? 'withdraw'
				: 'declare';
		await pds.beforeWrite(write);
		if (pds.failNext === write) {
			pds.failNext = null;
			return refused(500, 'InternalServerError');
		}
		pds.writes.push(write);
		const record = (args.record as Record<string, unknown> | undefined) ?? null;
		if (write === 'profile') pds.state.profile = record;
		else if (write === 'access') pds.state.access = record;
		else pds.state.declared = write === 'declare';
		return Response.json({ uri: `at://${groupDid}/x/self`, cid: 'c' });
	}

	return pds;
}
