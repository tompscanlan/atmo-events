// The write gate for records a group authors, shared by every writer.
//
// The helpers in $lib/atproto/server/repo.remote.ts write the signed-in user's
// own repo. A group's records belong to the group, so its admins co-edit one
// record set, and a repo write must be authored by the repo's own DID. So here
// the signed-in user is only the subject of a permission check. The credential
// is the group's (./credentials.ts), and `repo` is always the group DID.
import { isActorIdentifier } from '@atcute/lexicons/syntax';
import { can, type EnforcedGroupPermission } from '../permissions';
import type { GroupRow } from '../types';
import {
	resolveGroupCredential,
	type CredentialStoreEnv,
	type GroupCredential
} from './credentials';
import { groupSpaceReader, type GroupSpaceReader } from './about-read';
import { getCallerMembership } from './repo';
import { groupClient } from './session';
import { xrpc, xrpcError } from './xrpc';

/** The error name in a typed client's failed answer, if it has one. */
function errorOf(data: unknown): string | null {
	const error = data && typeof data === 'object' && 'error' in data ? data.error : null;
	return typeof error === 'string' ? error : null;
}

/** The caller's role does not grant the permission this write needs. */
export class GroupPermissionError extends Error {
	constructor(
		readonly permission: EnforcedGroupPermission,
		readonly groupDid: string
	) {
		super(`${permission} is required to do that in this group (${groupDid})`);
		this.name = 'GroupPermissionError';
	}
}

/** The group's owner has not linked its account, so this app cannot author as the
 *  group. Only the owner can fix it, by linking from the group page. */
export class GroupCredentialError extends Error {
	constructor(readonly groupDid: string) {
		super(`${groupDid} is not linked: its owner has not authorized this app to write as it`);
		this.name = 'GroupCredentialError';
	}
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
 *  `repo` names the author's part of the space, which is the group itself. */
export function pdsWriter(cred: GroupCredential, groupDid: string): GroupRepoWriter {
	return async (write) => {
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
			if (!answer.ok) throw xrpcError(nsid, answer);
			return answer.data;
		};
		const failed = (nsid: string, res: { status: number; data: unknown }) =>
			xrpcError(nsid, { status: res.status, error: errorOf(res.data) });

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

/** What the gate needs. `reader` is a test override; absent, the gate builds
 *  the group's own. */
export interface GroupGateInput {
	db: D1Database;
	env: CredentialStoreEnv;
	group: GroupRow;
	callerDid: string | null;
	reader?: GroupSpaceReader | null;
}

/** The gate's permission check. Refuses an anonymous caller before any read.
 *  Otherwise the group's records decide, through `getCallerMembership`. A group
 *  with a members space that its owner has not linked cannot be read, so nobody's
 *  permission can be checked, and the refusal says what would fix it. */
export async function requireGroupPermission(
	input: GroupGateInput,
	permission: EnforcedGroupPermission
): Promise<void> {
	const { db, group, callerDid } = input;
	if (!callerDid) throw new GroupPermissionError(permission, group.group_did);
	let reader = input.reader;
	if (reader === undefined) {
		reader = await groupSpaceReader(input.env, db, group);
		if (!reader && group.members_space_uri) throw new GroupCredentialError(group.group_did);
	}
	const membership = await getCallerMembership(db, group, callerDid, reader);
	if (!can(membership.permissions, permission)) {
		throw new GroupPermissionError(permission, group.group_did);
	}
}

/** The group's credential, for a write. Throws GroupCredentialError when the
 *  group is not linked, which only its owner can fix. */
export async function requireGroupCredential(
	env: CredentialStoreEnv,
	groupDid: string
): Promise<GroupCredential> {
	const cred = await resolveGroupCredential(env, groupDid);
	if (!cred) throw new GroupCredentialError(groupDid);
	return cred;
}

/** The transport for the group's repo and its spaces, through its linked session.
 *  Throws GroupCredentialError when the group is not linked. */
export async function groupWriter(
	env: CredentialStoreEnv,
	db: D1Database,
	group: GroupRow
): Promise<GroupRepoWriter> {
	return pdsWriter(await requireGroupCredential(env, group.group_did), group.group_did);
}
