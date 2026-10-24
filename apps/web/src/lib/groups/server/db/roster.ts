// The D1 rows for who is in a group: memberships and join requests. A row is
// a member; a pending request is a join request, never a membership.
import type { AssignableRole } from '../../permissions';
import type { GroupRow, MemberRow } from '../../types';
import { ensureGroupsSchema } from '../schema';
import { GroupRuleError, constraintMessage, guard } from './rules';

/** A roster row as `MemberRow`, for the reads below to filter and order. Roles
 *  come back as names. */
const MEMBER_ROW = `SELECT m.id AS membership_id, m.did, r.name AS role, m.created_at
	FROM memberships m JOIN roles r ON r.id = m.role_id`;

/** The roster, by join time. */
export async function listMembers(db: D1Database, groupId: string): Promise<MemberRow[]> {
	await ensureGroupsSchema(db);
	const { results } = await db
		.prepare(`${MEMBER_ROW} WHERE m.group_id = ? ORDER BY m.created_at ASC, m.did ASC`)
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

/** The groups `did` is on the roster of and, unless `requests` is false, has a
 *  pending request in, oldest first. Unlike the reads above it does not create
 *  the schema: sign-in asks it on every deployment, so one with no groups
 *  tables throws here, and each caller reads that as no groups. */
export async function groupsOfMember(
	db: D1Database,
	did: string,
	{ requests = true }: { requests?: boolean } = {}
): Promise<Pick<GroupRow, 'group_did' | 'members_space_uri' | 'created_at'>[]> {
	const pending = requests
		? `UNION SELECT group_id FROM join_requests WHERE did = ? AND status = 'pending'`
		: '';
	const { results } = await db
		.prepare(
			`SELECT group_did, members_space_uri, created_at FROM groups
			 WHERE id IN (SELECT group_id FROM memberships WHERE did = ? ${pending})
			 ORDER BY created_at, group_did`
		)
		.bind(...(requests ? [did, did] : [did]))
		.all<Pick<GroupRow, 'group_did' | 'members_space_uri' | 'created_at'>>();
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

/** This app's note that `did` asked to join, since no host method reads a
 *  member's own request back. `already-pending` when one is there. */
export async function noteJoinRequest(
	db: D1Database,
	groupId: string,
	did: string,
	message: string | null
): Promise<'pending' | 'already-pending'> {
	await ensureGroupsSchema(db);
	try {
		const now = Date.now();
		await db
			.prepare(
				`INSERT INTO join_requests (id, group_id, did, status, message, created_at, updated_at)
				 VALUES (?, ?, ?, 'pending', ?, ?, ?)`
			)
			.bind(crypto.randomUUID(), groupId, did, message, now, now)
			.run();
		return 'pending';
	} catch (e) {
		const mapped = constraintMessage(e);
		if (mapped?.reason === 'already-pending') return 'already-pending';
		throw mapped ?? e;
	}
}

/** Closes `did`'s pending request row if there is one, and does nothing if not:
 *  the row is only a note, and the host's answer decides. */
export async function closeJoinRequestNote(
	db: D1Database,
	groupId: string,
	did: string,
	deciderDid: string | null,
	status: 'rejected' | 'withdrawn'
): Promise<void> {
	const requestId = await pendingRequestIdOf(db, groupId, did);
	if (!requestId) return;
	try {
		await decideJoinRequest(db, groupId, requestId, deciderDid, status);
	} catch (e) {
		// Closed between the read and the write: what was wanted.
		if (!(e instanceof GroupRuleError && e.reason === 'not-found')) throw e;
	}
}

/** Puts `did` on the roster with `role`, as the host admitted them. A
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

/** The id of a person's pending request, or null when they have none. A host
 *  names a request by its member (`denyJoinRequest`), and the one-pending index
 *  makes that a single row; the id is this app's own. */
export async function pendingRequestIdOf(
	db: D1Database,
	groupId: string,
	did: string
): Promise<string | null> {
	await ensureGroupsSchema(db);
	const row = await db
		.prepare(`SELECT id FROM join_requests WHERE group_id = ? AND did = ? AND status = 'pending'`)
		.bind(groupId, did)
		.first<{ id: string }>();
	return row?.id ?? null;
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

/** Removes a roster row, for a leave or an eject. The creator's row is one
 *  like any other. */
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
