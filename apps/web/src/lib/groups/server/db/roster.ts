// The D1 rows for who is in a group: memberships and join requests. A row is
// a member; a pending request is a join request, never a membership.
import type { AssignableRole } from '../../permissions';
import type { GroupRow, GroupVisibility, JoinRequestRow, MemberRow } from '../../types';
import { ensureGroupsSchema } from '../schema';
import { GroupRuleError, constraintMessage, guard } from './rules';

/** The roster, owner first, then by join time. Roles come back as names. */
/** A roster row as `MemberRow`, for the reads below to filter and order. */
const MEMBER_ROW = `SELECT m.id AS membership_id, m.did, r.name AS role, m.created_at
	FROM memberships m JOIN roles r ON r.id = m.role_id`;

export async function listMembers(db: D1Database, groupId: string): Promise<MemberRow[]> {
	await ensureGroupsSchema(db);
	const { results } = await db
		.prepare(`${MEMBER_ROW} WHERE m.group_id = ? ORDER BY r.is_owner DESC, m.created_at ASC`)
		.bind(groupId)
		.all<MemberRow>();
	return results ?? [];
}

/** One roster row, or null, so `roster.ts` can check one member without
 *  loading the whole roster. */
export async function getMemberRow(
	db: D1Database,
	groupId: string,
	did: string
): Promise<MemberRow | null> {
	await ensureGroupsSchema(db);
	return db
		.prepare(`${MEMBER_ROW} WHERE m.group_id = ? AND m.did = ?`)
		.bind(groupId, did)
		.first<MemberRow>();
}

/** The groups `did` is on the roster of or has a pending request in, oldest
 *  first. Unlike the reads above it does not create the schema: sign-in asks
 *  it on every deployment, so one with no groups tables throws here, and each
 *  caller reads that as no groups. */
export async function groupsOfMember(
	db: D1Database,
	did: string
): Promise<Pick<GroupRow, 'group_did' | 'members_space_uri' | 'created_at'>[]> {
	const { results } = await db
		.prepare(
			`SELECT group_did, members_space_uri, created_at FROM groups
			 WHERE id IN (
			   SELECT group_id FROM memberships WHERE did = ?
			   UNION
			   SELECT group_id FROM join_requests WHERE did = ? AND status = 'pending'
			 )
			 ORDER BY created_at, group_did`
		)
		.bind(did, did)
		.all<Pick<GroupRow, 'group_did' | 'members_space_uri' | 'created_at'>>();
	return results ?? [];
}

export async function listJoinRequests(
	db: D1Database,
	groupId: string,
	status: 'pending' | 'all' = 'pending'
): Promise<JoinRequestRow[]> {
	await ensureGroupsSchema(db);
	const { results } = await db
		.prepare(
			`SELECT id, did, status, message, created_at FROM join_requests
			 WHERE group_id = ? AND (? = 'all' OR status = ?)
			 ORDER BY created_at ASC`
		)
		.bind(groupId, status, status)
		.all<JoinRequestRow>();
	return results ?? [];
}

/** Roster size. A page may show the count to someone not allowed the names. */
export async function countMembers(db: D1Database, groupId: string): Promise<number> {
	await ensureGroupsSchema(db);
	const row = await db
		.prepare(`SELECT COUNT(*) AS n FROM memberships WHERE group_id = ?`)
		.bind(groupId)
		.first<{ n: number }>();
	return row?.n ?? 0;
}

export type JoinOutcome = 'joined' | 'pending' | 'already-member' | 'already-pending';

/** Self-service join. With `require_approval` this records a pending request
 *  and no roster row, so an applicant is never briefly a member. Without it,
 *  the caller joins at once as `member`.
 *
 *  A private group has no self-service join. Its DID and handle are public in
 *  the PLC audit log, so knowing them proves nothing, and answering a request
 *  tells a stranger the group exists. Members are added with `addMember`. The
 *  refusal comes after the roster check, so a member's retry still answers
 *  `already-member`.
 *
 *  `visibility` is the host's answer (`readGroupVisibility`). Only `public`
 *  takes a join. `null` means the host was not asked, and it is refused. */
export async function requestJoin(
	db: D1Database,
	group: GroupRow,
	did: string,
	message: string | null,
	visibility: GroupVisibility | null
): Promise<JoinOutcome> {
	await ensureGroupsSchema(db);
	if (await getMemberRow(db, group.id, did)) return 'already-member';

	if (visibility !== 'public') {
		throw new GroupRuleError('invite-only', 'This group is invite-only');
	}

	if (group.require_approval) {
		try {
			const now = Date.now();
			await db
				.prepare(
					`INSERT INTO join_requests (id, group_id, did, status, message, created_at, updated_at)
					 VALUES (?, ?, ?, 'pending', ?, ?, ?)`
				)
				.bind(crypto.randomUUID(), group.id, did, message, now, now)
				.run();
			return 'pending';
		} catch (e) {
			const mapped = constraintMessage(e);
			if (mapped?.reason === 'already-pending') return 'already-pending';
			throw mapped ?? e;
		}
	}

	await addMember(db, group.id, did, 'member');
	return 'joined';
}

