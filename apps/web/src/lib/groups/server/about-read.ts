// Reads a group's records back out of its spaces. A page reads with the caller's own
// space credential, so the group's authority decides what each person sees; the group's
// own session reads only where the group itself acts.
import {
	GROUP_PROFILE_COLLECTION,
	GROUP_PROFILE_RKEY,
	GROUP_RULE_COLLECTION,
	parseGroupProfile,
	parseGroupRule,
	type GroupProfileFields
} from '../about-record';
import {
	GROUP_ACCESS_COLLECTION,
	GROUP_ACCESS_RKEY,
	parseGroupAccess,
	type GroupAccessFields
} from '../members-record';
import { spaceRecordUri, splitRecordUri } from '../ids';
import type { GroupRow } from '../types';

import { groupClient, type CredentialStoreEnv, resolveGroupCredential } from './session';
import {
	credentialRequest,
	didSpaceHosts,
	type ExchangesUnderWay,
	type SpaceHolder,
	type SpaceHosts
} from './space-credential';
import { isRecordNotFound, xrpc, xrpcError, type XrpcAnswer } from './xrpc';

export interface GroupSpaceRecord {
	uri: string;
	cid: string;
	collection: string;
	rkey: string;
	value: Record<string, unknown>;
}

export interface GroupRuleRecord {
	rkey: string;
	uri: string;
	text: string;
	order: number;
}

export interface GroupSpaceReader {
	get(query: {
		space: string;
		repo: string;
		collection: string;
		rkey: string;
	}): Promise<GroupSpaceRecord | null>;
	/** Every page, or a throw: callers act on what is missing, so a partial list never returns. */
	list(query: { space: string; repo: string; collection?: string }): Promise<GroupSpaceRecord[]>;
}

const LIST_RECORDS_LIMIT = 100;

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

// `getRecord` returns `uri` without `collection` and `rkey`, and `listRecords` the reverse.
function toSpaceRecord(
	body: unknown,
	from: { space: string; repo: string }
): GroupSpaceRecord | null {
	if (!body || typeof body !== 'object') return null;
	const cid = 'cid' in body && typeof body.cid === 'string' ? body.cid : '';
	const value = asRecord('value' in body ? body.value : null);

	const listed = {
		collection: 'collection' in body && typeof body.collection === 'string' ? body.collection : '',
		rkey: 'rkey' in body && typeof body.rkey === 'string' ? body.rkey : ''
	};
	if (listed.collection && listed.rkey) {
		return {
			uri: spaceRecordUri(from.space, from.repo, listed.collection, listed.rkey),
			cid,
			collection: listed.collection,
			rkey: listed.rkey,
			value
		};
	}

	if (!('uri' in body) || typeof body.uri !== 'string') return null;
	const { collection, rkey } = splitRecordUri(body.uri);
	return { uri: body.uri, cid, collection, rkey, value };
}

/** The reader names the host's error code in what it throws, and this reads it back. */
export function isSpaceNotFound(e: unknown): boolean {
	return e instanceof Error && /\bSpaceNotFound\b/.test(e.message);
}

type SpaceQuery = (nsid: string, params: Record<string, string>) => Promise<XrpcAnswer>;

function readerOver(query: SpaceQuery): GroupSpaceReader {
	const send = async (nsid: string, params: Record<string, string>) => {
		const answer = await query(nsid, params);
		// RecordNotFound is the only 400 that means absent. Anything else throws,
		// so the gate fails closed rather than read "no records".
		if (isRecordNotFound(answer)) return null;
		if (!answer.ok) throw xrpcError(nsid, answer);
		return answer.data;
	};

	return {
		async get(query) {
			const body = await send('com.atproto.space.getRecord', query);
			return toSpaceRecord(body, query);
		},
		async list(query) {
			const records: GroupSpaceRecord[] = [];
			let cursor: string | undefined;
			for (;;) {
				const body = await send('com.atproto.space.listRecords', {
					space: query.space,
					repo: query.repo,
					...(query.collection ? { collection: query.collection } : {}),
					limit: String(LIST_RECORDS_LIMIT),
					...(cursor ? { cursor } : {})
				});
				const page =
					body && typeof body === 'object' && 'records' in body && Array.isArray(body.records)
						? body.records
						: null;
				if (!page) {
					if (cursor) throw new Error(`com.atproto.space.listRecords returned no records page`);
					return records;
				}
				for (const record of page) {
					const parsed = toSpaceRecord(record, query);
					if (parsed) records.push(parsed);
				}
				const next =
					body && typeof body === 'object' && 'cursor' in body && typeof body.cursor === 'string'
						? body.cursor
						: undefined;
				if (!next || page.length === 0) return records;
				if (next === cursor) {
					throw new Error(`com.atproto.space.listRecords repeated its cursor`);
				}
				cursor = next;
			}
		}
	};
}

