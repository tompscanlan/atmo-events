// ONE ROSTER ACT = ONE ROW MOVE + ONE RECORD WRITE, composed here.
//
// Every roster change now has two halves: the D1 row, which the schema
// adjudicates, and the `membership` record, which is what everyone outside this
// app reads. Keeping the pair in one place is what stops them drifting — the
// alternative was the same seven-line try/catch dance repeated in every remote
// handler, and a second copy of it in the e2e harness, which is how a "small"
// difference between what the app does and what the test proves gets in.
//
// THE ORDER IS D1 FIRST, ALWAYS. The schema is the thing that refuses an
// impossible roster: the owner cannot be demoted, removed or suspended, a
// private group has no self-service join, a DID that is not on the roster
// cannot be promoted. Writing the record first would publish a grant the
// database then refused, and a record is visible to other apps the moment it
// lands.
//
// A FAILED RECORD WRITE IS NOT A FAILED MUTATION. The row moved; the roster the
// app renders falls back to the rows (`./members-read.ts`). So the record half
// throws `RosterRecordError`, which the caller reports as what it is — out of
// step — rather than as "that did not work".
import type { GroupRoleName } from '../permissions';
import type { GroupRow } from '../types';
import type { CredentialStoreEnv } from './credentials';
import {
	addMember,
	approveJoinRequest,
	changeMemberRole,
	getMemberRow,
	removeMember,
	requestJoin,
	setMemberStatus,
	type JoinOutcome
} from './repo';
import { groupSpaceReader } from './about-read';
import { readGroupMembers } from './members-read';
import { dropGroupMembership, putGroupMembership } from './members-writer';

/** The D1 half succeeded and the record half did not. Carries the subject so
 *  the caller can say WHOSE membership is out of step. */
export class RosterRecordError extends Error {
	constructor(
		readonly subject: string,
		readonly cause: unknown
	) {
		super(cause instanceof Error ? cause.message : String(cause));
		this.name = 'RosterRecordError';
	}
}

/** What a roster act needs: the bindings, the group, and who is asking. A
 *  handler's own context satisfies it structurally. */
export interface RosterContext {
	db: D1Database;
	env: CredentialStoreEnv;
	group: GroupRow;
	callerDid: string;
}

type AssignableRole = Exclude<GroupRoleName, 'owner'>;

/** Runs the record half and re-labels its failure. */
async function published<T>(subject: string, write: () => Promise<T>): Promise<T> {
	try {
		return await write();
	} catch (e) {
		throw new RosterRecordError(subject, e);
	}
}

/**
 * WHEN THIS MEMBER JOINED, as an ISO date for the record — the published
 * value if there is one, the roster row otherwise.
 *
 * Both sources, in that order, and the order is the whole point:
 *
 *   * the RECORD is authoritative while it exists, so a promotion republishes
 *     the date the group already published rather than today's;
 *   * the ROW is what remains when it does not. A suspension DELETES the
 *     record, so by the time a member is reinstated the only copy of their
 *     join date is `memberships.created_at` — which is exactly the job the
 *     projection is kept for. Reading the record first and stopping there
 *     restamped every reinstated member to the moment they came back (caught
 *     by the live e2e, 2026-09-19).
 *
 * `undefined` means neither source has one, and the record builder stamps now.
 * Always called BEFORE the row moves, so a promotion reads the pre-change row.
 */
export async function joinedAt(ctx: RosterContext, subject: string): Promise<string | undefined> {
	const reader = await groupSpaceReader(ctx.env, ctx.db, ctx.group);
	if (reader) {
		const members = await readGroupMembers(reader, ctx.group);
		const published = members.memberships.find((record) => record.subject === subject);
		if (published?.createdAt) return published.createdAt;
	}
	const row = await getMemberRow(ctx.db, ctx.group.id, subject);
	return row ? new Date(row.created_at).toISOString() : undefined;
}

/** Self-service join. Only `joined` put anyone on the roster: `pending` is a
 *  join request, which the standard makes a METHOD rather than a record and no
 *  host serves, so nothing is published for it (OQ-B). */