/** Puts `did` on the roster with `role`, for an open join or a direct add. A
 *  DID already on the roster is refused as `GroupRuleError('constraint')`. A
 *  pending request from `did` is closed as approved in the same batch, by
 *  `decidedBy` (null for an open join), so it does not stay in the queue for a
 *  member. */
export async function addMember(
	db: D1Database,
	groupId: string,
	did: string,
	role: AssignableRole,
	decidedBy: string | null = null
): Promise<void> {
	await ensureGroupsSchema(db);
	const now = Date.now();
	await guard(() =>
		db.batch([
			db
				.prepare(
					`INSERT INTO memberships (id, group_id, did, role_id, created_at, updated_at)
					 SELECT ?, ?, ?, r.id, ?, ? FROM roles r
					 WHERE r.group_id = ? AND r.name = ?`
				)
				.bind(crypto.randomUUID(), groupId, did, now, now, groupId, role),
			db
				.prepare(
					`UPDATE join_requests SET status = 'approved', decided_by_did = ?, decided_at = ?,
					   updated_at = ?
					 WHERE group_id = ? AND did = ? AND status = 'pending'`
				)
				.bind(decidedBy, now, now, groupId, did)
		])
	);
}

/** Approve: the request's DID goes on the roster, and the same batch closes its
 *  pending request (`addMember`), so an approved request always has a member
 *  behind it. A DID already on the roster fails the insert, which rolls back the
 *  close, as `GroupRuleError('constraint')`. Returns the admitted DID, which the
 *  caller's membership record is keyed by. */
export async function approveJoinRequest(
	db: D1Database,
	groupId: string,
	requestId: string,
	deciderDid: string,
	role: AssignableRole = 'member'
): Promise<{ did: string }> {
	const did = await pendingRequestDid(db, groupId, requestId);
	if (!did) throw new GroupRuleError('not-found', 'No such pending join request');
	await addMember(db, groupId, did, role, deciderDid);
	return { did };
}

/** The DID behind a pending request, or null when the group has no such
 *  pending request. */
export async function pendingRequestDid(
	db: D1Database,
	groupId: string,
	requestId: string
): Promise<string | null> {
	await ensureGroupsSchema(db);
	const row = await db
		.prepare(`SELECT did FROM join_requests WHERE id = ? AND group_id = ? AND status = 'pending'`)
		.bind(requestId, groupId)
		.first<{ did: string }>();
	return row?.did ?? null;
}

export async function decideJoinRequest(
	db: D1Database,
	groupId: string,
	requestId: string,
	deciderDid: string | null,
	status: 'rejected' | 'withdrawn'
): Promise<void> {
	await ensureGroupsSchema(db);
	const now = Date.now();
	const res = await db
		.prepare(
			`UPDATE join_requests SET status = ?, decided_by_did = ?, decided_at = ?, updated_at = ?
			 WHERE id = ? AND group_id = ? AND status = 'pending'`
		)
		.bind(status, deciderDid, now, now, requestId, groupId)
		.run();
	if ((res.meta?.changes ?? 0) === 0) {
		throw new GroupRuleError('not-found', 'No such pending join request');
	}
}

/** Removes a roster row, for a leave or an eject. A trigger refuses the owner,
 *  as `GroupRuleError('owner-protected')`. */
export async function removeMember(db: D1Database, groupId: string, did: string): Promise<void> {
	await ensureGroupsSchema(db);
	const res = await guard(() =>
		db.prepare(`DELETE FROM memberships WHERE group_id = ? AND did = ?`).bind(groupId, did).run()
	);
	if ((res.meta?.changes ?? 0) === 0) {
		throw new GroupRuleError('not-found', 'That DID is not on the roster');
	}
}

export async function changeMemberRole(
	db: D1Database,
	groupId: string,
	did: string,
	role: AssignableRole
): Promise<void> {
	await ensureGroupsSchema(db);
	const res = await guard(() =>
		db
			.prepare(
				`UPDATE memberships SET role_id = (SELECT id FROM roles WHERE group_id = ? AND name = ?),
				   updated_at = ?
				 WHERE group_id = ? AND did = ?`
			)
			.bind(groupId, role, Date.now(), groupId, did)
			.run()
	);
	if ((res.meta?.changes ?? 0) === 0) {
		throw new GroupRuleError('not-found', 'That DID is not on the roster');
	}
}
