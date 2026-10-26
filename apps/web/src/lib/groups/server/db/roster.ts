// The D1 rows for who is in a group. A pending request is a join request, never a membership.
import type { GroupRow, MemberRow } from '../../types';
import { ensureGroupsSchema } from '../schema';
import { GroupRuleError, constraintMessage, guard } from './rules';

const MEMBER_ROW = `SELECT id AS membership_id, did, role, created_at FROM memberships`;

/** By join time. */
export async function listMembers(db: D1Database, groupId: string): Promise<MemberRow[]> {
	await ensureGroupsSchema(db);
	const { results } = await db
		.prepare(`${MEMBER_ROW} WHERE group_id = ? ORDER BY created_at ASC, did ASC`)
		.bind(groupId)
		.all<MemberRow>();
	return results ?? [];
}

export async function getMemberRow(
	db: D1Database,
	groupId: string,
	did: string
): Promise<MemberRow | null> {
	await ensureGroupsSchema(db);
	return db
		.prepare(`${MEMBER_ROW} WHERE group_id = ? AND did = ?`)
		.bind(groupId, did)
		.first<MemberRow>();
}

/** The groups whose rows list `did` as a member, oldest first. */
export async function groupsOfMember(
	db: D1Database,
	did: string
): Promise<Pick<GroupRow, 'group_did' | 'members_space_uri'>[]> {
	await ensureGroupsSchema(db);
	const { results } = await db
		.prepare(
			`SELECT group_did, members_space_uri FROM groups
			 WHERE id IN (SELECT group_id FROM memberships WHERE did = ?)
			 ORDER BY created_at, group_did`
		)
		.bind(did)
		.all<Pick<GroupRow, 'group_did' | 'members_space_uri'>>();
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

/** No host method reads a member's own request back, so this note is how a page knows. */
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

/** Closes `did`'s pending note if there is one: the host's answer decides, not the note. */
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

/** A pending note from `did` is closed as approved in the same batch, by `decidedBy`
 *  (null for an open join). */
export async function addMember(
	db: D1Database,
	groupId: string,
	did: string,
	role: string,
	decidedBy: string | null = null
): Promise<void> {
	await ensureGroupsSchema(db);
	const now = Date.now();
	await guard(() =>
		db.batch([
			db
				.prepare(
					`INSERT INTO memberships (id, group_id, did, role, created_at, updated_at)
					 VALUES (?, ?, ?, ?, ?, ?)`
				)
				.bind(crypto.randomUUID(), groupId, did, role, now, now),
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
	role: string
): Promise<void> {
	await ensureGroupsSchema(db);
	const res = await guard(() =>
		db
			.prepare(`UPDATE memberships SET role = ?, updated_at = ? WHERE group_id = ? AND did = ?`)
			.bind(role, Date.now(), groupId, did)
			.run()
	);
	if ((res.meta?.changes ?? 0) === 0) {
		throw new GroupRuleError('not-found', 'That DID is not on the roster');
	}
}
