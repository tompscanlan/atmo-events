// The browse list: the declaration index plus the caller's own groups.
import { getServerClient } from '$lib/contrail/index';
import type { GroupRow } from '../types';
import { ensureGroupsSchema } from './schema';
import { GROUP_COLUMNS } from './db/groups';

export interface DeclaredGroup {
	did: string;
	indexedAt: number;
}

/** Newest first, the index's own order. No `actor`, which would backfill that repo on
 *  demand, and no `profiles`, which contrail refetches on every call. */
export async function listDeclaredGroups(db: D1Database, limit = 100): Promise<DeclaredGroup[]> {
	const res = await getServerClient(db).get('rsvp.atmo.declaration.listRecords', {
		params: { limit: Math.min(Math.max(limit, 1), 200) }
	});
	if (!res.ok) throw new Error(`the declaration index did not answer: ${res.data.error}`);
	return res.data.records.map((record) => ({
		did: record.did,
		indexedAt: Math.floor(record.time_us / 1000)
	}));
}

export interface BrowseEntry {
	group_did: string;
	row: GroupRow | null;
	declared: boolean;
}

/** Declared groups, and for a signed-in caller the groups the rows say they are in. */
export async function listGroups(
	db: D1Database,
	opts: { callerDid?: string | null; declared: DeclaredGroup[]; limit?: number }
): Promise<BrowseEntry[]> {
	await ensureGroupsSchema(db);
	const caller = opts.callerDid ?? null;
	const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100);

	const own = caller
		? ((
				await db
					.prepare(
						`SELECT ${GROUP_COLUMNS} FROM groups
						 WHERE id IN (SELECT group_id FROM memberships WHERE did = ?)`
					)
					.bind(caller)
					.all<GroupRow>()
			).results ?? [])
		: [];

	const byDid = new Map<string, GroupRow>();
	const dids = opts.declared.map((d) => d.did);
	if (dids.length > 0) {
		const { results } = await db
			.prepare(
				`SELECT ${GROUP_COLUMNS} FROM groups WHERE group_did IN (${dids.map(() => '?').join(', ')})`
			)
			.bind(...dids)
			.all<GroupRow>();
		for (const row of results ?? []) byDid.set(row.group_did, row);
	}

	const entries = new Map<string, BrowseEntry & { at: number }>();
	for (const d of opts.declared) {
		if (entries.has(d.did)) continue;
		entries.set(d.did, {
			group_did: d.did,
			row: byDid.get(d.did) ?? null,
			declared: true,
			at: d.indexedAt
		});
	}
	for (const row of own.filter((row) => !entries.has(row.group_did))) {
		entries.set(row.group_did, {
			group_did: row.group_did,
			row,
			declared: false,
			at: row.created_at
		});
	}

	return [...entries.values()]
		.sort((a, b) => b.at - a.at)
		.slice(0, limit)
		.map(({ group_did, row, declared }) => ({ group_did, row, declared }));
}
