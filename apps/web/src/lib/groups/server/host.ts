// The group host (`GROUP_HOST_URL`), by the proposal's methods. A person's own acts go
// through their PDS with service auth; the group's methods and membership writes go on
// the acting person's group session, which the host cuts to their roles.
import { GROUP_ROLES, primaryRole, type GroupRoleName } from '../permissions';
import type { GroupRow, JoinRequestRow } from '../types';
import type { GroupSpaceReader } from './about-read';
import type { CallerSession } from './caller';
import {
	addMember,
	changeMemberRole,
	closeJoinRequestNote,
	getMemberRow,
	noteJoinRequest,
	removeMember,
	type JoinOutcome
} from './db/roster';
import { GroupRuleError } from './db/rules';
import { errorText } from './errors';
import { GroupPermissionError, groupWriter, type GroupRepoWriter } from './group-write';
import { dropGroupMembership, putGroupMembership } from './members-writer';
import { readMembership } from './members-read';
import {
	groupClient,
	requireGroupCredential,
	GroupCredentialError,
	type CredentialStoreEnv,
	type GroupCredential
} from './session';
import { didSpaceHosts, type SpaceHosts } from './space-credential';
import { describeFailure, readXrpc, xrpc, type XrpcAnswer, type XrpcRequest } from './xrpc';

const NS = 'group.opensocial';
const MAX_LISTED_REQUESTS = 1000;

export class GroupNotAtHostError extends Error {
	constructor(readonly groupDid: string) {
		super(`${groupDid} is not at this site's group host, so this site cannot change it`);
		this.name = 'GroupNotAtHostError';
	}
}

/** Only the error name is kept: a host's message can carry what a user typed. */
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

export class HostSignInError extends Error {
	constructor(
		readonly nsid: string,
		readonly groupDid: string
	) {
		super(`your sign-in does not let this site send ${nsid} to ${groupDid}'s host`);
		this.name = 'HostSignInError';
	}
}

export function groupHostOrigin(
	env: Pick<CredentialStoreEnv, 'GROUP_HOST_URL'> | undefined
): string | null {
	const url = env?.GROUP_HOST_URL?.trim();
	return url ? new URL(url).origin : null;
}

/** An unresolvable DID throws: which host serves a group is not something to guess. */
export async function isHostGroup(
	env: Pick<CredentialStoreEnv, 'GROUP_HOST_URL'> | undefined,
	groupDid: string,
	hosts: Pick<SpaceHosts, 'repoHost'> = didSpaceHosts
): Promise<boolean> {
	const origin = groupHostOrigin(env);
	if (!origin) return false;
	return new URL(await hosts.repoHost(groupDid)).origin === origin;
}

type Failed = Extract<XrpcAnswer, { ok: false }>;

function refusal(nsid: string, answer: Failed): Error {
	if (answer.error === 'JoinClosed')
		return new GroupRuleError('invite-only', 'This group is invite-only');
	if (answer.error === 'JoinRequestNotFound') {
		return new GroupRuleError('not-found', 'No such pending join request');
	}
	return new GroupHostError(nsid, answer.status, answer.error);
}

interface HostJoinRequest {
	member: string;
	createdAt: string;
	message?: string;
}

function isHostJoinRequest(value: unknown): value is HostJoinRequest {
	const r = value as HostJoinRequest | null;
	return typeof r?.member === 'string' && typeof r.createdAt === 'string';
}

// The proposal names a request by its member, so the member is its id.
function requestRow(r: HostJoinRequest): JoinRequestRow {
	return {
		id: r.member,
		did: r.member,
		status: 'pending',
		message: r.message ?? null,
		created_at: Date.parse(r.createdAt)
	};
}

export interface HostBinding {
	db: D1Database;
	env: CredentialStoreEnv;
	group: GroupRow;
	credential?: GroupCredential;
}

export interface HostCaller {
	callerDid: string;
	reader?: GroupSpaceReader | null;
	member?: CallerSession | null;
}

