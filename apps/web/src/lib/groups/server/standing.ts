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
import { isSpaceAccessDenied } from './space-credential';

/** What `did` is to `group`: roster row, pending request, and permissions.
 *  An anonymous caller gets an empty set.
 *
 *  The group DID itself passes every check and is always on the roster, with no
 *  `membership` and no row (`proposal.md:44`). Its login is the group host's, not
 *  this site's. (Spec: FR-213.)
 *
 *  Permissions come from the records on every call, with no cache, read with the
 *  caller's own access. A members space that cannot be read fails closed: a
 *  reader error propagates, and a space with no reader grants nothing, because
 *  reading "unreachable" as "no config" would leak access. A group with no authz records grants nothing either:
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

/** The caller's standing, read with their own access.
 *
 *  When the members space errors, the caller is off the roster and holds no
 *  permission. The row cannot stand in: after a removal whose row delete failed,
 *  it would let the removed member in. It still supplies what the page shows,
 *  and `unreadable` makes a form say "could not be checked".
 *
 *  When the host does not let the caller into the members space, that is its
 *  answer, not an outage: they are not on its list, or their sign-in does not
 *  read the space, so they stand as a non-member (TS 2026-10-15: a member whose
 *  sign-in lacks the read grant sees what a non-member sees until they sign in
 *  again).
 *
 *  A signed-in caller with no reader has a sign-in that reads no spaces. The row
 *  says whether they are on the roster, as when the records cannot be asked, and
 *  `noSpaceAccess` makes a form say why their permissions are unknown. */
export async function readStanding(
	db: D1Database,
	group: GroupRow,
	callerDid: string | null,
	reader: GroupSpaceReader | null
): Promise<CallerMembership> {
	try {
		const membership = await getCallerMembership(db, group, callerDid, reader);
		const blind = !reader && callerDid !== null && callerDid !== group.group_did;
		return blind && group.members_space_uri ? { ...membership, noSpaceAccess: true } : membership;
	} catch (e) {
		if (!reader) throw e;
		const row = await getCallerMembership(db, group, callerDid, null);
		const off = { ...row, permissions: new Set<never>(), grants: NO_GRANTS, onRoster: false };
		if (isSpaceAccessDenied(e)) return off;
		console.error(
			`[groups] ${group.group_did}: members space unreadable; the caller is off the roster for this read:`,
			e
		);
		return { ...off, unreadable: errorText(e) };
	}
}
