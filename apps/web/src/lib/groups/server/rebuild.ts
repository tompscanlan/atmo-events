// Rebuilds a group's D1 cache from its records, keyed by the group DID: the profile
// columns from the about space and the roster from the members space. With every
// row deleted, a rebuild renders the same group.
// `rebuildGroup` takes whichever path the database leaves it:
//
//   a row survives   repair it: overwrite the profile columns and re-project
//                    the roster.
//   no row at all    restore it from records. The role rows go in before any
//                    membership, because `memberships.role_id` is a composite
//                    FK into `roles (id, group_id)`.
//
// Nothing is restored for visibility: it is the about space's read policy at
// the host, and no row holds it.
//
// A restore refuses, before any write, a group with no profile (`name` is NOT
// NULL), no authz records (no member could be restored), or no `membership`
// record granting `owner`, since `owner_did` can never be corrected once
// written.
import { requireApprovalFor, type GroupProfileFields } from '../about-record';
import { groupSpaceUris } from '../ids';
import { isMembershipKey } from '../members-record';
import { GROUP_ROLES, type GroupPermission, type GroupRoleName } from '../permissions';
import type { GroupRow } from '../types';
import { readGroupAbout, type GroupSpaceReader } from './about-read';
import {
	createdAtMs,
	effectivePermissions,
	hasAuthzRecords,
	ownerDidFromRecords,
	primaryRole,
	readGroupMembers,
	type GroupMembers
} from './members-read';
import { applyGroupCache, getGroupByDid, restoreGroup } from './repo';
import { ensureGroupsSchema } from './schema';
/** A rebuild that stopped before writing anything. `reason` is a stable tag,
 *  so a command can report it without matching the message. */
export class GroupRebuildRefused extends Error {
	constructor(
		readonly reason: 'no-profile' | 'no-owner-record' | 'no-authz-records',
		message: string
	) {
		super(message);
		this.name = 'GroupRebuildRefused';
	}
}

export type GroupRebuildResult =
	| {
			path: 'repaired';
			group: GroupRow;
			profile: 'repaired' | 'no-profile';
			members: MembersRebuildResult;
	  }
	| { path: 'restored'; group: GroupRow; members: MembersRebuildResult };

/** Rebuilds the group whose DID this is, from its records. */
export async function rebuildGroup(
	db: D1Database,
	reader: GroupSpaceReader,
	groupDid: string
): Promise<GroupRebuildResult> {
	const row = await getGroupByDid(db, groupDid);
	if (row) {
		const profile = await rebuildGroupCache(db, reader, row);
		const members = await rebuildGroupMembers(db, reader, row);
		const group = (await getGroupByDid(db, groupDid)) ?? row;
		return { path: 'repaired', group, profile: profile.outcome, members };
	}
	return restoreFromRecords(db, reader, groupDid);
}

async function restoreFromRecords(
	db: D1Database,
	reader: GroupSpaceReader,
	groupDid: string
): Promise<GroupRebuildResult> {
	const spaces = groupSpaceUris(groupDid);
	const located = {
		group_did: groupDid,
		about_space_uri: spaces.aboutSpaceUri,
		members_space_uri: spaces.membersSpaceUri
	};
	const [about, members] = await Promise.all([
		readGroupAbout(reader, located),
		readGroupMembers(reader, located)
	]);

	if (!about.profile) {
		throw new GroupRebuildRefused(
			'no-profile',
			`${groupDid} has no profile record, so there is no name to restore`
		);
	}
	const ownerDid = ownerDidFromRecords(members);
	if (!ownerDid) {
		throw new GroupRebuildRefused(
			'no-owner-record',
			`no membership record in ${groupDid} grants owner; refusing to guess one, since owner_did can never be corrected once written`
		);
	}
	if (!hasAuthzRecords(members)) {
		throw new GroupRebuildRefused(
			'no-authz-records',
			`${groupDid} has no role or permissions records, so no member could be restored`
		);
	}
	const owner = members.memberships.find((record) => record.subject === ownerDid);
	const now = Date.now();

	const group = await restoreGroup(db, {
		groupDid,
		ownerDid,
		name: about.profile.name,
		description: about.profile.description,
		requireApproval: requireApprovalFor(about.profile.joinPolicy) === 1,
		locationName: about.profile.locationName,
		aboutSpaceUri: spaces.aboutSpaceUri,
		membersSpaceUri: spaces.membersSpaceUri,
		createdAt: timestamp(about.profile.createdAt, now),
		roles: rolesFromRecords(members),
		ownerJoinedAt: timestamp(owner?.createdAt ?? null, now)
	});
	// The owner's row went in with the group. This restores everyone else.
	return { path: 'restored', group, members: await projectGroupMembers(db, members, group) };
}

