// A roster act moves a D1 row, writes a `membership` record and, for an entry
// or an exit, changes the about space's member list (./member-list.ts). The
// order follows the direction of the change, so a partial failure always
// leaves less access than intended:
//
//   * A grant (join, admit, promotion) moves the row first, because the schema
//     refuses an impossible roster, then writes the record, then lists the DID.
//   * A revocation (leave, eject, demotion) runs its checks, then unlists the
//     DID, then changes the record, then the row.
//
// A role change never touches the list.
import { GROUP_ROLES, type GroupRoleName } from '../permissions';
import type { GroupRow, GroupVisibility, MemberRow } from '../types';
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
import {
	authorizeMembership,
	dropGroupMembership,
	putGroupMembership,
	type MembershipDrop
} from './members-writer';
import { aboutSpace, groupMemberList, putAboutMember, type GroupMemberList } from './member-list';
import { readGroupVisibility } from './spaces';

/** A grant whose row moved but whose record did not. */
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
 *  denies, and a retry removes the row. */
export class RosterRowError extends Error {
	constructor(
		readonly subject: string,
		readonly cause: unknown
	) {
		super(cause instanceof Error ? cause.message : String(cause));
		this.name = 'RosterRowError';
	}
}

/** An act whose member-list entry and record disagree. After a `grant` the
 *  host grants less than the record until Repair lists the DID. After a
 *  `revoke` the host already denies, and a retry finishes the removal. */
export class RosterListError extends Error {
	constructor(
		readonly subject: string,
		readonly change: 'grant' | 'revoke',
		readonly cause: unknown
	) {
		super(cause instanceof Error ? cause.message : String(cause));
		this.name = 'RosterListError';
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

/** A revocation's row half, last: re-labels its failure as out of step. */
async function unlisted(subject: string, write: () => Promise<void>): Promise<void> {
	try {
		await write();
	} catch (e) {
		throw new RosterRowError(subject, e);
	}
}

function memberListFor(ctx: RosterContext): Promise<GroupMemberList> {
	return ctx.memberList
		? Promise.resolve(ctx.memberList)
		: groupMemberList(ctx.env, ctx.db, ctx.group);
}

/** An entry's list half, last. The row and record are in, so any failure here
 *  is the list out of step. */
async function listed(ctx: RosterContext, subject: string): Promise<void> {
	try {
		await putAboutMember(await memberListFor(ctx), ctx.group, subject);
	} catch (e) {
		throw new RosterListError(subject, 'grant', e);
	}
}

/** Leave and eject. Every check, the gate included, runs before the first
 *  write, because the list entry goes first. */
async function revoke(ctx: RosterContext, subject: string, intent: MembershipDrop): Promise<void> {
	await changeableRow(ctx, subject);
	await authorizeMembership({ ...ctx, subject, intent });
	const space = aboutSpace(ctx.group);
	const list = await memberListFor(ctx);

	await list.remove({ space, did: subject });
	try {
		await dropGroupMembership({ ...ctx, subject, intent });
	} catch (e) {
		throw new RosterListError(subject, 'revoke', e);
	}
	await unlisted(subject, () => removeMember(ctx.db, ctx.group.id, subject));
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

/** The route's visibility if it read one, else the host's. With no credential
 *  for the group it is `null`, which refuses a stranger. */
async function joinVisibility(ctx: RosterContext): Promise<GroupVisibility | null> {
	if (ctx.visibility !== undefined) return ctx.visibility;
	const reader =
		ctx.reader !== undefined ? ctx.reader : await groupSpaceReader(ctx.env, ctx.db, ctx.group);
	return reader ? readGroupVisibility(reader, ctx.group) : null;
}

/** Self-service join. Only `joined` is published and listed: the draft
 *  community standard models a join request as a method, not a record. */
export async function joinGroup(ctx: RosterContext, message: string | null): Promise<JoinOutcome> {
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
	await listed(ctx, ctx.callerDid);
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
	const createdAt = await published(did, () => joinedAt(ctx, did));
	await published(did, () =>
		putGroupMembership({ ...ctx, subject: did, roles: [role], createdAt, intent: 'admit' })
	);
	await listed(ctx, did);
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
		await unlisted(did, moveRow);
		return;
	}
	await moveRow();
	await published(did, writeRecord);
}