export interface GroupHost {
	listJoinRequests(caller: HostCaller): Promise<JoinRequestRow[]>;
	denyJoinRequest(caller: HostCaller, member: string): Promise<void>;
	requestJoin(caller: HostCaller, message: string | null): Promise<JoinOutcome>;
	cancelJoinRequest(caller: HostCaller): Promise<void>;
	leaveGroup(caller: HostCaller): Promise<void>;
	approveJoinRequest(caller: HostCaller, member: string, role: GroupRoleName): Promise<void>;
	addMember(caller: HostCaller, did: string, role: GroupRoleName): Promise<void>;
	ejectMember(caller: HostCaller, did: string): Promise<void>;
	setMemberRole(caller: HostCaller, did: string, role: GroupRoleName): Promise<void>;
}

export async function groupHost(binding: HostBinding): Promise<GroupHost> {
	if (!(await isHostGroup(binding.env, binding.group.group_did))) {
		throw new GroupNotAtHostError(binding.group.group_did);
	}
	return hostMethods(binding);
}

export function hostMethods(binding: HostBinding): GroupHost {
	const { db, env, group } = binding;
	const groupDid = group.group_did;
	const act = (caller: HostCaller) => ({ ...caller, db, env, group });

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
		if (!answer.ok && answer.error === 'ScopeMissingError')
			throw new HostSignInError(nsid, groupDid);
		return { nsid, answer };
	}

	async function asGroup(caller: HostCaller, method: string, request: XrpcRequest) {
		const nsid = `${NS}.${method}`;
		const cred =
			binding.credential ?? (await requireGroupCredential(env, groupDid, caller.callerDid));
		const { handle } = await groupClient(cred, groupDid);
		const answer = await xrpc(handle, nsid, request);
		if (!answer.ok && answer.error === 'ScopeMissingError') {
			throw new GroupPermissionError(`your roles do not allow ${nsid}`, groupDid);
		}
		return { nsid, answer };
	}

	// The record is in and access follows it, so a cache failure is only logged.
	async function cacheMember(did: string, role: string, decidedBy: string | null) {
		try {
			const row = await getMemberRow(db, group.id, did);
			if (!row) await addMember(db, group.id, did, role, decidedBy);
			else if (row.role !== role) await changeMemberRole(db, group.id, did, role);
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

	return {
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
				// The host admits with its own default roles, which only the record says.
				const record = caller.reader
					? await readMembership(caller.reader, group, did).catch(() => null)
					: null;
				await cacheMember(did, primaryRole(record?.roles ?? []) ?? 'member', null);
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
			const { nsid, answer } = await asMember(caller, 'leaveGroup', {});
			if (!answer.ok) throw refusal(nsid, answer);
			await uncacheMember(caller.callerDid);
			await closeJoinRequestNote(db, group.id, caller.callerDid, caller.callerDid, 'withdrawn');
		},

		async approveJoinRequest(caller, member, role) {
			await putGroupMembership({ ...act(caller), subject: member, roles: [role], intent: 'admit' });
			await cacheMember(member, role, caller.callerDid);
		},

		async addMember(caller, did, role) {
			await putGroupMembership({ ...act(caller), subject: did, roles: [role], intent: 'admit' });
			await cacheMember(did, role, caller.callerDid);
		},

		async ejectMember(caller, did) {
			await dropGroupMembership({ ...act(caller), subject: did, intent: 'eject' });
			await uncacheMember(did);
		},

		async setMemberRole(caller, did, role) {
			// A failed read throws rather than drop the record's roles and date.
			const published = caller.reader ? await readMembership(caller.reader, group, did) : null;
			const others = (published?.roles ?? []).filter(
				(id) => !(GROUP_ROLES as readonly string[]).includes(id)
			);
			await putGroupMembership({
				...act(caller),
				subject: did,
				roles: [role, ...others],
				createdAt: published?.createdAt ?? undefined,
				intent: 'assign'
			});
			await cacheMember(did, role, caller.callerDid);
		}
	};
}

/** Null when the viewer holds no group session to ask the host with. */
export async function pendingRequestsFor(
	binding: HostBinding,
	caller: HostCaller
): Promise<JoinRequestRow[] | null> {
	try {
		return await (await groupHost(binding)).listJoinRequests(caller);
	} catch (e) {
		if (e instanceof GroupCredentialError) return null;
		if (e instanceof GroupNotAtHostError) return [];
		throw e;
	}
}

export async function hostGroupWriter(
	env: CredentialStoreEnv,
	group: GroupRow,
	personDid: string
): Promise<GroupRepoWriter> {
	if (!(await isHostGroup(env, group.group_did))) throw new GroupNotAtHostError(group.group_did);
	return groupWriter(env, group, personDid);
}