export async function joinGroup(
	ctx: RosterContext,
	message: string | null
): Promise<JoinOutcome> {
	const outcome = await requestJoin(ctx.db, ctx.group, ctx.callerDid, message);
	if (outcome !== 'joined') return outcome;
	// The row exists now, so its `created_at` is the date the record carries:
	// one clock for both copies, which is what lets the pair survive a rebuild
	// in either direction.
	const createdAt = await joinedAt(ctx, ctx.callerDid);
	await published(ctx.callerDid, () =>
		putGroupMembership({
			...ctx,
			subject: ctx.callerDid,
			roles: ['member'],
			createdAt,
			intent: 'join'
		})
	);
	return outcome;
}

/** Self-service leave. The owner cannot: `memberships_owner_undeletable`
 *  refuses the DELETE, so the record is never touched. */
export async function leaveGroup(ctx: RosterContext): Promise<void> {
	await removeMember(ctx.db, ctx.group.id, ctx.callerDid);
	await published(ctx.callerDid, () =>
		dropGroupMembership({ ...ctx, subject: ctx.callerDid, intent: 'leave' })
	);
}

/** Approve a pending request. The applicant is named by the REQUEST, which is
 *  why `approveJoinRequest` returns the DID it admitted. */
export async function admitFromRequest(
	ctx: RosterContext,
	requestId: string,
	role: AssignableRole
): Promise<{ did: string }> {
	const admitted = await approveJoinRequest(ctx.db, ctx.group.id, requestId, ctx.callerDid, role);
	const createdAt = await joinedAt(ctx, admitted.did);
	await published(admitted.did, () =>
		putGroupMembership({
			...ctx,
			subject: admitted.did,
			roles: [role],
			createdAt,
			intent: 'admit'
		})
	);
	return admitted;
}

/** Direct add, without a request. */
export async function admitMember(
	ctx: RosterContext,
	did: string,
	role: AssignableRole
): Promise<void> {
	await addMember(ctx.db, ctx.group.id, did, role);
	const createdAt = await joinedAt(ctx, did);
	await published(did, () =>
		putGroupMembership({ ...ctx, subject: did, roles: [role], createdAt, intent: 'admit' })
	);
}

export async function ejectMember(ctx: RosterContext, did: string): Promise<void> {
	await removeMember(ctx.db, ctx.group.id, did);
	await published(did, () => dropGroupMembership({ ...ctx, subject: did, intent: 'eject' }));
}

export async function promoteMember(
	ctx: RosterContext,
	did: string,
	role: AssignableRole
): Promise<void> {
	const createdAt = await joinedAt(ctx, did);
	await changeMemberRole(ctx.db, ctx.group.id, did, role);
	await published(did, () =>
		putGroupMembership({ ...ctx, subject: did, roles: [role], createdAt, intent: 'assign' })
	);
}

/**
 * Suspend or reinstate.
 *
 * SUSPENSION REVOKES THE RECORD; reinstatement writes it again. A suspended
 * member has no access, and access is what a membership record grants, so
 * leaving one in place would publish a grant this app refuses — and any second
 * app reading the space would honour it. What the member returns TO — their
 * role and their join date — survives in the row, which is the whole reason
 * the projection is kept.
 */
export async function setMemberAccess(
	ctx: RosterContext,
	did: string,
	status: 'active' | 'suspended'
): Promise<void> {
	await setMemberStatus(ctx.db, ctx.group.id, did, status);

	if (status === 'suspended') {
		await published(did, () => dropGroupMembership({ ...ctx, subject: did, intent: 'suspend' }));
		return;
	}

	// Both values come off the row this call just reactivated: the record was
	// deleted by the suspension, so the row is the only thing that remembers
	// either of them.
	const restored = await getMemberRow(ctx.db, ctx.group.id, did);
	if (!restored) {
		throw new RosterRecordError(did, new Error('the reinstated row names no role'));
	}
	await published(did, () =>
		putGroupMembership({
			...ctx,
			subject: did,
			roles: [restored.role],
			createdAt: new Date(restored.created_at).toISOString(),
			intent: 'reinstate'
		})
	);
}
