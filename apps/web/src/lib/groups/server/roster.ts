// A roster act moves a D1 row, writes a `membership` record and, for an entry
// or an exit, changes both of the group's member lists (./member-list.ts). The
// order follows the direction of the change, so a partial failure always
// leaves less access than intended:
//
//   * A grant (join, admit, promotion) moves the row first, because the schema
//     refuses an impossible roster, then writes the record, then lists the DID.
//   * A revocation (leave, eject, demotion) runs its checks, then unlists the
//     DID, then changes the record, then the row.
//
// A role change never touches the lists. A join request is not a roster act,
// but it follows the same rule: its row goes in before the requester's
// write-only entry, and the entry comes off before a reject or a withdrawal
// closes the row.
//
// The caller's own acts (join, request, leave, withdraw) also write or delete
// their acceptance, from their own session (./acceptance.ts). It goes in after
// their write-only entry, so the host tracks the write, and comes out before
// that entry does, so the host still accepts the notice of the delete. It never
// stops the act: it decides how the roster shows a member, not what they may do.
import { GROUP_ROLES, type GroupRoleName } from '../permissions';
import type { GroupRow, GroupVisibility, MemberRow } from '../types';
import type { CredentialStoreEnv } from './credentials';
import {
	GroupRuleError,
	addMember,
	approveJoinRequest,
	changeMemberRole,
	decideJoinRequest,
	getMemberRow,
	pendingRequestDid,
	removeMember,
	requestJoin,
	type JoinOutcome
} from './repo';
import { groupSpaceReader, type GroupSpaceReader } from './about-read';

import {
	GROUP_MEMBERSHIP_COLLECTION,
	isMembershipKey,
	parseGroupMembership
} from '../members-record';
import {
	authorizeMembership,
	dropGroupMembership,
	putGroupMembership,
	type MembershipDrop
} from './members-writer';
import {
	aboutSpace,
	groupMemberList,
	listJoinRequester,
	listRosterMember,
	membersSpace,
	unlistJoinRequester,
	type GroupMemberList
} from './member-list';
import { readGroupVisibility } from './spaces';
import { deleteAcceptance, writeAcceptance, type MemberSession } from './acceptance';

import { requireGroupPermission, type GroupRepoWriter } from './group-write';
import { errorText } from './errors';
export type RosterStep = 'record' | 'row' | 'list';
export type RosterChange = 'grant' | 'revoke' | 'request';

/** A roster act whose earlier half took effect and whose later half failed, so
 *  its pieces are out of step. `step` names the half that failed:
 *
 *  - `record`: a grant whose row moved but whose record did not.
 *  - `row`: a revocation whose record went but whose row did not. The gate
 *    already denies, and a retry removes the row.
 *  - `list`: member-list entries and the record disagree. After a `grant` the
 *    host grants less than the record until Repair lists the DID. After a
 *    `revoke` the host already denies reads, and a retry finishes the removal.
 *    After a `request` the request stands, but the host would not track the
 *    requester's acceptance until Repair lists them. */
export class RosterStepError extends Error {
	constructor(
		readonly step: RosterStep,
		readonly subject: string,
		readonly cause: unknown,
		readonly change?: RosterChange
	) {
		super(errorText(cause));
		this.name = 'RosterStepError';
	}
}

/** What a roster act needs. A handler's own context satisfies it. */
export interface RosterContext {
	db: D1Database;
	env: CredentialStoreEnv;
	group: GroupRow;
	callerDid: string;
	/** Override the PDS transport and the gate's reader. Tests pass these. */
	writer?: GroupRepoWriter;
	reader?: GroupSpaceReader | null;
	/** Override the member-list transport. Built from the credential if absent. */
	memberList?: GroupMemberList;
	/** The visibility the route read from the host, or `null` if it did not ask.
	 *  When absent, a join asks the host itself. */
	visibility?: GroupVisibility | null;
	/** The caller's own session at their PDS, for their acceptance. Absent, or
	 *  someone else's, and no acceptance is touched. */
	member?: MemberSession | null;
}

type AssignableRole = Exclude<GroupRoleName, 'owner'>;

/** Runs a later half of a roster act, labelling a failure with that half, since
 *  an earlier half already took effect. */
async function step<T>(
	failed: RosterStep,
	subject: string,
	write: () => Promise<T>,
	change?: RosterChange
): Promise<T> {
	try {
		return await write();
	} catch (e) {
		throw new RosterStepError(failed, subject, e, change);
	}
}

