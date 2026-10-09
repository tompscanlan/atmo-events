// The browse list: the declaration index plus the caller's own groups.
import { getServerClient } from '$lib/contrail/index';
import type { GroupRow } from '../types';
import { ensureGroupsSchema } from './schema';
import { GROUP_COLUMNS } from './db/groups';

/** A group the declaration index lists, with the `createdAt` browse sorts by. */
export interface DeclaredGroup {
	did: string;
	createdAt: string | null;
}

/** Every group declared on the network, newest first. Throws if the index fails.
 *  No `actor`, which would backfill that repo on demand, and no `profiles`, since
 *  contrail refetches a missing profile from its PDS on every call. */
export async function listDeclaredGroups(db: D1Database, limit = 100): Promise<DeclaredGroup[]> {
	const res = await getServerClient(db).get('rsvp.atmo.declaration.listRecords', {
		params: { sort: 'createdAt', order: 'desc', limit: Math.min(Math.max(limit, 1), 200) }
	});
	if (!res.ok) throw new Error(`the declaration index did not answer: ${res.data.error}`);

	return res.data.records.map((record) => {
		const createdAt = (record.value as { createdAt?: unknown } | null)?.createdAt;
		return { did: record.did, createdAt: typeof createdAt === 'string' ? createdAt : null };
	});
}

/** One row of the browse list. `row` is null when this deployment holds no row
 *  for the group, which then renders without a link. `declared` says whether
 *  the declaration index listed it, so browse can show an undeclared group as
 *  private without asking its host. */
export interface BrowseEntry {
	group_did: string;
	row: GroupRow | null;
	declared: boolean;
}

/** Most membership-record checks one browse view runs at once. */
const ROSTER_CHECKS_IN_FLIGHT = 6;

/** The candidates `check` confirms, newest first, stopping at `wanted`. A
 *  check starts only while confirmed plus running is below `wanted`, so a
 *  rejection frees its slot for the next candidate. An unchecked candidate is
 *  never returned: listing it is the leak the check exists to close.
 *
 *  The first failure fails the listing. It is recorded, not left to the race,
 *  where a sibling that settles first would drop it. No check starts after a
 *  failure, and running checks are awaited before it is thrown. */
async function confirmNewest(
	candidates: GroupRow[],
	check: (row: GroupRow) => Promise<boolean>,
	wanted: number
): Promise<GroupRow[]> {
	const queue = [...candidates].sort((a, b) => b.created_at - a.created_at);
	const confirmed = new Set<GroupRow>();
	const running = new Set<Promise<void>>();
	// An array, not a nullable local: a callback sets it, which narrowing cannot see.
	const failures: unknown[] = [];
	let next = 0;
	for (;;) {
		while (
			failures.length === 0 &&
			next < queue.length &&
			running.size < ROSTER_CHECKS_IN_FLIGHT &&
			confirmed.size + running.size < wanted
		) {
			const row = queue[next++];
			const run: Promise<void> = check(row)
				.then(
					(ok) => {
						if (ok) confirmed.add(row);
					},
					(error: unknown) => {
						if (failures.length === 0) failures.push(error);
					}
				)
				.finally(() => running.delete(run));
			running.add(run);
		}
		if (running.size === 0) break;
		await Promise.race(running);
	}
	if (failures.length > 0) throw failures[0];
	return queue.filter((row) => confirmed.has(row));
}

/** Browse listing: the declaration index plus the caller's own groups.
 *
 *  A public group publishes a declaration and a private one withdraws it, so
 *  no visibility filter is needed. A declared group with no row here is still
 *  listed, because another app may have created it.
 *
 *  A signed-in caller also sees the groups they own or are a member
 *  of, so a private group stays reachable by its members. A row can outlive
 *  its membership record, so an undeclared group the caller does not own is
 *  kept only when `onRoster` confirms them. `confirmNewest` bounds those
 *  checks, since anyone who may admit members can add a DID to many rosters.
 *
 *  Names and descriptions come from the row, not records: the about space is
 *  never anonymously readable, so no indexer can supply them. */
export async function listGroups(
	db: D1Database,
	opts: {
		callerDid?: string | null;
		declared: DeclaredGroup[];
		limit?: number;
		/** Whether the caller's membership record confirms them. When absent,
		 *  the membership row is trusted. */
		onRoster?: (row: GroupRow) => Promise<boolean>;
	}
): Promise<BrowseEntry[]> {
	await ensureGroupsSchema(db);
	const caller = opts.callerDid ?? null;
	const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100);

	const own = caller
		? ((
				await db
					.prepare(
						`SELECT ${GROUP_COLUMNS} FROM groups
						 WHERE owner_did = ?
						    OR id IN (SELECT group_id FROM memberships WHERE did = ?)`
					)
					.bind(caller, caller)
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
		const row = byDid.get(d.did) ?? null;
		entries.set(d.did, {
			group_did: d.did,
			row,
			declared: true,
			at: Date.parse(d.createdAt ?? '') || row?.created_at || 0
		});
	}

	const undeclared = own.filter((row) => !entries.has(row.group_did));
	const onRoster = opts.onRoster;
	const unchecked = undeclared.filter((row) => row.owner_did === caller || !onRoster);
	const confirmed = onRoster
		? await confirmNewest(
				undeclared.filter((row) => row.owner_did !== caller),
				onRoster,
				limit
			)
		: [];
	for (const row of [...unchecked, ...confirmed]) {
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
