// A roster act is one D1 row move plus one `membership` record write, composed
// here. The row is what the schema checks; the record is what everyone outside
// this app reads. Keeping the pair in one place stops the two from drifting.
//
// THE ORDER FOLLOWS THE DIRECTION OF THE CHANGE. The gate resolves from the
// record (`getCallerMembership`), so whichever half runs second is the one a
// partial failure leaves undone, and that must always leave less access than
// intended, never more:
//
//   * A grant (join, admit, promotion) moves the row first. The repo and the
//     schema refuse an impossible roster (a private group has no self-service
//     join, a DID off the roster cannot be promoted), and writing the record
//     first would publish a grant the database then refused. If the record
//     write fails, the record still grants the old, smaller set, and
//     `RosterRecordError` reports the pair as out of step.
//   * A revocation (leave, eject, demotion) runs a read-only pre-check, then
//     the record, then the row. Row first, a failed record delete would leave
//     the ejected member's record granting everything it granted before. If
//     the record write fails, nothing has changed and it is a plain failure. If
//     the row write fails after it, the gate already denies, and
//     `RosterRowError` reports the roster as out of step.
//
// There is no suspension. A moderator ejects.
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
import {
	GROUP_MEMBERSHIP_COLLECTION,
	isMembershipKey,
	parseGroupMembership
} from '../members-record';
import { dropGroupMembership, putGroupMembership } from './members-writer';

/** A grant whose row moved but whose record did not. Carries the subject, so
 *  the caller can say whose membership is out of step. */
export class RosterRecordError extends Error {
	constructor(
		readonly subject: string,
		readonly cause: unknown
	) {
		super(cause instanceof Error ? cause.message : String(cause));
		this.name = 'RosterRecordError';
	}
}

/** A revocation whose record went but whose row did not. The gate already
 *  denies (no record, no grant), so what is out of step is the roster the app
 *  renders from rows, until a retry removes the row or `rebuildGroupMembers`
 *  reports it as an orphan. */
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
 *  is on the roster and is not the owner. It gives the same refusals as the
 *  repo and the owner-protection triggers, which stay as the backstop. It runs
 *  first because a revocation deletes the record before the row, and a
 *  trigger firing on the row would be too late to save the owner's record. */
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
 * When this member joined, as an ISO date for the record: the published value
 * if there is one, the roster row otherwise. The order matters:
 *
 *   * the record is authoritative while it exists, so a promotion republishes
 *     the date the group already published, not today's;
 *   * the row is what remains when there is no record: a member admitted a
 *     moment ago, whose record this act is about to write, or one whose record
 *     was never written. Reading only the record would restamp such members
 *     with the time of the write.
 *
 * `undefined` means neither source has a date, and the record builder stamps
 * now. Always called BEFORE the role changes, so a role change reads the
 * pre-change row.
 *
 * One `getRecord`, not a roster listing: a membership record's key is the
 * member's DID. An absent record falls through to the row; a read that fails
 * throws, because a date guessed from the row would overwrite a published one.
 */
export async function joinedAt(ctx: RosterContext, subject: string): Promise<string | undefined> {
	const reader =
		ctx.reader !== undefined ? ctx.reader : await groupSpaceReader(ctx.env, ctx.db, ctx.group);
	const space = ctx.group.members_space_uri;
	if (reader && space && isMembershipKey(subject)) {
		const record = await reader.get({
			space,
			repo: ctx.group.group_did,
			collection: GROUP_MEMBERSHIP_COLLECTION,
			rkey: subject
		});
		const published =
			record && record.collection === GROUP_MEMBERSHIP_COLLECTION
				? parseGroupMembership(record.value, record.rkey)
				: null;
		if (published?.createdAt) return published.createdAt;
	}
	const row = await getMemberRow(ctx.db, ctx.group.id, subject);
	return row ? new Date(row.created_at).toISOString() : undefined;
}

/** Self-service join. Only `joined` puts anyone on the roster. `pending` is a
 *  join request, which the draft community standard models as a method, not a
 *  record, and no host serves that method, so nothing is published for it. */
export async function joinGroup(ctx: RosterContext, message: string | null): Promise<JoinOutcome> {
	const outcome = await requestJoin(ctx.db, ctx.group, ctx.callerDid, message);
	if (outcome !== 'joined') return outcome;
	// The row exists now, so its `created_at` is the date the record carries:
	// one clock for both copies, which is what lets the pair survive a rebuild
	// in either direction. The row has moved, so a failed read here is the
	// record half failing, and it is labelled as such.
	const createdAt = await published(ctx.callerDid, () => joinedAt(ctx, ctx.callerDid));
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

/** Self-service leave. It is a revocation, so the record goes first. The owner
 *  cannot leave, and the pre-check says so before the owner's record is
 *  touched. */
export async function leaveGroup(ctx: RosterContext): Promise<void> {
	await changeableRow(ctx, ctx.callerDid);
	await dropGroupMembership({ ...ctx, subject: ctx.callerDid, intent: 'leave' });
	await unlisted(ctx.callerDid, () => removeMember(ctx.db, ctx.group.id, ctx.callerDid));
}

/** Approve a pending request. The applicant is named by the request, which is
 *  why `approveJoinRequest` returns the DID it admitted. */
export async function admitFromRequest(
	ctx: RosterContext,
	requestId: string,
	role: AssignableRole
): Promise<{ did: string }> {
	const admitted = await approveJoinRequest(ctx.db, ctx.group.id, requestId, ctx.callerDid, role);
	const createdAt = await published(admitted.did, () => joinedAt(ctx, admitted.did));
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
	const createdAt = await published(did, () => joinedAt(ctx, did));
	await published(did, () =>
		putGroupMembership({ ...ctx, subject: did, roles: [role], createdAt, intent: 'admit' })
	);
}

/** Eject. It is a revocation, so the record goes first, behind the same
 *  pre-check as leave. */
export async function ejectMember(ctx: RosterContext, did: string): Promise<void> {
	await changeableRow(ctx, did);
	await dropGroupMembership({ ...ctx, subject: did, intent: 'eject' });
	await unlisted(did, () => removeMember(ctx.db, ctx.group.id, did));
}

/** Assign a role. A promotion is a grant and a demotion is a revocation, and
 *  each takes its own order (see the file header). The owner is refused before
 *  either. */
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
