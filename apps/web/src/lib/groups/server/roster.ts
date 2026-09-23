// ONE ROSTER ACT = ONE ROW MOVE + ONE RECORD WRITE, composed here.
//
// Every roster change now has two halves: the D1 row, which the schema
// adjudicates, and the `membership` record, which is what everyone outside this
// app reads. Keeping the pair in one place is what stops them drifting — the
// alternative was the same seven-line try/catch dance repeated in every remote
// handler, and a second copy of it in the e2e harness, which is how a "small"
// difference between what the app does and what the test proves gets in.
//
// THE ORDER FOLLOWS THE DIRECTION OF THE CHANGE (FR-006, TS 2026-09-23). The
// gate resolves from the RECORD (`getCallerMembership`), so whichever half runs
// second is the one a partial failure leaves behind — and it must always leave
// less access than intended, never more:
//
//   * A GRANT — join, admit, promotion — moves the ROW FIRST. The schema is the
//     thing that refuses an impossible roster (a private group has no
//     self-service join, a DID off the roster cannot be promoted), and writing
//     the record first would publish a grant the database then refused. If the
//     record write fails, the record still grants the old, smaller set, and
//     `RosterRecordError` reports the pair as out of step.
//   * A REVOCATION — leave, eject, demotion — runs a READ-ONLY PRE-CHECK, then
//     the RECORD, then the row. Row-first, a failed record delete left the
//     ejected member's record granting everything it granted before. If the
//     record write fails now, nothing has changed and it is a plain failure; if
//     the row write fails after it, the gate already denies, and
//     `RosterRowError` reports the roster as out of step.
//
// The pre-check refuses what the owner-protection triggers would refuse, BEFORE
// the record is gone: by the time a trigger fires on the row, the owner's
// record would already be deleted. The triggers stay as the backstop.
//
// There is no suspension (TS 2026-09-23): it is in neither the
// opensocial.community draft nor permissioned data. A moderator ejects.
import { GROUP_ROLES, type GroupRoleName } from '../permissions';
import type { GroupRow, MemberRow } from '../types';
import type { CredentialStoreEnv } from './credentials';
import {
	GroupRuleError,
	addMember,
	approveJoinRequest,
	changeMemberRole,
	getMemberRow,
	removeMember,
	requestJoin,
	type JoinOutcome
} from './repo';
import { groupSpaceReader, type GroupSpaceReader } from './about-read';
import type { GroupRepoWriter } from './event-writer';
import { readGroupMembers } from './members-read';
import { dropGroupMembership, putGroupMembership } from './members-writer';

/** A GRANT whose row moved and whose record did not. Carries the subject so
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

/** A REVOCATION whose record went and whose row did not. The gate already
 *  denies — no record, no grant — so what is out of step is the roster the app
 *  renders from rows, until a retry or `rebuildGroupMembers` reports it. */
export class RosterRowError extends Error {
	constructor(
		readonly subject: string,
		readonly cause: unknown
	) {
		super(cause instanceof Error ? cause.message : String(cause));
		this.name = 'RosterRowError';
	}
}

/** What a roster act needs: the bindings, the group, and who is asking. A
 *  handler's own context satisfies it structurally. */
export interface RosterContext {
	db: D1Database;
	env: CredentialStoreEnv;
	group: GroupRow;
	callerDid: string;
	/** Override the PDS transport and the gate's reader. Tests pass these. */
	writer?: GroupRepoWriter;
	reader?: GroupSpaceReader | null;
}

type AssignableRole = Exclude<GroupRoleName, 'owner'>;

/** A grant's record half, second: re-labels its failure as out of step. */
async function published<T>(subject: string, write: () => Promise<T>): Promise<T> {
	try {
		return await write();
	} catch (e) {
		throw new RosterRecordError(subject, e);
	}
}

/** A revocation's row half, second: re-labels its failure as out of step. */
async function unlisted(subject: string, write: () => Promise<void>): Promise<void> {
	try {
		await write();
	} catch (e) {
		throw new RosterRowError(subject, e);
	}
}

/** The read-only pre-check in front of a revocation or a role change: the DID
 *  is on the roster and is not the owner. Same refusals, same errors as the
 *  schema's — it runs first only because a revocation deletes the record before
 *  the row, and a trigger firing on the row would be too late to save the
 *  owner's record. */
async function changeableRow(ctx: RosterContext, did: string): Promise<MemberRow> {
	const row = await getMemberRow(ctx.db, ctx.group.id, did);
	if (!row) throw new GroupRuleError('not-found', 'That DID is not on the roster');
	if (row.role === 'owner') {
		throw new GroupRuleError('owner-protected', 'The group owner cannot be changed');
	}
	return row;
}

/** Moving to `to` takes access away from a member holding `from`. GROUP_ROLES
 *  lists the roles most privileged first and each seeded bundle contains the
 *  next one's (`DEFAULT_ROLE_PERMISSIONS`), so position is rank. */
function removesAccess(from: GroupRoleName, to: GroupRoleName): boolean {
	return GROUP_ROLES.indexOf(to) > GROUP_ROLES.indexOf(from);
}

/**
 * WHEN THIS MEMBER JOINED, as an ISO date for the record — the published
 * value if there is one, the roster row otherwise.
 *
 * Both sources, in that order, and the order is the whole point:
 *
 *   * the RECORD is authoritative while it exists, so a promotion republishes
 *     the date the group already published rather than today's;
 *   * the ROW is what remains when it does not — a member admitted a moment
 *     ago, whose record this act is about to write, or one whose record
 *     predates T014. Reading only the record restamped members to the moment
 *     of the write (caught by the live e2e, 2026-09-19).
 *
 * `undefined` means neither source has one, and the record builder stamps now.
 * Always called BEFORE the role changes, so a role change reads the pre-change
 * row.
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

/** Self-service leave — a revocation, so record first. The owner cannot leave,
 *  and the pre-check says so before the owner's record is touched. */
export async function leaveGroup(ctx: RosterContext): Promise<void> {
	await changeableRow(ctx, ctx.callerDid);
	await dropGroupMembership({ ...ctx, subject: ctx.callerDid, intent: 'leave' });
	await unlisted(ctx.callerDid, () => removeMember(ctx.db, ctx.group.id, ctx.callerDid));
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

/** Eject — a revocation, so record first, behind the same pre-check as leave. */
export async function ejectMember(ctx: RosterContext, did: string): Promise<void> {
	await changeableRow(ctx, did);
	await dropGroupMembership({ ...ctx, subject: did, intent: 'eject' });
	await unlisted(did, () => removeMember(ctx.db, ctx.group.id, did));
}

/** Assign a role — a promotion is a grant, a demotion a revocation, and each
 *  takes its own order (TS 2026-09-23). The owner is refused before either. */
export async function promoteMember(
	ctx: RosterContext,
	did: string,
	role: AssignableRole
): Promise<void> {
	const current = await changeableRow(ctx, did);
	const createdAt = await joinedAt(ctx, did);
	const writeRecord = () =>
		putGroupMembership({ ...ctx, subject: did, roles: [role], createdAt, intent: 'assign' });
	const moveRow = () => changeMemberRole(ctx.db, ctx.group.id, did, role);

	if (removesAccess(current.role, role)) {
		await writeRecord();
		await unlisted(did, moveRow);
		return;
	}
	await moveRow();
	await published(did, writeRecord);
}
