// What the caller is to a group: their role from the row, and their access and
// permissions from the group's records when they can be read.
import { GROUP_PERMISSIONS } from '../permissions';
import { GROUP_ITSELF, NO_GRANTS, type WriteGrants } from '../scopes';
import type { CallerMembership, GroupRow } from '../types';
import type { GroupSpaceReader } from './about-read';
import {
	NO_MEMBER_RECORDS,
	hasAuthzRecords,
	hasRecordedAccess,
	readCallerAuthz,
	resolveActor
} from './members-read';
import { ensureGroupsSchema } from './schema';
import { getMemberRow } from './db/roster';
import { errorText } from './errors';

/** What `did` is to `group`: roster row, pending request, and permissions.
 *  An anonymous caller gets an empty set.
 *
 *  The group DID itself passes every check and is always on the roster, with no
 *  `membership` and no row (`proposal.md:44`). Signed in as the group's account,
 *  whoever holds its login may do anything, which is how a group with no admin
 *  left recovers. (Spec: FR-213.)
 *
 *  Permissions come from the records on every call, with no cache. A members
 *  space that cannot be read fails closed: a reader error propagates, and a
 *  space with no reader grants nothing, because reading "unreachable" as "no
 *  config" would leak access. A group with no authz records grants nothing either:
 *  the rows never decide what a member may do.
 *
 *  No row overrides a record. A revocation deletes the record before the row,
 *  so a partial failure leaves less access. `onRoster` uses the same sources,
 *  except that with no authz records to read it, the row says who is on it. */
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
			grants: NO_GRANTS,
			onRoster: false
		};
	}
	if (did === group.group_did) {
		return {
			did,
			role: null,
			pendingRequestId: null,
			permissions: new Set(GROUP_PERMISSIONS),
			grants: GROUP_ITSELF,
			onRoster: true
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

	let permissions: CallerMembership['permissions'] = new Set();
	let grants: WriteGrants = NO_GRANTS;
	let onRoster = membership !== null;
	if (members && hasAuthzRecords(members)) {
		({ grants, permissions } = resolveActor(members, did, group.group_did));
		onRoster = hasRecordedAccess(members, did);
	}

	return {
		did,
		role: membership?.role ?? null,
		pendingRequestId: pending?.id ?? null,
		permissions,
		grants,
		onRoster
	};
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
			grants: NO_GRANTS,
			onRoster: false,
			unreadable: errorText(e)
		};
	}
}
