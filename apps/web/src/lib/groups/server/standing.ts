// What the caller is to a group: their role from the row, and their access and
// permissions from the members space's records when it can be read.
import { resolvePermissions, type GroupPermission } from '../permissions';
import type { CallerMembership, GroupRow } from '../types';
import type { GroupSpaceReader } from './about-read';
import {
	NO_MEMBER_RECORDS,
	hasAuthzRecords,
	hasRecordedAccess,
	readCallerAuthz,
	resolveActorPermissions
} from './members-read';
import { ensureGroupsSchema } from './schema';
import { getMemberRow } from './db/roster';
import { errorText } from './errors';

/** What `did` is to `group`: roster row, pending request, and permissions.
 *  An anonymous caller gets an empty set.
 *
 *  Permissions come from the records on every call, with no cache. A members
 *  space that cannot be read fails closed: a reader error propagates, and a
 *  space with no reader grants nothing, because reading "unreachable" as "no
 *  config" would leak access. A group with no authz records, or no members
 *  space, falls back to `role_permissions`.
 *
 *  No row overrides a record. A revocation deletes the record before the row,
 *  so a partial failure leaves less access. `onRoster` uses the same sources. */
export async function getCallerMembership(
	db: D1Database,
	group: GroupRow,
	did: string | null,
	reader: GroupSpaceReader | null
): Promise<CallerMembership> {
	await ensureGroupsSchema(db);
	if (!did) {
		return {
			did: null,
			role: null,
			pendingRequestId: null,
			permissions: new Set(),
			onRoster: false
		};
	}

	// `null` is a members space this deployment cannot read.
	const records = !group.members_space_uri
		? NO_MEMBER_RECORDS
		: reader
			? readCallerAuthz(reader, group, did)
			: null;
	const [membership, pending, members] = await Promise.all([
		getMemberRow(db, group.id, did),
		db
			.prepare(`SELECT id FROM join_requests WHERE group_id = ? AND did = ? AND status = 'pending'`)
			.bind(group.id, did)
			.first<{ id: string }>(),
		records
	]);

	let permissions: ReadonlySet<GroupPermission>;
	let onRoster: boolean;
	if (!members) {
		permissions = new Set();
		onRoster = membership !== null;
	} else if (!hasAuthzRecords(members)) {
		permissions = await rowPermissions(db, group.id, did);
		onRoster = membership !== null;
	} else {
		permissions = resolveActorPermissions(members, did);
		onRoster = hasRecordedAccess(members, did);
	}

	return {
		did,
		role: membership?.role ?? null,
		pendingRequestId: pending?.id ?? null,
		permissions,
		onRoster
	};
}

/** The fallback for a group with no authz records: the union of the
 *  `role_permissions` rows a membership reaches. */
async function rowPermissions(
	db: D1Database,
	groupId: string,
	did: string
): Promise<Set<GroupPermission>> {
	const grants = await db
		.prepare(
			`SELECT rp.permission FROM role_permissions rp
			 JOIN roles r ON r.id = rp.role_id
			 JOIN memberships m ON m.role_id = r.id AND m.group_id = r.group_id
			 WHERE m.group_id = ? AND m.did = ?`
		)
		.bind(groupId, did)
		.all<{ permission: string }>();
	return resolvePermissions([(grants.results ?? []).map((r) => r.permission)]);
}

/** When the members space errors, the caller is off the roster and holds no
 *  permission. The row cannot stand in: after a removal whose row delete failed,
 *  it would let the removed member in. It still supplies what the page shows,
 *  and `unreadable` makes a form say "could not be checked". When there is no
 *  reader because the owner has not linked the group, `unlinked` makes a form
 *  say that instead. */
export async function readStanding(
	db: D1Database,
	group: GroupRow,
	callerDid: string | null,
	reader: GroupSpaceReader | null
): Promise<CallerMembership> {
	try {
		const membership = await getCallerMembership(db, group, callerDid, reader);
		return !reader && group.members_space_uri ? { ...membership, unlinked: true } : membership;
	} catch (e) {
		if (!reader) throw e;
		console.error(
			`[groups] ${group.group_did}: members space unreadable; the caller is off the roster for this read:`,
			e
		);
		const row = await getCallerMembership(db, group, callerDid, null);
		return {
			...row,
			permissions: new Set(),
			onRoster: false,
			unreadable: errorText(e)
		};
	}
}