function memberListFor(ctx: RosterContext): Promise<GroupMemberList> {
	return ctx.memberList ? Promise.resolve(ctx.memberList) : groupMemberList(ctx.env, ctx.group);
}

/** An entry's list half, last. The row and record are in, so any failure here
 *  is the lists out of step. */
async function listed(ctx: RosterContext, subject: string): Promise<void> {
	await step(
		'list',
		subject,
		async () => listRosterMember(await memberListFor(ctx), ctx.group, subject),
		'grant'
	);
}

/** The session, when it is the caller's own. */
function callerSession(ctx: RosterContext): MemberSession | null {
	return ctx.member && ctx.member.did === ctx.callerDid ? ctx.member : null;
}

/** The caller writes their acceptance. A failure is logged, and a sign-in that
 *  holds the grant writes it later. */
async function accept(ctx: RosterContext): Promise<void> {
	const member = callerSession(ctx);
	if (!member) return;
	try {
		await writeAcceptance(member, ctx.group);
	} catch (e) {
		console.warn(`[groups] ${member.did} wrote no acceptance in ${ctx.group.group_did}:`, e);
	}
}

/** The caller deletes their acceptance. A failure is logged and the act goes on:
 *  an acceptance with no membership never reaches the roster. */
async function unaccept(ctx: RosterContext): Promise<void> {
	const member = callerSession(ctx);
	if (!member) return;
	try {
		await deleteAcceptance(member, ctx.group);
	} catch (e) {
		console.warn(`[groups] ${member.did}'s acceptance in ${ctx.group.group_did} stays:`, e);
	}
}

/** Leave and eject. Every check, the gate included, runs before the first
 *  write, because the list entries go first: read access, then the write-only
 *  entry. Once the first is gone, any failure leaves the DID unable to read.
 *  A leave deletes the caller's acceptance before either. */
async function revoke(ctx: RosterContext, subject: string, intent: MembershipDrop): Promise<void> {
	await changeableRow(ctx, subject);
	await authorizeMembership({ ...ctx, subject, intent });
	const about = aboutSpace(ctx.group);
	const members = membersSpace(ctx.group);
	const list = await memberListFor(ctx);

	if (intent === 'leave') await unaccept(ctx);
	await list.remove({ space: about, did: subject });
	await step(
		'list',
		subject,
		async () => {
			await list.remove({ space: members, did: subject });
			await dropGroupMembership({ ...ctx, subject, intent });
		},
		'revoke'
	);
	await step('row', subject, () => removeMember(ctx.db, ctx.group.id, subject));
}

/** The DID is on the roster and is not the owner. The triggers check this too,
 *  but only on the row, which a revocation changes last. */
async function changeableRow(ctx: RosterContext, did: string): Promise<MemberRow> {
	const row = await getMemberRow(ctx.db, ctx.group.id, did);
	if (!row) throw new GroupRuleError('not-found', 'That DID is not on the roster');
	if (row.role === 'owner') {
		throw new GroupRuleError('owner-protected', 'The group owner cannot be changed');
	}
	return row;
}

/** `GROUP_ROLES` is most privileged first, and each seeded bundle contains the
 *  next one's, so position is rank. */
function removesAccess(from: GroupRoleName, to: GroupRoleName): boolean {
	return GROUP_ROLES.indexOf(to) > GROUP_ROLES.indexOf(from);
}

/**
 * When this member joined, as an ISO date: the record's, so a promotion keeps
 * the published date, else the roster row's, for a member with no record yet.
 * `undefined` lets the record builder stamp now. A failed record read throws,
 * because a date from the row would overwrite a published one.
 */
