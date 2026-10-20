// The write gate for records a group authors, shared by every writer.
//
// The helpers in $lib/atproto/server/repo.remote.ts write the signed-in user's
// own repo. A group's records belong to the group, so its admins co-edit one
// record set, and a repo write must be authored by the repo's own DID. So here
// the signed-in user is the subject of a permission check and the person whose
// group session carries the write (./session.ts), and `repo` is always the group
// DID.
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
import {
	ABOUT_SPACE_TYPE,
	CALENDAR_SPACE_TYPE,
	MEMBERS_SPACE_TYPE,
	type CallerMembership,
	type GroupRow
} from '../types';
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
/** The error name in a typed client's failed answer, if it has one. */
function errorOf(data: unknown): string | null {
	const error = data && typeof data === 'object' && 'error' in data ? data.error : null;
	return typeof error === 'string' ? error : null;
}

/** The caller's roles do not allow what they asked. `reason` says what was missing,
 *  in words a form can show after "Not allowed:". */
export class GroupPermissionError extends Error {
	constructor(
		readonly reason: string,
		readonly groupDid: string
	) {
		super(`not allowed in this group (${groupDid}): ${reason}`);
		this.name = 'GroupPermissionError';
	}
}

/** The refusal for a named permission. */
export function permissionRequired(permission: GroupPermission): string {
	return `${permission} required`;
}

/** A group host's refusal of a write as the group, as the refusal a form shows,
 *  or null for any other answer. The host cuts each session to its person's
 *  current roles, so a missing scope is their roles, not their sign-in. Its
 *  write gate answers `Forbidden` for what the caller's roles do not allow,
 *  which on a membership is its check of `assignable` (`proposal.md:46`). The
 *  host's message says which rule, but is not kept: it can carry what a user
 *  typed. */
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

/** The refusal for a write no scope covers. */
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

const SPACE_TYPES = {
	about: ABOUT_SPACE_TYPE,
	members: MEMBERS_SPACE_TYPE,
	calendar: CALENDAR_SPACE_TYPE
} as const;

/** `uri`, checked as `group`'s own space of `kind`: present, and of that type
 *  under the group's DID. Otherwise a GroupRecordError. A missing space says
 *  what it stops: "<did> has no <kind> space yet, so <stops>". */
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
	/** Always the group DID. */
	repo: string;
	collection: string;
	rkey: string;
	record: Record<string, unknown>;
	intent: 'create' | 'update' | 'delete';
	/** The space URI, or absent for the group's public repo. Public events stay
	 *  plain repo records, which Jetstream sees and Contrail indexes, since a
	 *  space is never anonymously readable. */
	space?: string;
}

/** The transport half of the gate, for an already-authorized write. Injectable,
 *  so the gate can be tested without a live PDS. */
export type GroupRepoWriter = (write: GroupRepoWrite) => Promise<{ uri: string; cid: string }>;

/** Writes as the group. `groupDid` is checked against the session, so a
 *  credential stored under the wrong group cannot write elsewhere. In a space,
 *  `repo` names the author's part of the space, which is the group itself. The
 *  group's host refuses what the caller's roles do not allow, and its refusal
 *  is the one a form shows. */
export function pdsWriter(cred: GroupCredential, groupDid: string): GroupRepoWriter {
	return async (write) => {
		const xrpcFailure = (nsid: string, status: number, error: string | null) =>
			hostRefusal(nsid, error, groupDid, write.collection) || xrpcError(nsid, { status, error });
		const { client, handle } = await groupClient(cred, groupDid);
		const collection = write.collection as `${string}.${string}.${string}`;
		// `repo` comes off a D1 row. A check, not a cast, makes it an ActorIdentifier,
		// so a malformed group DID fails here.
		const repo = write.repo;
		if (!isActorIdentifier(repo)) {
			throw new GroupRecordError(`${write.repo} is not a usable repo identifier`);
		}
		const space = write.space;

		// The space methods are not in the generated lexicon set, so they use the
		// raw handler. The repo methods stay on the typed client.
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
			// deleteRecord returns no useful body, so the URI is rebuilt. A space
			// scopes access and does not reparent a record, so `repo` is the author.
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

/** The caller's standing, read once per request. A reader is built for one
 *  request, so every write that request makes passes the same reader, and the
 *  group's records are asked once however many records the request writes. A
 *  failed read is not kept, so the next write asks again. Without a reader the
 *  rows decide, which costs no PDS read, so nothing is kept. */
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
			// The host does not let the caller into the members space: they hold
			// nothing there, which the gate refuses as it refuses any non-member.
			if (!isSpaceAccessDenied(e)) throw e;
			const row = await getCallerMembership(db, group, callerDid, null);
			return { ...row, permissions: new Set(), grants: NO_GRANTS, onRoster: false };
		});
		kept.set(key, standing);
		standing.catch(() => kept.delete(key));
	}
	return standing;
}

