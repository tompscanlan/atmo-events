// The gate and transport for records a group authors; `repo` is always the group. The
// host decides every write as the group, so the gate refuses only a signed-out caller,
// except for this app's own rows (`appOnly`), which the host never sees.
import { isActorIdentifier } from '@atcute/lexicons/syntax';
import { MEMBERSHIP_SPACE } from '../grants';
import type { GroupPermission } from '../permissions';
import {
	allowsWrite,
	membershipAction,
	NO_GRANTS,
	withAccess,
	type SpaceWrite,
	type WriteGrants
} from '../scopes';
import { spaceUri } from '../ids';
import {
	GROUP_ACCESS_COLLECTION,
	GROUP_ACCESS_RKEY,
	GROUP_MEMBERSHIP_COLLECTION,
	parseGroupAccess
} from '../members-record';
import { ABOUT_SPACE_TYPE, MEMBERS_SPACE_TYPE, type CallerMembership, type GroupRow } from '../types';
import { groupSpaceReader, type GroupSpaceReader } from './about-read';
import {
	GroupCredentialError,
	groupClient,
	requireGroupCredential,
	type CredentialStoreEnv,
	type GroupCredential
} from './session';
import { xrpc, xrpcError } from './xrpc';
import { getCallerMembership } from './standing';
import { isSpaceAccessDenied } from './space-credential';

function errorOf(data: unknown): string | null {
	const error = data && typeof data === 'object' && 'error' in data ? data.error : null;
	return typeof error === 'string' ? error : null;
}

/** `reason` is in words a form can show after "Not allowed:". */
export class GroupPermissionError extends Error {
	constructor(
		readonly reason: string,
		readonly groupDid: string
	) {
		super(`not allowed in this group (${groupDid}): ${reason}`);
		this.name = 'GroupPermissionError';
	}
}

export function permissionRequired(permission: GroupPermission): string {
	return `${permission} required`;
}

// The host cuts each session to its person's roles. Its message is not kept: it can
// carry what a user typed.
function hostRefusal(nsid: string, error: string | null, groupDid: string, collection: string) {
	if (error === 'ScopeMissingError') {
		return new GroupPermissionError(`your roles do not allow ${nsid}`, groupDid);
	}
	if (error === 'Forbidden') {
		return new GroupPermissionError(
			collection === GROUP_MEMBERSHIP_COLLECTION
				? 'your roles may not assign or remove that role'
				: `the group’s host does not allow ${nsid}`,
			groupDid
		);
	}
	return null;
}

function noScopeFor(write: SpaceWrite): string {
	return 'manage' in write
		? `your roles hold no scope to ${write.manage} a ${write.spaceType} space`
		: `your roles hold no scope to ${write.action} ${write.collection} records in the ${write.spaceType} space`;
}

export class GroupRecordError extends Error {
	constructor(
		message: string,
		readonly issues: readonly { path?: readonly unknown[]; code?: string }[] = []
	) {
		super(message);
		this.name = 'GroupRecordError';
	}
}

const SPACE_TYPES = { about: ABOUT_SPACE_TYPE, members: MEMBERS_SPACE_TYPE } as const;

export function ownSpace(
	group: Pick<GroupRow, 'group_did'>,
	kind: keyof typeof SPACE_TYPES,
	uri: string | null,
	stops: string
): string {
	if (!uri) throw new GroupRecordError(`${group.group_did} has no ${kind} space yet, so ${stops}`);
	if (!uri.startsWith(`at://${group.group_did}/space/${SPACE_TYPES[kind]}/`)) {
		throw new GroupRecordError(`${uri} is not ${group.group_did}'s ${kind} space`);
	}
	return uri;
}

export interface GroupRepoWrite {
	repo: string;
	collection: string;
	rkey: string;
	record: Record<string, unknown>;
	intent: 'create' | 'update' | 'delete';
	space?: string;
}

export type GroupRepoWriter = (write: GroupRepoWrite) => Promise<{ uri: string; cid: string }>;

/** A credential stored under the wrong group cannot write elsewhere. */
export function pdsWriter(cred: GroupCredential, groupDid: string): GroupRepoWriter {
	return async (write) => {
		const xrpcFailure = (nsid: string, status: number, error: string | null) =>
			hostRefusal(nsid, error, groupDid, write.collection) || xrpcError(nsid, { status, error });
		const { client, handle } = await groupClient(cred, groupDid);
		const collection = write.collection as `${string}.${string}.${string}`;
		const repo = write.repo;
		if (!isActorIdentifier(repo)) {
			throw new GroupRecordError(`${write.repo} is not a usable repo identifier`);
		}
		const space = write.space;

		const sendSpace = async (nsid: string, input: Record<string, unknown>) => {
			const answer = await xrpc(handle, nsid, { body: { space, repo, collection, ...input } });
			if (!answer.ok) throw xrpcFailure(nsid, answer.status, answer.error);
			return answer.data;
		};
		const failed = (nsid: string, res: { status: number; data: unknown }) =>
			xrpcFailure(nsid, res.status, errorOf(res.data));

		if (write.intent === 'delete') {
			if (space) {
				await sendSpace('com.atproto.space.deleteRecord', { rkey: write.rkey });
			} else {
				const res = await client.post('com.atproto.repo.deleteRecord', {
					input: { repo, collection, rkey: write.rkey }
				});
				if (!res.ok) throw failed('com.atproto.repo.deleteRecord', res);
			}
			// deleteRecord returns no useful body, so the URI is rebuilt.
			return { uri: `at://${write.repo}/${write.collection}/${write.rkey}`, cid: '' };
		}

		const create = write.intent === 'create';
		let body: unknown;
		if (space) {
			body = await sendSpace(
				create ? 'com.atproto.space.createRecord' : 'com.atproto.space.putRecord',
				{ rkey: write.rkey, record: write.record }
			);
		} else {
			const nsid = create ? 'com.atproto.repo.createRecord' : 'com.atproto.repo.putRecord';
			const res = await client.post(nsid, {
				input: { repo, collection, rkey: write.rkey, record: write.record }
			});
			if (!res.ok) throw failed(nsid, res);
			body = res.data;
		}

		if (
			!(
				body &&
				typeof body === 'object' &&
				'uri' in body &&
				typeof body.uri === 'string' &&
				'cid' in body &&
				typeof body.cid === 'string'
			)
		) {
			throw new GroupRecordError(`the write returned no uri/cid`);
		}
		return { uri: body.uri, cid: body.cid };
	};
}

