// The second adapter behind `GroupHost` (./host.ts): a real group host, one that
// serves the groups standard's methods (proposal.md, "Methods", lex-refactor
// bce2966) for the group accounts it holds. A group is the host's when its
// DID document names, as its PDS, the host this deployment is set up with
// (`GROUP_HOST_URL`).
//
// A person's own acts go through their own PDS: join, cancel and leave are sent
// there with `atproto-proxy: <group>#atproto_pds`, and the PDS forwards them with
// service auth naming the group, so the member's sign-in must hold each method's
// `rpc:` scope. The group's own methods (listing and denying requests, creating
// a space) and the membership writes that approve, add, eject and change a role
// go to the host on the acting person's own group session, which the host cuts
// to their roles on every request.
//
// The host keeps the requests, the member lists and the spaces' read policies,
// so nothing here touches them. What stays this app's is its D1 cache of the
// roster and its note that a person asked to join: no method reads a member's
// own request back, so the note is how a page knows to offer a cancel. The note
// follows the host's answers and never decides anything.
import type { AssignableRole } from '../permissions';
import type { JoinRequestRow } from '../types';

import {
	addMember,
	changeMemberRole,
	closeJoinRequestNote,
	getMemberRow,
	noteJoinRequest,
	removeMember
} from './db/roster';
import { GroupRuleError } from './db/rules';
import { errorText } from './errors';
import { GroupPermissionError } from './group-write';
import type { GroupHost, HostBinding, HostCaller } from './host';
import { dropGroupMembership, putGroupMembership } from './members-writer';
import { readMembership } from './members-read';
import { accept, unaccept, type RosterContext } from './roster';
import { groupClient, requireGroupCredential } from './session';
export { groupHostOrigin, isHostGroup } from './host-kind';
import { GroupSpaceError } from './spaces';
import { describeFailure, readXrpc, xrpc, type XrpcAnswer, type XrpcRequest } from './xrpc';

const NS = 'group.opensocial';

/** The most join requests a page lists, 100 to a page. */
const MAX_LISTED_REQUESTS = 1000;

/** The group host refused a call, by a name this app has no message of its own
 *  for. Only the name is kept: a host's message can carry what a user typed. */
export class GroupHostError extends Error {
	constructor(
		readonly nsid: string,
		readonly status: number,
		readonly error: string | null
	) {
		super(`${nsid} failed at the group host: ${describeFailure({ status, error })}`);
		this.name = 'GroupHostError';
	}
}

/** The caller's own sign-in cannot make a member's call: there is none this app
 *  can use, or their PDS refused it for a missing scope. Signing in again asks
 *  for what it needs. */
export class HostSignInError extends Error {
	constructor(
		readonly nsid: string,
		readonly groupDid: string
	) {
		super(`your sign-in does not let this site send ${nsid} to ${groupDid}'s host`);
		this.name = 'HostSignInError';
	}
}

type Failed = Extract<XrpcAnswer, { ok: false }>;

/** The refusals the standard names for these methods, as this app's own errors,
 *  so a form words them as it does the app's own rules. */
function refusal(nsid: string, answer: Failed): Error {
	if (answer.error === 'JoinClosed')
		return new GroupRuleError('invite-only', 'This group is invite-only');
	if (answer.error === 'JoinRequestNotFound') {
		return new GroupRuleError('not-found', 'No such pending join request');
	}
	return new GroupHostError(nsid, answer.status, answer.error);
}

/** One of the host's records of a request, as `listJoinRequests` returns it. */
interface HostJoinRequest {
	member: string;
	createdAt: string;
	message?: string;
}

function isHostJoinRequest(value: unknown): value is HostJoinRequest {
	const r = value as HostJoinRequest | null;
	return typeof r?.member === 'string' && typeof r.createdAt === 'string';
}

/** A host's request as the row the pages list. The standard names a request by
 *  its member, so the member is its id. */
function requestRow(r: HostJoinRequest): JoinRequestRow {
	return {
		id: r.member,
		did: r.member,
		status: 'pending',
		message: r.message ?? null,
		created_at: Date.parse(r.createdAt)
	};
}