/** The roles the records declare, each with the union of what both binding
 *  records grant it. Reading only one would drop every event grant. `owner` is
 *  always present: the schema creates its row, the records only bind it. */
function rolesFromRecords(
	members: GroupMembers
): { name: GroupRoleName; permissions: GroupPermission[] }[] {
	const declared = new Set<GroupRoleName>(members.roles.map((role) => role.id));
	declared.add('owner');
	return GROUP_ROLES.filter((name) => declared.has(name)).map((name) => ({
		name,
		permissions: [...effectivePermissions(members, [name])]
	}));
}

function timestamp(value: string | null, fallback: number): number {
	const parsed = value ? Date.parse(value) : Number.NaN;
	return Number.isFinite(parsed) ? parsed : fallback;
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

export interface MembersRebuildResult {
	/** Rows inserted or corrected from a record. */
	restored: string[];
	/** Rows that already agreed with their record. */
	unchanged: string[];
	/** Roster rows with no membership record. Reported, never deleted: a failed
	 *  grant and a half-done revocation both leave one, and the gate denies both. */
	orphans: string[];
	/** Records that could not be projected, with the reason. */
	skipped: { did: string; reason: string }[];
}

/**
 * Rebuild the `memberships` projection from the records. It is additive: it
 * writes what the records say and touches nothing else, so dropped rows come
 * back. The owner row is inserted, never updated, because the schema refuses
 * any change to it. A record that disagrees with it is skipped with a reason.
 */
export async function rebuildGroupMembers(
	db: D1Database,
	reader: GroupSpaceReader,
	group: GroupRow
): Promise<MembersRebuildResult> {
	return projectGroupMembers(db, await readGroupMembers(reader, group), group);
}

/** `rebuildGroupMembers` over records already read, so a cold rebuild that
 *  needed them to find the owner does not read the members space twice. */
export async function projectGroupMembers(
	db: D1Database,
	members: GroupMembers,
	group: GroupRow
): Promise<MembersRebuildResult> {
	await ensureGroupsSchema(db);
	const result: MembersRebuildResult = { restored: [], unchanged: [], orphans: [], skipped: [] };

	const roleRows = await db
		.prepare(`SELECT id, name FROM roles WHERE group_id = ?`)
		.bind(group.id)
		.all<{ id: string; name: GroupRoleName }>();
	const roleId = new Map<string, string>();
	for (const row of roleRows.results ?? []) roleId.set(row.name, row.id);

	const existing = await db
		.prepare(
			`SELECT m.did, m.role_id, m.status, r.name AS role
			 FROM memberships m JOIN roles r ON r.id = m.role_id
			 WHERE m.group_id = ?`
		)
		.bind(group.id)
		.all<{ did: string; role_id: string; status: string; role: GroupRoleName }>();
	const rows = new Map<string, { role: GroupRoleName; status: string }>();
	for (const row of existing.results ?? [])
		rows.set(row.did, { role: row.role, status: row.status });

	const now = Date.now();
	const recorded = new Set<string>();

	for (const record of members.memberships) {
		const did = record.subject;
		// A subject that cannot be a record key would be an unaddressable member.
		if (!isMembershipKey(did)) {
			result.skipped.push({ did, reason: 'subject is not a usable record key' });
			continue;
		}
		recorded.add(did);

		const role = primaryRole(record.roles);
		if (!role) {
			result.skipped.push({ did, reason: 'the record grants no role this build knows' });
			continue;
		}
		const target = roleId.get(role);
		if (!target) {
			result.skipped.push({ did, reason: `this group has no ${role} role row` });
			continue;
		}

		const row = rows.get(did);

		// The schema decides the owner. A disagreeing record is reported, not
		// applied, but a missing owner row is still inserted.
		if (did === group.owner_did) {
			if (role !== 'owner') {
				result.skipped.push({ did, reason: `owner_did cannot hold the ${role} role` });
				continue;
			}
			if (row) {
				if (row.role === 'owner' && row.status === 'active') result.unchanged.push(did);
				else {
					result.skipped.push({
						did,
						reason: `the owner's row is ${row.role}/${row.status} and is immutable`
					});
				}
				continue;
			}
		} else if (row && row.role === role && row.status === 'active') {
			result.unchanged.push(did);
			continue;
		}

		await db
			.prepare(
				`INSERT INTO memberships (id, group_id, did, role_id, status, created_at, updated_at)
				 VALUES (?, ?, ?, ?, 'active', ?, ?)
				 ON CONFLICT (group_id, did) DO UPDATE SET
					role_id = excluded.role_id, status = 'active', updated_at = excluded.updated_at`
			)
			.bind(crypto.randomUUID(), group.id, did, target, createdAtMs(record.createdAt) || now, now)
			.run();
		result.restored.push(did);
	}

	for (const did of rows.keys()) {
		if (!recorded.has(did)) result.orphans.push(did);
	}

	return result;
}
