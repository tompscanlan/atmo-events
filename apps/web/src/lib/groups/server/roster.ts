// A roster act moves a D1 row, writes a `membership` record and changes the
// group's member lists (./member-list.ts). The order follows the direction of
// the change, so a partial failure always leaves less access than intended:
//
//   * A grant (join, admit, promotion) moves the row first, because the schema
//     refuses an impossible roster, then writes the record, then lists the DID.
//   * A revocation (leave, eject, demotion) runs its checks, then changes the
//     record, which closes atmo's gate, then unlists the DID, then changes the
//     row.
//
// An entry or a role change lists the DID on each space whose `access` grants
// one of its roles `read`, and off the rest, so the lists follow the access
// records. An exit takes it off all three. (Spec: FR-214.) A join request is
// not a roster act: a requester is not a member, so a request, a reject and a
// withdrawal move only the `join_requests` row and write nothing at the group's
// PDS.
//
// The caller's own join and leave also write or delete their acceptance, from
// their own session (./acceptance.ts). It goes in after their members space
// entry, so the host tracks the write, and comes out before that entry does, so
// the host still accepts the notice of the delete. It never stops the act: it
// decides how the roster shows a member, not what they may do.
import { GROUP_ROLES, type GroupRoleName, type AssignableRole } from '../permissions';
import type { GroupRow, GroupVisibility, MemberRow } from '../types';

import { groupSpaceReader, type GroupSpaceReader } from './about-read';

import {
	authorizeMembership,
	dropGroupMembership,
	putGroupMembership,
	type MembershipDrop
} from './members-writer';
import {
	groupMemberList,
	groupSpaces,
	placeMember,
	readSpaceAccess,
	unlistMember,
	type GroupMemberList
} from './member-list';
import { readGroupVisibility } from './spaces';
import { deleteAcceptance, writeAcceptance, type MemberSession } from './acceptance';

import {
	GroupRecordError,
	groupWriter,
	requireGroupPermission,
	requireMembershipWrite,
	type GroupRepoWriter
} from './group-write';
import { errorText } from './errors';
import { type CredentialStoreEnv } from './session';
import { isUnfinishedRow, readGroupMembers, readMembership } from './members-read';
import { GroupRuleError } from './db/rules';
import {
	addMember,
	approveJoinRequest,
	changeMemberRole,
	decideJoinRequest,
	getMemberRow,
	pendingRequestIdOf,
	removeMember,
	requestJoin,
	type JoinOutcome
} from './db/roster';
export type RosterStep = 'record' | 'row' | 'list';
export type RosterChange = 'grant' | 'revoke' | 'assign';

/** A roster act whose earlier half took effect and whose later half failed, so
 *  its pieces are out of step. `step` names the half that failed:
 *
 *  - `record`: a grant whose row moved but whose record did not.
 *  - `row`: a revocation whose record went but whose row did not. The gate
 *    already denies, and a retry removes the row.
 *  - `list`: member-list entries and the record disagree. After a `grant` the
 *    host grants less than the record until Repair lists the DID. After a
 *    `revoke` the record is gone, so atmo already refuses the DID, and a
 *    retry, or Repair, takes away what the host still grants. After an
 *    `assign` the record holds the new role, and Repair lists the DID by it. */
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
	/** The route's reader, so the act reads through the request's session.
	 *  Built from the credential if absent. */
	reader?: GroupSpaceReader | null;
	/** The visibility the route read from the access record, or `null` if it did
	 *  not ask. When absent, a join reads the record itself. */
	visibility?: GroupVisibility | null;
	/** The caller's own session at their PDS, for their acceptance. Absent, or
	 *  someone else's, and no acceptance is touched. */
	member?: MemberSession | null;
}

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

/** A writer that builds the real one on first use, once. */
function writerOnFirstUse(build: () => Promise<GroupRepoWriter>): GroupRepoWriter {
	let built: Promise<GroupRepoWriter> | undefined;
	return async (write) => (await (built ??= build()))(write);
}

/** A member list that builds the real one on first use, once. */
function memberListOnFirstUse(build: () => Promise<GroupMemberList>): GroupMemberList {
	let built: Promise<GroupMemberList> | undefined;
	const list = () => (built ??= build());
	return {
		put: async (entry) => (await list()).put(entry),
		remove: async (entry) => (await list()).remove(entry),
		list: async (query) => (await list()).list(query)
	};
}

