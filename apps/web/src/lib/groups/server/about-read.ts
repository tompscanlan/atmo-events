// Reading a group's control plane back out of its spaces.
//
// The sibling of ./events-index.ts, with a different shape because the two
// halves of a group have opposite access rules:
//
//   public repo    anonymous, no credential        events-index.ts
//   about space    the group's own Bearer session  this file
//
// A space refuses anonymous HTTP even under a public read policy (401
// AuthMissing), so every read here carries the group's own app-password session.
// An account credential can read its own repo inside a space, and that is where
// every record the group authors lives. So reading a group needs no DPoP
// credential, no space scope, no peer credential and no sync engine. Over
// Bearer, an own-repo getRecord returns 200, a missing record returns 400
// RecordNotFound, and another repo's slice returns 400 RepoNotFound (measured on
// the alpha PDS, 2026-09-25).
//
// A space record's URI is space-scoped,
// at://<owner>/space/<type>/<skey>/<repo>/<collection>/<rkey>, not
// at://<repo>/<collection>/<rkey>. So the collection and rkey are parsed off the
// tail rather than assumed.
import {
	GROUP_PROFILE_COLLECTION,
	GROUP_PROFILE_RKEY,
	GROUP_RULE_COLLECTION,
	parseGroupProfile,
	parseGroupRule,
	requireApprovalFor,
	type GroupProfileFields
} from '../about-record';
import type { GroupRow } from '../types';
import type { CredentialStoreEnv } from './credentials';
import { resolveGroupCredential } from './credentials';
import { applyGroupCache } from './repo';
import { groupClient } from './session';

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

/** The read half of the space transport. Injectable for the same reason
 *  `GroupRepoWriter` is: the parsing and the rebuild can be tested without a
 *  live PDS. */
export interface GroupSpaceReader {
	get(query: {
		space: string;
		repo: string;
		collection: string;
		rkey: string;
	}): Promise<GroupSpaceRecord | null>;
	list(query: { space: string; repo: string; collection?: string }): Promise<GroupSpaceRecord[]>;
}

/** Collection and rkey are the last two path segments of a record URI in both
 *  the space-scoped and the plain-repo form, so taking them from the tail works
 *  for either without branching on which one the host returned. */
export function splitRecordUri(uri: string): { collection: string; rkey: string } {
	const segments = uri.split('/');
	return {
		collection: segments[segments.length - 2] ?? '',
		rkey: segments[segments.length - 1] ?? ''
	};
}

/** A space record's URI, which is the identity a rule citation depends on:
 *  `<space>/<repo>/<collection>/<rkey>`. This is the form of the URI that
 *  `getRecord` returns. */
export function spaceRecordUri(
	space: string,
	repo: string,
	collection: string,
	rkey: string
): string {
	return `${space}/${repo}/${collection}/${rkey}`;
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

/**
 * One space record off an XRPC response.
 *
 * The two read methods return different shapes, which is why this function
 * takes the query the response came from:
 *
 *   getRecord   -> { uri, cid, value }                  a URI, no fields
 *   listRecords -> { collection, rkey, cid, value }     fields, no uri
 *
 * A parser that required `uri` would drop every listed record and report a
 * group with rules as a group with none. So `collection` and `rkey` are taken
 * from the response when present and from the URI tail otherwise, and the URI
 * is rebuilt for list results so a citation is available either way.
 *
 * Every field is narrowed with `in` and `typeof` because the body came off a
 * PDS.
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

/** The real transport: the group's own session, then the space read methods.
 *
 *  It uses the raw `handle` rather than the typed client, for the reason
 *  `session.ts` documents: `com.atproto.space.*` is not in this app's
 *  generated lexicon set. */
export function pdsSpaceReader(
	cred: Parameters<typeof groupClient>[0],
	groupDid: string
): GroupSpaceReader {
	const send = async (nsid: string, params: Record<string, string>) => {
		const { handle } = await groupClient(cred, groupDid);
		const query = new URLSearchParams(params).toString();
		const res = await handle(`/xrpc/${nsid}?${query}`, { method: 'GET' });
		if (!res.ok) {
			const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
			const error = typeof body?.error === 'string' ? body.error : null;
			// RecordNotFound is getRecord's answer for a key with no record, and the
			// only 400 that means absent. Any other 400 (a space the PDS does not
			// know, a repo taken down, a token it refused) is a read that failed,
			// and it throws: the gate relies on that to fail closed, where "no
			// records" would hand the decision to the rows.
			if (res.status === 400 && error === 'RecordNotFound') return null;
			throw new Error(`${nsid} failed: ${res.status}${error ? ` ${error}` : ''}`);
		}
		return (await res.json().catch(() => null)) as unknown;
	};

	return {
		async get(query) {
			const body = await send('com.atproto.space.getRecord', query);
			return toSpaceRecord(body, query);
		},
		async list(query) {
			// The PDS accepts `collection`, so the slice is narrowed server-side.
			// Callers still check each record's collection, because a host that
			// ignored the parameter must not turn other records into rules.
			const body = await send('com.atproto.space.listRecords', {
				space: query.space,
				repo: query.repo,
				...(query.collection ? { collection: query.collection } : {})
			});
			if (!body || typeof body !== 'object' || !('records' in body)) return [];
			const records = body.records;
			if (!Array.isArray(records)) return [];
			return records
				.map((record) => toSpaceRecord(record, query))
				.filter((record): record is GroupSpaceRecord => record !== null);
		}
	};
}

/** The reader for a group, or null when this deployment holds no credential for
 *  it. That is a configuration fact, not an error a page should throw on. */
export async function groupSpaceReader(
	env: CredentialStoreEnv,
	db: D1Database,
	group: GroupRow
): Promise<GroupSpaceReader | null> {
	const cred = await resolveGroupCredential(env, db, group.group_did);
	if (!cred) return null;
	return pdsSpaceReader(cred, group.group_did);
}

export interface GroupAbout {
	profile: GroupProfileFields | null;
	rules: GroupRuleRecord[];
}

/** A group's public face as records. An absent record reads as absent, so a
 *  group with an empty about space still renders its page from the cache. A
 *  read that fails throws: the page fails rather than show the cache in place
 *  of records the PDS refused. */
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
	// `order` is a field this app adds to the rule record. `createdAt` then `rkey`
	// break ties, so the list is deterministic even for records without `order`.
	rules.sort(
		(a, b) =>
			a.order - b.order ||
			(a.createdAt ?? '').localeCompare(b.createdAt ?? '') ||
			a.rkey.localeCompare(b.rkey)
	);
	return { profile, rules };
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

/** Rebuild over a surviving row: cache repair.
 *
 *  Every column the `profile` record owns is overwritten from that record. It
 *  returns what it did so a command can report it. When the about space holds
 *  no profile it returns `'no-profile'` rather than throwing: that is a normal
 *  state, and wiping the cache to match an absent record would destroy data the
 *  records cannot replace.
 *
 *  A group with no row at all is handled by `./rebuild.ts`, which also owns the
 *  one entry point that picks between the two. */
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