/** Through the raw `handle`, since the space methods are not in the generated lexicon set. */
export function pdsSpaceReader(
	cred: Parameters<typeof groupClient>[0],
	groupDid: string
): GroupSpaceReader {
	return readerOver(async (nsid, params) => {
		const { handle } = await groupClient(cred, groupDid);
		return xrpc(handle, nsid, { query: params });
	});
}

/** A record read at the repo's PDS, signed for the repo's DID. A space the authority
 *  will not let the holder into throws `SpaceAccessDenied`, which callers read as no
 *  access, not as an outage. */
export function credentialSpaceReader(
	holder: SpaceHolder,
	hosts: SpaceHosts = didSpaceHosts
): GroupSpaceReader {
	// One reader per request, so its reads share exchanges only there.
	const underWay: ExchangesUnderWay = new Map();
	return readerOver(async (nsid, params) => {
		const call = { host: await hosts.repoHost(params.repo), audience: params.repo, nsid, query: params };
		return credentialRequest(holder, hosts, params.space, call, underWay);
	});
}

/** Null when `personDid` holds no group session, a fact a page shows rather than throws on. */
export async function groupSpaceReader(
	env: CredentialStoreEnv,
	group: Pick<GroupRow, 'group_did'>,
	personDid: string
): Promise<GroupSpaceReader | null> {
	const cred = await resolveGroupCredential(env, group.group_did, personDid);
	if (!cred) return null;
	return pdsSpaceReader(cred, group.group_did);
}

export interface GroupAbout {
	profile: GroupProfileFields | null;
	rules: GroupRuleRecord[];
}


export async function readGroupProfile(
	reader: GroupSpaceReader,
	group: Pick<GroupRow, 'group_did' | 'about_space_uri'>
): Promise<GroupProfileFields | null> {
	const space = group.about_space_uri;
	if (!space) return null;
	const found = await reader.get({
		space,
		repo: group.group_did,
		collection: GROUP_PROFILE_COLLECTION,
		rkey: GROUP_PROFILE_RKEY
	});
	return found ? parseGroupProfile(found.value) : null;
}

export async function readGroupAbout(
	reader: GroupSpaceReader,
	group: Pick<GroupRow, 'group_did' | 'about_space_uri'>
): Promise<GroupAbout> {
	const space = group.about_space_uri;
	if (!space) return { profile: null, rules: [] };
	const repo = group.group_did;
	const profile = await readGroupProfile(reader, group);

	const rules: GroupRuleRecord[] = [];
	for (const record of await reader.list({ space, repo, collection: GROUP_RULE_COLLECTION })) {
		if (record.collection !== GROUP_RULE_COLLECTION) continue;
		const parsed = parseGroupRule(record.value);
		if (!parsed) continue;
		rules.push({
			rkey: record.rkey,
			uri: record.uri,
			text: parsed.text,
			order: parsed.order
		});
	}
	rules.sort((a, b) => a.order - b.order || a.rkey.localeCompare(b.rkey));
	return { profile, rules };
}

/** Kept out of `readGroupAbout`, since only the writers that keep it true read it. */
export async function readAboutAccess(
	reader: GroupSpaceReader,
	group: Pick<GroupRow, 'group_did' | 'about_space_uri'>
): Promise<GroupAccessFields | null> {
	const space = group.about_space_uri;
	if (!space) return null;
	const found = await reader.get({
		space,
		repo: group.group_did,
		collection: GROUP_ACCESS_COLLECTION,
		rkey: GROUP_ACCESS_RKEY
	});
	return found ? parseGroupAccess(found.value) : null;
}