/** The group host's own methods, for one group at it. */
export function realGroupHost(binding: HostBinding): GroupHost {
	const { db, env, group } = binding;
	const groupDid = group.group_did;
	const act = (caller: HostCaller): RosterContext => ({ ...caller, db, env, group });

	/** A member's own act, through their own PDS. Only the caller's own session
	 *  speaks for them. */
	async function asMember(caller: HostCaller, method: string, body: Record<string, unknown>) {
		const nsid = `${NS}.${method}`;
		const member = caller.member;
		if (!member || member.did !== caller.callerDid) throw new HostSignInError(nsid, groupDid);
		const answer = await readXrpc(
			await member.handle(`/xrpc/${nsid}`, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					'atproto-proxy': `${groupDid}#atproto_pds`
				},
				body: JSON.stringify({ group: groupDid, ...body })
			})
		);
		// Their own PDS checks the rpc: scope before it forwards anything.
		if (!answer.ok && answer.error === 'ScopeMissingError')
			throw new HostSignInError(nsid, groupDid);
		return { nsid, answer };
	}

	/** One of the group's own methods, on the caller's group session. */
	async function asGroup(caller: HostCaller, method: string, request: XrpcRequest) {
		const nsid = `${NS}.${method}`;
		const cred =
			binding.credential ?? (await requireGroupCredential(env, groupDid, caller.callerDid));
		const { handle } = await groupClient(cred, groupDid);
		const answer = await xrpc(handle, nsid, request);
		// The host cuts the session to the person's roles, so a missing scope is
		// their roles, not their sign-in.
		if (!answer.ok && answer.error === 'ScopeMissingError') {
			throw new GroupPermissionError(`your roles do not allow ${nsid}`, groupDid);
		}
		return { nsid, answer };
	}

	/** The roster cache follows a membership the host now holds. A failure is
	 *  logged, not thrown: the record is in, and access follows the record. */
	async function cacheMember(did: string, role: AssignableRole, decidedBy: string | null) {
		try {
			const row = await getMemberRow(db, group.id, did);
			if (!row) await addMember(db, group.id, did, role, decidedBy);
			else if (row.role !== role && row.role !== 'owner') {
				await changeMemberRole(db, group.id, did, role);
			}
		} catch (e) {
			console.warn(`[groups] ${groupDid}'s roster cache missed ${did}:`, errorText(e));
		}
	}

	async function uncacheMember(did: string) {
		try {
			if (await getMemberRow(db, group.id, did)) await removeMember(db, group.id, did);
		} catch (e) {
			console.warn(`[groups] ${groupDid}'s roster cache still lists ${did}:`, errorText(e));
		}
	}

	/** A group with an owner row keeps it: an app's own rule, which the host
	 *  does not hold. */
	async function refuseOwner(did: string) {
		const row = await getMemberRow(db, group.id, did);
		if (row?.role === 'owner') {
			throw new GroupRuleError('owner-protected', 'The group owner cannot be changed');
		}
		return row;
	}

	return {
		async createSpace(caller, space) {
			if (!space.access) {
				throw new GroupSpaceError(
					`a space at the group host is made with its access record, and none was given`,
					space.type
				);
			}
			const { nsid, answer } = await asGroup(caller, 'createSpace', {
				body: { type: space.type, skey: space.skey, access: space.access }
			});
			if (!answer.ok) throw refusal(nsid, answer);
			const uri = answer.data.space;
			if (typeof uri !== 'string')
				throw new GroupSpaceError(`${nsid} returned no space`, space.type);
			return { uri };
		},

		async listJoinRequests(caller) {
			const rows: JoinRequestRow[] = [];
			let cursor: string | undefined;
			do {
				const { nsid, answer } = await asGroup(caller, 'listJoinRequests', {
					query: { limit: '100', ...(cursor ? { cursor } : {}) }
				});
				if (!answer.ok) throw refusal(nsid, answer);
				const page = Array.isArray(answer.data.requests) ? answer.data.requests : [];
				rows.push(...page.filter(isHostJoinRequest).map(requestRow));
				cursor = typeof answer.data.cursor === 'string' ? answer.data.cursor : undefined;
			} while (cursor && rows.length < MAX_LISTED_REQUESTS);
			return rows;
		},

		async denyJoinRequest(caller, member) {
			const { nsid, answer } = await asGroup(caller, 'denyJoinRequest', { body: { member } });
			if (!answer.ok && answer.error !== 'JoinRequestNotFound') throw refusal(nsid, answer);
			await closeJoinRequestNote(db, group.id, member, caller.callerDid, 'rejected');
			if (!answer.ok) throw refusal(nsid, answer);
		},

		async requestJoin(caller, message) {
			const { nsid, answer } = await asMember(caller, 'requestJoin', message ? { message } : {});
			if (!answer.ok) throw refusal(nsid, answer);
			const did = caller.callerDid;
			if (answer.data.status === 'admitted') {
				const already = (await getMemberRow(db, group.id, did)) !== null;
				await cacheMember(did, 'member', null);
				await accept(act(caller));
				return already ? 'already-member' : 'joined';
			}
			if (answer.data.status === 'pending') {
				return noteJoinRequest(db, group.id, did, message);
			}
			throw new GroupHostError(nsid, 200, `unknown status ${String(answer.data.status)}`);
		},

		async cancelJoinRequest(caller) {
			const { nsid, answer } = await asMember(caller, 'cancelJoinRequest', {});
			// Gone at the host either way: withdrawn now, or approved already.
			if (answer.ok || answer.error === 'JoinRequestNotFound') {
				await closeJoinRequestNote(db, group.id, caller.callerDid, caller.callerDid, 'withdrawn');
			}
			if (!answer.ok) throw refusal(nsid, answer);
		},

		async leaveGroup(caller) {
			await refuseOwner(caller.callerDid);
			await unaccept(act(caller));
			const { nsid, answer } = await asMember(caller, 'leaveGroup', {});
			if (!answer.ok) throw refusal(nsid, answer);
			await uncacheMember(caller.callerDid);
			await closeJoinRequestNote(db, group.id, caller.callerDid, caller.callerDid, 'withdrawn');
		},

		async approveJoinRequest(caller, member, role) {
			await putGroupMembership({ ...act(caller), subject: member, roles: [role], intent: 'admit' });
			await cacheMember(member, role, caller.callerDid);
			return { did: member };
		},

		async addMember(caller, did, role) {
			await putGroupMembership({ ...act(caller), subject: did, roles: [role], intent: 'admit' });
			await cacheMember(did, role, caller.callerDid);
		},

		async ejectMember(caller, did) {
			await refuseOwner(did);
			await dropGroupMembership({ ...act(caller), subject: did, intent: 'eject' });
			await uncacheMember(did);
		},

		async setMemberRole(caller, did, role) {
			await refuseOwner(did);
			// The published date stays: read with the caller's own access, and a
			// failed read throws rather than stamping a new one.
			const published = caller.reader ? await readMembership(caller.reader, group, did) : null;
			await putGroupMembership({
				...act(caller),
				subject: did,
				roles: [role],
				createdAt: published?.createdAt ?? undefined,
				intent: 'assign'
			});
			await cacheMember(did, role, caller.callerDid);
		}
	};
}
