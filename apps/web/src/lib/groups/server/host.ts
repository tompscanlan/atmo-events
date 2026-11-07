// The group host, by the proposal's methods. A person's own acts (join, cancel, leave) go
// out on their own session, proxied to the group's PDS; an admin's go out on their linked
// group session, which the host cuts to their roles. The host decides every one: there is
// no check here it does not also make, and no list kept apart from its records.
import { GROUP_ROLES, type GroupRoleName } from '../permissions';
import {
	GROUP_MEMBERSHIP_COLLECTION,
	groupAccessRecord,
	groupMembershipRecord,
	membershipRkey
} from '../members-record';
import { CALENDAR_SPACE_TYPE, membersSpaceUri, SPACE_SKEY } from '../ids';
import { accept, unaccept } from './acceptance';
import type { CallerSession } from './caller';
import type { GroupWriter } from './context';
import { parseGroupMembership } from '../members-record';
import { isRecordNotFound, xrpc, XrpcError, type XrpcRequest } from './xrpc';

const NS = 'group.opensocial';
const MAX_LISTED_REQUESTS = 1000;

/** In words a page can show. The host's own message is never kept: it can carry what a
 *  user typed. */
export class GroupActionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'GroupActionError';
	}
}

function refusal(e: unknown): unknown {
	if (!(e instanceof XrpcError)) return e;
	switch (e.error) {
		case 'JoinClosed':
			return new GroupActionError('This group is invite-only.');
		case 'JoinRequestNotFound':
			return new GroupActionError('There is no such pending request.');
		case 'RecordAlreadyExists':
			return new GroupActionError('That account is already a member.');
		case 'ScopeMissingError':
		case 'Forbidden':
			return new GroupActionError('Your roles in this group do not allow that.');
		default:
			return e;
	}
}

async function asMember(
	member: CallerSession,
	groupDid: string,
	method: string,
	body: Record<string, unknown> = {}
): Promise<Record<string, unknown>> {
	const proxied = (pathname: string, init: RequestInit) =>
		member.handle(pathname, {
			...init,
			headers: { ...init.headers, 'atproto-proxy': `${groupDid}#atproto_pds` }
		});
	try {
		return await xrpc(proxied, `${NS}.${method}`, { body: { group: groupDid, ...body } });
	} catch (e) {
		throw refusal(e);
	}
}

async function asGroup(writer: GroupWriter, method: string, request: XrpcRequest) {
	try {
		return await xrpc(writer.handle, method.includes('.') ? method : `${NS}.${method}`, request);
	} catch (e) {
		throw refusal(e);
	}
}

export type JoinOutcome = 'joined' | 'pending';

/** An open group admits at once, and the new member confirms; any other waits for an admin. */
export async function requestJoin(
	member: CallerSession,
	groupDid: string,
	message: string | null
): Promise<JoinOutcome> {
	const answer = await asMember(member, groupDid, 'requestJoin', message ? { message } : {});
	if (answer.status === 'admitted') {
		await accept(member, groupDid);
		return 'joined';
	}
	if (answer.status === 'pending') return 'pending';
	throw new Error(`${NS}.requestJoin answered status ${String(answer.status)}`);
}

/** Gone at the host either way: withdrawn now, or decided already. */
export async function cancelJoinRequest(member: CallerSession, groupDid: string): Promise<void> {
	try {
		await asMember(member, groupDid, 'cancelJoinRequest');
	} catch (e) {
		if (e instanceof GroupActionError) return;
		throw e;
	}
}

/** The acceptance goes first, while the host still lets them write it. */
export async function leaveGroup(member: CallerSession, groupDid: string): Promise<void> {
	await unaccept(member, groupDid);
	await asMember(member, groupDid, 'leaveGroup');
}

export interface JoinRequest {
	did: string;
	message: string | null;
	createdAt: number;
}

export async function listJoinRequests(writer: GroupWriter): Promise<JoinRequest[]> {
	const requests: JoinRequest[] = [];
	let cursor: string | undefined;
	do {
		const page = await asGroup(writer, 'listJoinRequests', {
			query: { limit: '100', ...(cursor ? { cursor } : {}) }
		});
		for (const r of Array.isArray(page.requests) ? page.requests : []) {
			const { member, createdAt, message } = (r ?? {}) as Record<string, unknown>;
			if (typeof member !== 'string' || typeof createdAt !== 'string') continue;
			requests.push({
				did: member,
				message: typeof message === 'string' ? message : null,
				createdAt: Date.parse(createdAt)
			});
		}
		cursor = typeof page.cursor === 'string' ? page.cursor : undefined;
	} while (cursor && requests.length < MAX_LISTED_REQUESTS);
	return requests;
}

export async function denyJoinRequest(writer: GroupWriter, did: string): Promise<void> {
	await asGroup(writer, 'denyJoinRequest', { body: { member: did } });
}

const membership = (writer: GroupWriter, did: string) => ({
	space: membersSpaceUri(writer.did),
	repo: writer.did,
	collection: GROUP_MEMBERSHIP_COLLECTION,
	rkey: membershipRkey(did)
});

/** A create, so it never replaces a member's roles. Approving a request is the same write:
 *  the host closes the request when the membership appears. */
export async function admitMember(
	writer: GroupWriter,
	did: string,
	role: GroupRoleName
): Promise<void> {
	await asGroup(writer, 'com.atproto.space.createRecord', {
		body: {
			...membership(writer, did),
			record: {
				...groupMembershipRecord({ subject: did, roles: [role] }),
				$type: GROUP_MEMBERSHIP_COLLECTION
			}
		}
	});
}

/** Rewritten in place, keeping its date and any role atmo does not know. */
export async function setMemberRole(
	writer: GroupWriter,
	did: string,
	role: GroupRoleName
): Promise<void> {
	const where = membership(writer, did);
	let current: { roles: string[]; createdAt: string | null } | null = null;
	try {
		const body = await asGroup(writer, 'com.atproto.space.getRecord', { query: where });
		current = parseGroupMembership(body.value, where.rkey);
	} catch (e) {
		if (!isRecordNotFound(e)) throw e;
	}
	if (!current) throw new GroupActionError('That account is not a member.');
	const others = current.roles.filter((id) => !(GROUP_ROLES as readonly string[]).includes(id));
	await asGroup(writer, 'com.atproto.space.putRecord', {
		body: {
			...where,
			record: {
				...groupMembershipRecord({
					subject: did,
					roles: [role, ...others],
					createdAt: current.createdAt ?? undefined
				}),
				$type: GROUP_MEMBERSHIP_COLLECTION
			}
		}
	});
}

/** The host answers the same for a record that is already gone. */
export async function removeMember(writer: GroupWriter, did: string): Promise<void> {
	await asGroup(writer, 'com.atproto.space.deleteRecord', { body: membership(writer, did) });
}

/** atmo's calendar space, for members-only events: every role reads it, whatever the group's
 *  visibility. One already there is not a failure, so a setup that stopped can finish. */
export async function createCalendarSpace(writer: GroupWriter): Promise<void> {
	try {
		await xrpc(writer.handle, `${NS}.createSpace`, {
			body: {
				type: CALENDAR_SPACE_TYPE,
				skey: SPACE_SKEY,
				access: groupAccessRecord({
					spaceType: CALENDAR_SPACE_TYPE,
					roles: GROUP_ROLES,
					public: false
				})
			}
		});
	} catch (e) {
		if (e instanceof XrpcError && e.error === 'SpaceAlreadyExists') return;
		throw e;
	}
}
