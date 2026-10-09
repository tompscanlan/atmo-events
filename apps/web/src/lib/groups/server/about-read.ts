// Reads a group's records back out of its spaces.
//
// A space refuses anonymous reads even under a public read policy (401
// AuthMissing), so every read uses the group's own session (./session.ts). An
// account can read its own records in a space over Bearer, with no DPoP, space
// scope or sync engine, and every record here is the group's own.
import {
	GROUP_PROFILE_COLLECTION,
	GROUP_PROFILE_RKEY,
	GROUP_RULE_COLLECTION,
	parseGroupProfile,
	parseGroupRule,
	requireApprovalFor,
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
import type { CredentialStoreEnv } from './credentials';
import { resolveGroupCredential } from './credentials';
import { applyGroupCache } from './repo';
import { groupClient } from './session';
import { isRecordNotFound, xrpc, xrpcError } from './xrpc';

export interface GroupSpaceRecord {
	uri: string;
	cid: string;
	collection: string;
	rkey: string;
	value: Record<string, unknown>;
}

/** A rule as it came back, with the identity a citation depends on. */
export interface GroupRuleRecord {
	rkey: string;
	uri: string;
	text: string;
	order: number;
	createdAt: string | null;
}

/** From `getSpace`, narrowed to the read policy's `$type`. */
export interface GroupSpaceConfig {
	readPolicy: string;
}

/** The read transport. Injectable, like `GroupRepoWriter`. */
export interface GroupSpaceReader {
	get(query: {
		space: string;
		repo: string;
		collection: string;
		rkey: string;
	}): Promise<GroupSpaceRecord | null>;
	/** Every record in the slice, across all pages, or a throw. Callers act on
	 *  what is missing, so a partial list must never come back. */
	list(query: { space: string; repo: string; collection?: string }): Promise<GroupSpaceRecord[]>;
	/** Throws on failure: the read policy is the group's visibility, so a failed
	 *  read must never come back as either answer. */
	getSpace(space: string): Promise<GroupSpaceConfig>;
}

const LIST_RECORDS_LIMIT = 100;

const GET_SPACE = 'com.atproto.simplespace.getSpace';

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

/**
 * One space record from a response. `getRecord` returns `uri` without
 * `collection` and `rkey`, and `listRecords` returns them without `uri`. Both
 * shapes are read, and a listed record's URI is rebuilt for citations.
 */
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

/** Reads with the group's own session, through the raw `handle`, since the
 *  space methods are not in the generated lexicon set. */
export function pdsSpaceReader(
	cred: Parameters<typeof groupClient>[0],
	groupDid: string
): GroupSpaceReader {
	const send = async (nsid: string, params: Record<string, string>) => {
		const { handle } = await groupClient(cred, groupDid);
		const answer = await xrpc(handle, nsid, { query: params });
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
			// Callers still check each record's collection, in case a host ignores the filter.
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
					// A later page without records means the listing broke partway.
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
		},
		// Every failure throws, `SpaceNotFound` included: the gate must not guess.
		async getSpace(space) {
			const { handle } = await groupClient(cred, groupDid);
			const answer = await xrpc(handle, GET_SPACE, { query: { space } });
			if (!answer.ok) throw xrpcError(GET_SPACE, answer);
			const policy = asRecord(answer.data.readPolicy);
			if (typeof policy.$type !== 'string') {
				throw new Error(`com.atproto.simplespace.getSpace returned no read policy for ${space}`);
			}
			return { readPolicy: policy.$type };
		}
	};
}

/** The reader for a group, or null when this deployment holds no credential for
 *  it. That is a configuration fact, not an error a page should throw on. */
export async function groupSpaceReader(
	env: CredentialStoreEnv,
	group: GroupRow
): Promise<GroupSpaceReader | null> {
	const cred = await resolveGroupCredential(env, group.group_did);
	if (!cred) return null;
	return pdsSpaceReader(cred, group.group_did);
}

export interface GroupAbout {
	profile: GroupProfileFields | null;
	rules: GroupRuleRecord[];
}

/** A group's profile and rules. A missing record reads as absent. A failed read
 *  throws, so the cache never stands in for records the PDS refused. */
export async function readGroupAbout(
	reader: GroupSpaceReader,
	group: Pick<GroupRow, 'group_did' | 'about_space_uri'>
): Promise<GroupAbout> {
	const space = group.about_space_uri;
	if (!space) return { profile: null, rules: [] };
	const repo = group.group_did;

	const found = await reader.get({
		space,
		repo,
		collection: GROUP_PROFILE_COLLECTION,
		rkey: GROUP_PROFILE_RKEY
	});
	const profile = found ? parseGroupProfile(found.value) : null;

	const rules: GroupRuleRecord[] = [];
	for (const record of await reader.list({ space, repo, collection: GROUP_RULE_COLLECTION })) {
		if (record.collection !== GROUP_RULE_COLLECTION) continue;
		const parsed = parseGroupRule(record.value);
		if (!parsed) continue;
		rules.push({
			rkey: record.rkey,
			uri: record.uri,
			text: parsed.text,
			order: parsed.order,
			createdAt: parsed.createdAt
		});
	}
	// `createdAt` then `rkey` break ties, so records without `order` sort stably.
	rules.sort(
		(a, b) =>
			a.order - b.order ||
			(a.createdAt ?? '').localeCompare(b.createdAt ?? '') ||
			a.rkey.localeCompare(b.rkey)
	);
	return { profile, rules };
}

/** The about space's access record, or null when there is none. Kept out of
 *  `readGroupAbout`, since only the writers that keep it true read it. */
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

/** The columns a profile record owns, ready for `applyGroupCache`. */
export function cacheFromProfile(profile: GroupProfileFields): {
	name: string;
	description: string | null;
	require_approval: number;
	location_name: string | null;
} {
	return {
		name: profile.name,
		description: profile.description,
		require_approval: requireApprovalFor(profile.joinPolicy),
		location_name: profile.locationName
	};
}

/** Cache repair over a surviving row: rewrites the columns the `profile` record
 *  owns. With no profile it returns `'no-profile'` rather than wipe the cache,
 *  which the records could not replace. A missing row is ./rebuild.ts's job. */
export async function rebuildGroupCache(
	db: D1Database,
	reader: GroupSpaceReader,
	group: GroupRow
): Promise<{ outcome: 'repaired' | 'no-profile'; rules: number }> {
	const about = await readGroupAbout(reader, group);
	if (!about.profile) return { outcome: 'no-profile', rules: about.rules.length };
	await applyGroupCache(db, group.id, cacheFromProfile(about.profile));
	return { outcome: 'repaired', rules: about.rules.length };
}