/** An act's context, with the gate's reader, and the writer and member list
 *  built from the group's credential on first use. Every step of an act then
 *  talks through one session, and the gate reads the caller's standing once.
 *  An act that never writes a record never asks for the credential. */
type PreparedRoster = RosterContext & {
	reader: GroupSpaceReader | null;
	writer: GroupRepoWriter;
	memberList: GroupMemberList;
};

async function prepared(ctx: RosterContext): Promise<PreparedRoster> {
	return {
		...ctx,
		reader: ctx.reader !== undefined ? ctx.reader : await groupSpaceReader(ctx.env, ctx.group),
		writer: writerOnFirstUse(() => groupWriter(ctx.env, ctx.group)),
		memberList: memberListOnFirstUse(() => groupMemberList(ctx.env, ctx.group))
	};
}

/** The list half of an entry or a role change, after the record: the DID on
 *  each space whose access grants `roles` read, and off the rest. The row and
 *  record are in, so any failure here is the lists out of step. */
async function listed(
	ctx: PreparedRoster,
	subject: string,
	roles: readonly string[],
	change: RosterChange = 'grant'
): Promise<void> {
	await step(
		'list',
		subject,
		async () => {
			if (!ctx.reader) {
				throw new GroupRecordError(
					`${ctx.group.group_did} is not linked, so its access records cannot be read`
				);
			}
			const access = await readSpaceAccess(ctx.reader, ctx.group);
			await placeMember(ctx.memberList, ctx.group, subject, roles, access);
		},
		change
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
 *  write, which deletes the membership record and so closes atmo's gate. Then
 *  the list entries go, the members space's last, and last of all the row.
 *  Whichever later half fails, atmo already refuses the DID, and a retry finds
 *  the row and finishes. A leave deletes the caller's acceptance before any of
 *  them. */
async function revoke(ctx: PreparedRoster, subject: string, intent: MembershipDrop): Promise<void> {
	await changeableRow(ctx, subject);
	await authorizeMembership({ ...ctx, subject, intent });
	// All three spaces are checked before the first write.
	groupSpaces(ctx.group);

	if (intent === 'leave') await unaccept(ctx);
	await dropGroupMembership({ ...ctx, subject, intent });
	await step(
		'list',
		subject,
		async () => unlistMember(ctx.memberList, ctx.group, subject),
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

/** Refuses a grant to a DID on the rows whose membership record is gone while
 *  the members space holds the authz config and others' records. That is an
 *  exit that stopped after its record went, or an admission that stopped before
 *  its record was written, and this site cannot tell which. A grant would write
 *  a fresh record and re-admit a member whose removal failed, so the row is
 *  finished one way only: by removing it, from the members page, which lists it
 *  as not finished. A members space with no records, or no authz config, was
 *  never fully written, so there the rows still decide and a role change writes
 *  the missing record, as Repair advises. A read that fails propagates, so
 *  nothing is written. */
async function requireFinished(ctx: PreparedRoster, did: string): Promise<void> {
	if (!ctx.reader) return;
	if (await readMembership(ctx.reader, ctx.group, did)) return;
	if (!isUnfinishedRow(await readGroupMembers(ctx.reader, ctx.group))) return;
	throw new GroupRuleError(
		'unfinished-removal',
		`${did} has no membership record, so their removal or admission did not finish. Remove them under "Not finished" on the members page; to keep them, add them again after that.`
	);
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
export async function joinedAt(ctx: PreparedRoster, subject: string): Promise<string | undefined> {
	const published = ctx.reader ? await readMembership(ctx.reader, ctx.group, subject) : null;
	if (published?.createdAt) return published.createdAt;
	const row = await getMemberRow(ctx.db, ctx.group.id, subject);
	return row ? new Date(row.created_at).toISOString() : undefined;
}

/** The route's visibility if it read one, else the access record's. With no
 *  credential for the group it is `null`, which refuses a stranger. */
async function joinVisibility(ctx: PreparedRoster): Promise<GroupVisibility | null> {
	if (ctx.visibility !== undefined) return ctx.visibility;
	return ctx.reader ? readGroupVisibility(ctx.reader, ctx.group) : null;
}

/** Self-service join. Only `joined` is published: the groups standard models
 *  a join request as host state, not a record, so a `pending` one writes
 *  nothing at the host, not even an acceptance. A joined caller then writes
 *  theirs, when their session holds the group's grant. (Spec: FR-205, FR-206.) */
export async function joinGroup(
	given: RosterContext,
	message: string | null
): Promise<JoinOutcome> {
	const ctx = await prepared(given);
	const outcome = await requestJoin(
		ctx.db,
		ctx.group,
		ctx.callerDid,
		message,
		await joinVisibility(ctx)
	);
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
	await listed(ctx, ctx.callerDid, ['member']);
	await accept(ctx);
	return outcome;
}

/** Self-service leave. The owner cannot leave. */
export async function leaveGroup(given: RosterContext): Promise<void> {
	const ctx = await prepared(given);
	await revoke(ctx, ctx.callerDid, 'leave');
}

/** Approve a member's pending request. A DID already on the roster is refused
 *  before any record is written, so an approval never publishes a role the row
 *  lacks. */
export async function admitFromRequest(
	given: RosterContext,
	member: string,
	role: AssignableRole
): Promise<{ did: string }> {
	const ctx = await prepared(given);
	// Before the row moves, so a refusal changes nothing. A caller who may admit
	// no one is refused before learning whether the request exists. The gate
	// checks the role the requester would get.
	await requireGroupPermission(ctx, 'ADMIT_MEMBERS');
	const requestId = await pendingRequestIdOf(ctx.db, ctx.group.id, member);
	if (!requestId) throw new GroupRuleError('not-found', 'No such pending join request');
	await requireMembershipWrite(ctx, member, [role]);
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
	await listed(ctx, admitted.did, [role]);
	return admitted;
}

/** Direct add. A request the DID has pending is closed by the same row write. */
export async function admitMember(
	given: RosterContext,
	did: string,
	role: AssignableRole
): Promise<void> {
	const ctx = await prepared(given);
	// Before the row moves, so a refusal changes nothing.
	await requireMembershipWrite(ctx, did, [role]);
	if (await getMemberRow(ctx.db, ctx.group.id, did)) await requireFinished(ctx, did);
	await addMember(ctx.db, ctx.group.id, did, role, ctx.callerDid);
	const createdAt = await step('record', did, () => joinedAt(ctx, did));
	await step('record', did, () =>
		putGroupMembership({ ...ctx, subject: did, roles: [role], createdAt, intent: 'admit' })
	);
	await listed(ctx, did, [role]);
}

/** Withdraw the caller's own pending request, the only one they can name. A
 *  request wrote nothing at the host, so only its row closes. */
export async function withdrawJoinRequest(ctx: RosterContext): Promise<void> {
	const requestId = await pendingRequestIdOf(ctx.db, ctx.group.id, ctx.callerDid);
	if (!requestId) throw new GroupRuleError('not-found', 'No such pending join request');
	await decideJoinRequest(ctx.db, ctx.group.id, requestId, ctx.callerDid, 'withdrawn');
}

/** Reject a member's pending request, behind the same permission as approving
 *  one. */
export async function rejectJoinRequest(given: RosterContext, member: string): Promise<void> {
	const ctx = await prepared(given);
	await requireGroupPermission(ctx, 'ADMIT_MEMBERS');
	const requestId = await pendingRequestIdOf(ctx.db, ctx.group.id, member);
	if (!requestId) throw new GroupRuleError('not-found', 'No such pending join request');
	await decideJoinRequest(ctx.db, ctx.group.id, requestId, ctx.callerDid, 'rejected');
}

/** Eject, behind the same checks as leave. */
export async function ejectMember(given: RosterContext, did: string): Promise<void> {
	await revoke(await prepared(given), did, 'eject');
}

/** Assign a role. A promotion is a grant and a demotion a revocation, each in
 *  its own order (see the file header). Either one lists the DID by its new
 *  role, after the record. */
export async function promoteMember(
	given: RosterContext,
	did: string,
	role: AssignableRole
): Promise<void> {
	const ctx = await prepared(given);
	const current = await changeableRow(ctx, did);
	// Before either half, so a refusal changes nothing.
	await requireMembershipWrite(ctx, did, [role]);
	await requireFinished(ctx, did);
	const createdAt = await joinedAt(ctx, did);
	const writeRecord = () =>
		putGroupMembership({ ...ctx, subject: did, roles: [role], createdAt, intent: 'assign' });
	const moveRow = () => changeMemberRole(ctx.db, ctx.group.id, did, role);

	if (removesAccess(current.role, role)) {
		await writeRecord();
		await listed(ctx, did, [role], 'assign');
		await step('row', did, moveRow);
		return;
	}
	await moveRow();
	await step('record', did, writeRecord);
	await listed(ctx, did, [role], 'assign');
}