// Read once per request (a reader is built for one); a failed read is not kept.
const standings = new WeakMap<GroupSpaceReader, Map<string, Promise<CallerMembership>>>();

function standingFor(
	db: D1Database,
	group: GroupRow,
	callerDid: string,
	reader: GroupSpaceReader | null
): Promise<CallerMembership> {
	if (!reader) return getCallerMembership(db, group, callerDid, null);
	let kept = standings.get(reader);
	if (!kept) standings.set(reader, (kept = new Map()));
	const key = `${group.group_did} ${callerDid}`;
	let standing = kept.get(key);
	if (!standing) {
		standing = getCallerMembership(db, group, callerDid, reader).catch(async (e) => {
			if (!isSpaceAccessDenied(e)) throw e;
			const row = await getCallerMembership(db, group, callerDid, null);
			return { ...row, permissions: new Set(), grants: NO_GRANTS, onRoster: false };
		});
		kept.set(key, standing);
		standing.catch(() => kept.delete(key));
	}
	return standing;
}

export interface GroupGateInput {
	db: D1Database;
	env: CredentialStoreEnv;
	group: GroupRow;
	callerDid: string | null;
	reader?: GroupSpaceReader | null;
}

export interface GateOptions {
	appOnly?: boolean;
}


function requireCaller(input: GroupGateInput, refusal: string): void {
	if (!input.callerDid) throw new GroupPermissionError(refusal, input.group.group_did);
}

async function gateStanding(
	input: GroupGateInput,
	refusal: string
): Promise<{ membership: CallerMembership; reader: GroupSpaceReader | null }> {
	const { db, group, callerDid } = input;
	if (!callerDid) throw new GroupPermissionError(refusal, group.group_did);
	let reader = input.reader;
	if (reader === undefined) {
		reader = await groupSpaceReader(input.env, group, callerDid);
		if (!reader && group.members_space_uri) {
			throw new GroupCredentialError(group.group_did, callerDid);
		}
	}
	return { membership: await standingFor(db, group, callerDid, reader), reader };
}

export async function requireGroupPermission(
	input: GroupGateInput,
	permission: GroupPermission
): Promise<void> {
	requireCaller(input, permissionRequired(permission));
}

/** Called before anything moves, so a refusal changes nothing. */
export async function requireGroupWrite(
	input: GroupGateInput,
	write: SpaceWrite,
	options: GateOptions = {}
): Promise<void> {
	const refusal = noScopeFor(write);
	requireCaller(input, refusal);
	if (!options.appOnly) return;
	const { membership, reader } = await gateStanding(input, refusal);
	const groupDid = input.group.group_did;
	if (allowsWrite(membership.grants, groupDid, write)) return;
	const grants = await withTargetAccess(membership.grants, reader, groupDid, write);
	if (!grants || !allowsWrite(grants, groupDid, write)) {
		throw new GroupPermissionError(refusal, groupDid);
	}
}

async function withTargetAccess(
	grants: WriteGrants,
	reader: GroupSpaceReader | null,
	groupDid: string,
	write: SpaceWrite
): Promise<WriteGrants | null> {
	if (!reader || grants.roles.length === 0 || write.spaceType in grants.inSpace) return null;
	const found = await reader.get({
		space: spaceUri(groupDid, write.spaceType, write.skey),
		repo: groupDid,
		collection: GROUP_ACCESS_COLLECTION,
		rkey: GROUP_ACCESS_RKEY
	});
	const access = found ? parseGroupAccess(found.value) : null;
	return access ? withAccess(grants, write.spaceType, access.grants) : null;
}

/** `to` is empty for an ejection. The host checks the scope and `assignable`. */
export async function requireMembershipWrite(
	input: GroupGateInput,
	to: readonly string[]
): Promise<void> {
	requireCaller(
		input,
		noScopeFor({ ...MEMBERSHIP_SPACE, action: membershipAction({ from: [], to }) })
	);
}


export function actingPerson(input: Pick<GroupGateInput, 'group' | 'callerDid'>): string {
	if (!input.callerDid) {
		throw new GroupPermissionError('sign in required', input.group.group_did);
	}
	return input.callerDid;
}


export function gatedWriter(
	input: Pick<GroupGateInput, 'env' | 'group' | 'callerDid'> & { writer?: GroupRepoWriter }
): Promise<GroupRepoWriter> {
	return input.writer
		? Promise.resolve(input.writer)
		: groupWriter(input.env, input.group, actingPerson(input));
}

export async function groupWriter(
	env: CredentialStoreEnv,
	group: GroupRow,
	personDid: string
): Promise<GroupRepoWriter> {
	const credential = await requireGroupCredential(env, group.group_did, personDid);
	return pdsWriter(credential, group.group_did);
}