/** What the gate needs. `reader` is the request's, so the gate reads through
 *  the same session as everything else the request does; absent, the gate
 *  reads through the caller's own group session. */
export interface GroupGateInput {
	db: D1Database;
	env: CredentialStoreEnv;
	group: GroupRow;
	callerDid: string | null;
	reader?: GroupSpaceReader | null;
}

/** `appOnly`: the write is to this app's own rows, which the group's host never
 *  sees (a refresh, a settings save's copy of the group). The host cannot refuse
 *  it, so the gate checks it here. */
export interface GateOptions {
	appOnly?: boolean;
}

/** The group's host decides every write as the group, so the gate asks nothing
 *  about one: the host cuts every session to its person's current roles and
 *  checks `assignable` on a membership write, and the refusal a person sees is
 *  the host's. An anonymous caller is refused here, since there is nobody to
 *  send the write as. (Spec: FR-213, SC-503.) */
function requireCaller(input: GroupGateInput, refusal: string): void {
	if (!input.callerDid) throw new GroupPermissionError(refusal, input.group.group_did);
}

/** The caller's standing and the reader it came through. Refuses an anonymous
 *  caller before any read. A group with a members space that the caller holds
 *  no group session for cannot be read without a reader, so their grants cannot
 *  be checked, and the refusal says what would fix it. */
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

/** The gate for a named permission: the event actions, which `eventPermissions`
 *  grants until events move to scopes. The event's scope decides, which the
 *  group's host holds (FR-216), so only an anonymous caller is refused here. */
export async function requireGroupPermission(
	input: GroupGateInput,
	permission: GroupPermission
): Promise<void> {
	requireCaller(input, permissionRequired(permission));
}

/** The gate for one record or space write as the group. The group's host checks
 *  it, so here only a write to this app's own rows (`appOnly`) is checked: a
 *  scope one of the caller's roles holds, in `permissions` or in the target
 *  space's `access`, must cover it. Called before anything the write depends on
 *  moves, so a refusal changes nothing. (Spec: FR-213.) */
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

/** The caller's grants with the target space's `access` added, when it was not
 *  read with the standing. The standing reads only the members space, so the
 *  about and calendar spaces' records are read here, and only for a write that
 *  `permissions` alone does not allow. Null when there is nothing more to read. */
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

/** The gate for a write of a `membership` that leaves it holding `to`, empty
 *  for an ejection. The group's host checks the scope, and that every role the
 *  write adds or removes is one the caller's roles may assign
 *  (`proposal.md:46`), so only an anonymous caller is refused here.
 *  (Spec: FR-213.) */
export async function requireMembershipWrite(
	input: GroupGateInput,
	to: readonly string[]
): Promise<void> {
	requireCaller(
		input,
		noScopeFor({ ...MEMBERSHIP_SPACE, action: membershipAction({ from: [], to }) })
	);
}

/** The person a gated write goes out for. The gate refuses an anonymous caller
 *  before this is asked, so the refusal here is only for a caller that skipped
 *  it. */
export function actingPerson(input: Pick<GroupGateInput, 'group' | 'callerDid'>): string {
	if (!input.callerDid) {
		throw new GroupPermissionError('sign in required', input.group.group_did);
	}
	return input.callerDid;
}

/** The writer a gated write uses: the one given, else the caller's own group
 *  session's. */
export function gatedWriter(
	input: Pick<GroupGateInput, 'env' | 'group' | 'callerDid'> & { writer?: GroupRepoWriter }
): Promise<GroupRepoWriter> {
	return input.writer
		? Promise.resolve(input.writer)
		: groupWriter(input.env, input.group, actingPerson(input));
}

/** The transport for the group's repo and its spaces, through `personDid`'s own
 *  group session. Throws GroupCredentialError when they hold none. */
export async function groupWriter(
	env: CredentialStoreEnv,
	group: GroupRow,
	personDid: string
): Promise<GroupRepoWriter> {
	const credential = await requireGroupCredential(env, group.group_did, personDid);
	return pdsWriter(credential, group.group_did);
}
