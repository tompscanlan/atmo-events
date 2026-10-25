// What the caller is to a group: their role from the row, and their access and
// permissions from the group's records, read with their own access on every call.
import { GROUP_PERMISSIONS } from '../permissions';
import { GROUP_ITSELF, NO_GRANTS } from '../scopes';
import type { CallerMembership, GroupRow } from '../types';
import type { GroupSpaceReader } from './about-read';
import { NO_MEMBER_RECORDS, readCallerAuthz, resolveActor, rolesForDid } from './members-read';
import { getMemberRow, pendingRequestIdOf } from './db/roster';
import { errorText } from './errors';
import { isSpaceAccessDenied } from './space-credential';

/** The group DID itself passes every check, with no record and no row. With no reader
 *  the caller is off the roster: only their own record puts them on it. */
export async function getCallerMembership(
	db: D1Database,
	group: GroupRow,
	did: string | null,
	reader: GroupSpaceReader | null
): Promise<CallerMembership> {
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
	const [row, pendingRequestId, members] = await Promise.all([
		getMemberRow(db, group.id, did),
		pendingRequestIdOf(db, group.id, did),
		group.members_space_uri && reader ? readCallerAuthz(reader, group, did) : NO_MEMBER_RECORDS
	]);
	const { grants, permissions } = resolveActor(members, did, group.group_did);
	return {
		did,
		role: row?.role ?? null,
		pendingRequestId,
		permissions,
		grants,
		onRoster: rolesForDid(members, did).length > 0
	};
}

/** When the members space errors, the caller is off the roster and holds nothing: after
 *  a removal whose row delete failed, the row would let them in. A host that turns them
 *  away is an answer, not an outage. With no reader, `noSpaceAccess` lets a form say why. */
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
		console.error(`[groups] ${group.group_did}: members space unreadable:`, e);
		return { ...off, unreadable: errorText(e) };
	}
}
