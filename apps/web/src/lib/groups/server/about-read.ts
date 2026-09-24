// Reading a group's CONTROL PLANE back out of its spaces.
//
// The sibling of ./events-read.ts, and deliberately not the same shape, because
// the two halves of a group have opposite access rules:
//
//   public repo    anonymous, no credential        events-read.ts
//   about space    the group's own Bearer session  this file
//
// A space refuses anonymous HTTP even under a public read policy (measured: 401
// AuthMissing), so every read here carries the group's own app-password session.
// That is the finding that sized this iteration: an ACCOUNT credential reads its
// OWN repo inside a space, which is where every authority-authored record lives,
// so reading a group needs no DPoP credential, no space scope, no peer
// credential and no sync engine. Proven 2026-09-13 against pds.opnmt.net —
// own-repo getRecord over Bearer returned 200, another repo's slice returned
// 400 RecordNotFound. (Spec: FR-007.)
//
// WIRE SHAPES ARE MEASURED, NOT INFERRED — see contracts/spaces-and-policy.md
// § Space record wire shapes. Two things there are easy to get wrong:
//
//   1. `listRecords` takes `space` and `repo` ONLY. The probe passes no
//      `collection`, so this module does not either: it lists the slice and
//      filters by collection itself.
//   2. A space record's URI is SPACE-SCOPED —
//      at://<owner>/space/<type>/<skey>/<repo>/<collection>/<rkey> — and not
//      at://<repo>/<collection>/<rkey>. So the collection and rkey are parsed
//      off the tail rather than assumed.
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

/** The read half of the space transport, injectable for the same reason
 *  `GroupRepoWriter` is: the parsing and the rebuild can be asserted without a
 *  live PDS, and the live probe drives the same functions the unit tests do. */
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
 *  `<space>/<repo>/<collection>/<rkey>`. Measured against the live PDS — the
 *  URI `getRecord` returns has exactly this form. */
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
 * THE TWO METHODS DO NOT AGREE ON THE SHAPE, measured live 2026-09-18 and the
 * reason this function takes the query it was made from:
 *
 *   getRecord   -> { uri, cid, value }                  — a URI, no fields
 *   listRecords -> { collection, rkey, cid, value }     — fields, NO uri
 *
 * A parser that required `uri` therefore silently dropped every listed record
 * and reported a group with rules as a group with none. So `collection`/`rkey`
 * are taken from the response when present, from the URI tail otherwise, and
 * the URI is rebuilt for list results so a citation is available either way.
 *
 * Narrowed with `in`/`typeof` throughout because this came off a PDS: a shape
 * we merely asserted would fail exactly this quietly.
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
 *  Through the raw `handle` rather than the typed client for the reason
 *  `session.ts` documents — `com.atproto.space.*` is not in this app's
 *  generated lexicon set, and asserting a lexicon that is not there would be
 *  worse than an honest raw call. */
export function pdsSpaceReader(
	cred: Parameters<typeof groupClient>[0],
	groupDid: string
): GroupSpaceReader {
	const send = async (nsid: string, params: Record<string, string>) => {
		const { handle } = await groupClient(cred, groupDid);
		const query = new URLSearchParams(params).toString();
		const res = await handle(`/xrpc/${nsid}?${query}`, { method: 'GET' });
		if (res.status === 400) return null; // RecordNotFound is the empty case.
		if (!res.ok) throw new Error(`${nsid} failed: ${res.status}`);
		return (await res.json().catch(() => null)) as unknown;
	};

	return {
		async get(query) {
			const body = await send('com.atproto.space.getRecord', query);
			return toSpaceRecord(body, query);
		},
		async list(query) {
			// `collection` IS accepted (200, measured) — narrowing server-side beats
			// fetching the whole slice. The client-side filter stays anyway, because
			// the response carries the collection and a host that ignored the
			// parameter must not turn into rules that are not rules.
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
 *  it — which is a configuration fact, not an error a page should throw on. */
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

/** A group's public face as records. Both halves degrade to "absent" rather
 *  than throwing: a group provisioned before this code existed has an EMPTY
 *  about space, and its page must still render from cache. (FR-010's "no 500 on
 *  an empty about".) */
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
	// `order` is our declared extension (FR-004c); `createdAt` then `rkey` break
	// ties so the list is deterministic even for records written before it.
	rules.sort(
		(a, b) => a.order - b.order || (a.createdAt ?? '').localeCompare(b.createdAt ?? '') ||
			a.rkey.localeCompare(b.rkey)
	);
	return { profile, rules };
}

/** The Tier-1 columns a profile record owns, ready for `applyGroupCache`.
 *  `data-model.md` is the table this mirrors; if that file and this function
 *  disagree, the file is right and this is a bug. */
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

/** REBUILD over a surviving row: cache repair (`data-model.md`).
 *
 *  The row exists; every column the `profile` record owns is overwritten from
 *  that record. Returns what it did so a command can report it, and returns
 *  `'no-profile'` rather than throwing when the about space is empty — a group
 *  created before the profile writer existed is a normal state, and wiping its
 *  cache to match an absent record would destroy data the records cannot yet
 *  replace.
 *
 *  A group with no row at all is `./rebuild.ts`'s, which also owns the one
 *  entry point that picks between the two. (Spec: FR-009, SC-002.) */
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