export async function joinedAt(ctx: RosterContext, subject: string): Promise<string | undefined> {
	const reader = ctx.reader !== undefined ? ctx.reader : await groupSpaceReader(ctx.env, ctx.group);
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

/** The route's visibility if it read one, else the host's. With no credential
 *  for the group it is `null`, which refuses a stranger. */
async function joinVisibility(ctx: RosterContext): Promise<GroupVisibility | null> {
	if (ctx.visibility !== undefined) return ctx.visibility;
	const reader = ctx.reader !== undefined ? ctx.reader : await groupSpaceReader(ctx.env, ctx.group);
	return reader ? readGroupVisibility(reader, ctx.group) : null;
}

/** Self-service join. Only `joined` is published: the groups standard models
 *  a join request as host state, not a record. A `pending` request still puts
 *  the requester on the members space's list, write-only, because they write
 *  their acceptance at request time (spec 003 FR-206). Either way the caller
 *  then writes it, when their session holds the group's grant. */
export async function joinGroup(ctx: RosterContext, message: string | null): Promise<JoinOutcome> {
	const outcome = await requestJoin(
		ctx.db,
		ctx.group,
		ctx.callerDid,
		message,
		await joinVisibility(ctx)
	);
	if (outcome === 'pending') {
		await step(
			'list',
			ctx.callerDid,
			async () => listJoinRequester(await memberListFor(ctx), ctx.group, ctx.callerDid),
			'request'
		);
		await accept(ctx);
		return outcome;
	}
	if (outcome !== 'joined') return outcome;
	// The record carries the row's `created_at`, so both copies share one clock.
	// The row has moved, so a failed read here is the record half failing.
	const createdAt = await step('record', ctx.callerDid, () => joinedAt(ctx, ctx.callerDid));
	await step('record', ctx.callerDid, () =>
		putGroupMembership({
			...ctx,
			subject: ctx.callerDid,
			roles: ['member'],
			createdAt,
			intent: 'join'
		})
	);
	await listed(ctx, ctx.callerDid);
	await accept(ctx);
	return outcome;
}

/** Self-service leave. The owner cannot leave. */
export async function leaveGroup(ctx: RosterContext): Promise<void> {
	await revoke(ctx, ctx.callerDid, 'leave');
}

/** Approve a pending request. A DID already on the roster is refused before
 *  any record is written, so an approval never publishes a role the row lacks. */
export async function admitFromRequest(
	ctx: RosterContext,
	requestId: string,
	role: AssignableRole
): Promise<{ did: string }> {
	const admitted = await approveJoinRequest(ctx.db, ctx.group.id, requestId, ctx.callerDid, role);
	const createdAt = await step('record', admitted.did, () => joinedAt(ctx, admitted.did));
	await step('record', admitted.did, () =>
		putGroupMembership({
			...ctx,
			subject: admitted.did,
			roles: [role],
			createdAt,
			intent: 'admit'
		})
	);
	await listed(ctx, admitted.did);
	return admitted;
}

/** Direct add. A request the DID has pending is closed by the same row write. */
export async function admitMember(
	ctx: RosterContext,
	did: string,
	role: AssignableRole
): Promise<void> {
	await addMember(ctx.db, ctx.group.id, did, role, ctx.callerDid);
	const createdAt = await step('record', did, () => joinedAt(ctx, did));
	await step('record', did, () =>
		putGroupMembership({ ...ctx, subject: did, roles: [role], createdAt, intent: 'admit' })
	);
	await listed(ctx, did);
}

/** Takes a pending request's write-only entry off, then closes the request.
 *  The entry goes first, so a failed close leaves a request the host does not
 *  track, which Repair lists again, rather than a closed one it still does. A
 *  withdrawal deletes the requester's acceptance before the entry. */
async function closeRequest(
	ctx: RosterContext,
	requestId: string,
	did: string,
	status: 'rejected' | 'withdrawn'
): Promise<void> {
	const list = await memberListFor(ctx);
	if (status === 'withdrawn') await unaccept(ctx);
	await unlistJoinRequester(list, ctx.group, did);
	await decideJoinRequest(ctx.db, ctx.group.id, requestId, ctx.callerDid, status);
}

/** Withdraw the caller's own pending request. */
export async function withdrawJoinRequest(ctx: RosterContext, requestId: string): Promise<void> {
	const did = await pendingRequestDid(ctx.db, ctx.group.id, requestId);
	if (did !== ctx.callerDid) {
		throw new GroupRuleError('not-found', 'No such pending join request');
	}
	await closeRequest(ctx, requestId, did, 'withdrawn');
}

/** Reject a pending request, behind the same permission as approving one. */
export async function rejectJoinRequest(ctx: RosterContext, requestId: string): Promise<void> {
	await requireGroupPermission(ctx, 'ADMIT_MEMBERS');
	const did = await pendingRequestDid(ctx.db, ctx.group.id, requestId);
	if (!did) throw new GroupRuleError('not-found', 'No such pending join request');
	await closeRequest(ctx, requestId, did, 'rejected');
}

/** Eject, behind the same checks as leave. */
export async function ejectMember(ctx: RosterContext, did: string): Promise<void> {
	await revoke(ctx, did, 'eject');
}

/** Assign a role. A promotion is a grant and a demotion a revocation, each in
 *  its own order (see the file header). */
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
		await step('row', did, moveRow);
		return;
	}
	await moveRow();
	await step('record', did, writeRecord);
}
