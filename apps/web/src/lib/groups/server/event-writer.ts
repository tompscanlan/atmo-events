// The write gate for records a group authors.
//
// The helpers in $lib/atproto/server/repo.remote.ts write the signed-in user's
// own repo. A group's records belong to the group, so its admins co-edit one
// record set, and a repo write must be authored by the repo's own DID. So here
// the signed-in user is only the subject of a permission check. The credential
// is the group's (./credentials.ts), and `repo` is always the group DID.
import { now as tidNow } from '@atcute/tid';
import * as v from '@atcute/lexicons/validations';
import { isActorIdentifier } from '@atcute/lexicons/syntax';
import { mainSchema as eventSchema } from '../../../lexicon-types/types/community/lexicon/calendar/event';
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
import { contrailNotifier, type GroupEventNotifier } from './events-index';

export const GROUP_EVENT_COLLECTION = 'community.lexicon.calendar.event';

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
			const res = await handle(`/xrpc/${nsid}`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ space, repo, collection, ...input })
			});
			const data: unknown = await res.json().catch(() => null);
			if (!res.ok) throw new Error(`${nsid} failed: ${res.status} ${JSON.stringify(data)}`);
			return data;
		};

		if (write.intent === 'delete') {
			if (space) {
				await sendSpace('com.atproto.space.deleteRecord', { rkey: write.rkey });
			} else {
				const res = await client.post('com.atproto.repo.deleteRecord', {
					input: { repo, collection, rkey: write.rkey }
				});
				if (!res.ok) throw new Error(`deleteRecord failed: ${JSON.stringify(res.data)}`);
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
			if (!res.ok) throw new Error(`${nsid} failed: ${JSON.stringify(res.data)}`);
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

export interface WriteGroupEventInput {
	db: D1Database;
	env: CredentialStoreEnv;
	group: GroupRow;
	/** The human pressing the button. Checked, never written as. */
	callerDid: string | null;
	intent: 'create' | 'update';
	/** Required for `update`. Minted as a TID for `create` if the page has not. */
	rkey?: string;
	record: Record<string, unknown>;
	/** Overrides the PDS transport, built from the group's credential when absent. */
	writer?: GroupRepoWriter;
	reader?: GroupSpaceReader | null;
	/** For tests only: a caller that supplies its own notifier can forget it. */
	notify?: GroupEventNotifier;
}

export interface GroupEventWriteResult {
	uri: string;
	cid: string;
	rkey: string;
	repo: string;
}

/** There is no "creator may edit" rule: the author of every group event is the
 *  group, so there is no per-event creator to compare against. */
function requiredPermission(intent: 'create' | 'update' | 'delete'): EnforcedGroupPermission {
	return intent === 'create' ? 'CREATE_EVENT' : 'MANAGE_EVENTS';
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

async function authorize(
	input: GroupGateInput,
	intent: 'create' | 'update' | 'delete'
): Promise<EnforcedGroupPermission> {
	const permission = requiredPermission(intent);
	await requireGroupPermission(input, permission);
	return permission;
}

/** A failure is logged, not thrown. The PDS already accepted the record, and
 *  reporting a failed write would invite a retry of a write that landed. */
async function notifyIndex(
	input: Pick<WriteGroupEventInput, 'db' | 'notify'>,
	uri: string
): Promise<void> {
	try {
		await (input.notify ?? contrailNotifier(input.db))(uri);
	} catch (e) {
		console.error(`[groups] could not tell the index about ${uri}:`, e);
	}
}

/** Authorizes the caller, then writes an event into the group's public repo. */
export async function writeGroupEvent(input: WriteGroupEventInput): Promise<GroupEventWriteResult> {
	await authorize(input, input.intent);

	if (input.intent === 'update' && !input.rkey) {
		throw new GroupRecordError('updating a group event needs its rkey');
	}
	const rkey = input.rkey ?? tidNow();
	const record = { ...input.record, $type: GROUP_EVENT_COLLECTION };

	// The PDS does not know this lexicon and would accept a malformed record.
	const parsed = v.safeParse(eventSchema, record);
	if (!parsed.ok) {
		throw new GroupRecordError(
			'that is not a valid community.lexicon.calendar.event record',
			parsed.issues ?? []
		);
	}

	const writer = input.writer ?? (await groupWriter(input.env, input.db, input.group));
	const result = await writer({
		repo: input.group.group_did,
		collection: GROUP_EVENT_COLLECTION,
		rkey,
		record,
		intent: input.intent
	});

	assertAuthoredByGroup(result.uri, input.group.group_did);

	// The events tab reads our index, not the PDS. This is the one function that
	// writes a group event, so the index is told here.
	await notifyIndex(input, result.uri);
	return { uri: result.uri, cid: result.cid, rkey, repo: input.group.group_did };
}

export async function deleteGroupEvent(
	input: Omit<WriteGroupEventInput, 'intent' | 'record'> & { rkey: string }
): Promise<{ uri: string; repo: string }> {
	await authorize(input, 'delete');
	const writer = input.writer ?? (await groupWriter(input.env, input.db, input.group));
	const result = await writer({
		repo: input.group.group_did,
		collection: GROUP_EVENT_COLLECTION,
		rkey: input.rkey,
		record: {},
		intent: 'delete'
	});
	assertAuthoredByGroup(result.uri, input.group.group_did);

	// The index re-fetches the URI, finds nothing, and drops the row.
	await notifyIndex(input, result.uri);
	return { uri: result.uri, repo: input.group.group_did };
}

/** The largest event image the group's repo takes. The event editor compresses
 *  to 900 KB before it uploads. */
export const GROUP_EVENT_IMAGE_MAX_BYTES = 1_000_000;

/** A blob reference as the PDS returns it, for a record to cite. */
export interface GroupBlobRef {
	$type: 'blob';
	ref: { $link: string };
	mimeType: string;
	size: number;
}

export type GroupBlobUploader = (blob: Blob) => Promise<GroupBlobRef>;

export interface UploadGroupEventImageInput extends GroupGateInput {
	/** The write the image is for, which decides the permission. */
	intent: 'create' | 'update';
	bytes: Uint8Array<ArrayBuffer>;
	mimeType: string;
	/** Overrides the PDS transport, built from the group's credential when absent. */
	upload?: GroupBlobUploader;
}

/** Authorizes the caller as for the event the image belongs to, then uploads it
 *  into the group's repo, where that event's record will cite it. */
export async function uploadGroupEventImage(
	input: UploadGroupEventImageInput
): Promise<GroupBlobRef> {
	await authorize(input, input.intent);
	if (!input.mimeType.startsWith('image/')) {
		throw new GroupRecordError(`an event image must be an image, not ${input.mimeType}`);
	}
	if (input.bytes.byteLength > GROUP_EVENT_IMAGE_MAX_BYTES) {
		throw new GroupRecordError(
			`an event image may be at most ${GROUP_EVENT_IMAGE_MAX_BYTES} bytes, not ${input.bytes.byteLength}`
		);
	}
	const upload = input.upload ?? (await groupBlobUploader(input.env, input.db, input.group));
	return upload(new Blob([input.bytes], { type: input.mimeType }));
}

function isBlobRef(value: unknown): value is GroupBlobRef {
	if (!value || typeof value !== 'object') return false;
	const ref = (value as { ref?: unknown }).ref;
	return (
		(value as { $type?: unknown }).$type === 'blob' &&
		!!ref &&
		typeof (ref as { $link?: unknown }).$link === 'string'
	);
}

/** Uploads into the group's repo through its linked session. Throws
 *  GroupCredentialError when the group is not linked. */
export async function groupBlobUploader(
	env: CredentialStoreEnv,
	db: D1Database,
	group: GroupRow
): Promise<GroupBlobUploader> {
	const cred = await resolveGroupCredential(env, group.group_did);
	if (!cred) throw new GroupCredentialError(group.group_did);
	return async (blob) => {
		const { handle } = await groupClient(cred, group.group_did);
		const res = await handle('/xrpc/com.atproto.repo.uploadBlob', {
			method: 'POST',
			headers: { 'content-type': blob.type },
			body: blob
		});
		const data: unknown = await res.json().catch(() => null);
		const ref = data && typeof data === 'object' ? (data as { blob?: unknown }).blob : undefined;
		if (!res.ok || !isBlobRef(ref)) {
			throw new Error(`uploadBlob failed: ${res.status} ${JSON.stringify(data)}`);
		}
		return ref;
	};
}

/** The transport for the group's repo and its spaces, through its linked session.
 *  Throws GroupCredentialError when the group is not linked. */
export async function groupWriter(
	env: CredentialStoreEnv,
	db: D1Database,
	group: GroupRow
): Promise<GroupRepoWriter> {
	const cred = await resolveGroupCredential(env, group.group_did);
	if (!cred) throw new GroupCredentialError(group.group_did);
	return pdsWriter(cred, group.group_did);
}

function assertAuthoredByGroup(uri: string, groupDid: string) {
	if (!uri.startsWith(`at://${groupDid}/`)) {
		throw new GroupRecordError(`group event landed at ${uri}, which is not ${groupDid}'s repo`);
	}
}
