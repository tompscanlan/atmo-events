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
import {
	groupSpaceReader,
	pdsSpaceReader,
	type GroupSpaceConfig,
	type GroupSpaceReader
} from './about-read';
import { getCallerMembership } from './repo';
import { groupClient } from './session';
import { contrailNotifier, type GroupEventNotifier } from './events-index';
import { POLICY_MEMBER_LIST, groupSpaceUris } from './space-uris';

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
	/** Where the event is: the group's calendar space URI for a members-only
	 *  event, or null for the group's public repo. Required, with no default: a
	 *  put creates the record when none is there, so an edit that left it out
	 *  would make a public copy of a members-only event. (Spec: FR-116.) */
	space: string | null;
	/** Overrides the PDS transport, built from the group's credential when absent. */
	writer?: GroupRepoWriter;
	reader?: GroupSpaceReader | null;
	/** Overrides the reads that check placement, built like `writer`. */
	locator?: GroupEventLocator;
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

// ---- placement ----------------------------------------------------------------
//
// A members-only event is the same record as a public one, written into the
// group's calendar space instead of its public repo. Nothing on the record says
// which, so the writer decides where each write goes, and these checks keep a
// write from landing anywhere else. The container is the fact, because the host
// enforces it for every reader, and a field would be a second answer that a peer
// app could read while the container said otherwise. (Spec: FR-104.)

/** Each placement refusal's copy, by its tag. Each says that nothing was saved,
 *  because nothing was. */
const PLACEMENT_REFUSALS = {
	'no-placement':
		'This event was sent without saying whether it is public or members-only, so nothing was saved.',
	'not-the-calendar-space':
		"A members-only event can only go in this group's calendar space, so nothing was saved.",
	'no-calendar-space':
		'This group has no calendar space for members-only events, because it was made before they existed. Re-create the group to post members-only events. Nothing was saved.',
	'calendar-space-readable':
		"This group's calendar space can be read by more than its members, so the members-only event was not saved.",
	'calendar-space-unchecked':
		"The group's calendar space could not be checked, so the members-only event was not saved. Try again later.",
	'placement-change':
		"This event can't be moved between public and members-only yet. Nothing was saved.",
	'wrong-placement-delete':
		"This event wasn't deleted, because the page had it as public when it's members-only, or the other way round. Reload and try again.",
	'placement-unchecked':
		'Whether this event is public or members-only could not be checked, so nothing was saved. Try again later.'
} as const;

/** A write refused because of where it would land. A GroupRecordError, so a form
 *  shows its message. `reason` is a stable machine tag, as on GroupRuleError. */
export class GroupPlacementError extends GroupRecordError {
	constructor(readonly reason: keyof typeof PLACEMENT_REFUSALS) {
		super(PLACEMENT_REFUSALS[reason]);
		this.name = 'GroupPlacementError';
	}
}

/** The host's own error code for a space it never created, as the reader names
 *  it in what it throws. */
const NO_SUCH_SPACE = /\bSpaceNotFound\b/;

/**
 * The placement a group event write may name: null for the group's public repo,
 * or the group's own calendar space. The URI is computed from the group's DID and
 * compared, never taken on trust: otherwise a CREATE_EVENT holder could aim an
 * event at the about space, which a public group lets anyone read. A missing
 * value is refused, never read as public. Makes no call, so a caller can run it
 * before anything else. (Spec: FR-116.)
 */
export function checkEventSpace(groupDid: string, space: unknown): string | null {
	if (space === null) return null;
	if (typeof space !== 'string') throw new GroupPlacementError('no-placement');
	if (space !== groupSpaceUris(groupDid).calendarSpaceUri) {
		throw new GroupPlacementError('not-the-calendar-space');
	}
	return space;
}

/** The reads that tell where an event is, made before a write. Injectable, like
 *  `GroupRepoWriter`, and built from the group's credential when absent. */
export interface GroupEventLocator {
	/** The space's configuration. Throws on every failure, `SpaceNotFound`
	 *  included, so a failed read never passes for either answer. */
	getSpace(space: string): Promise<GroupSpaceConfig>;
	/** Whether the group's event `rkey` is in `space`, or in the public repo for
	 *  null. A missing record is false; any other answer throws. */
	has(space: string | null, rkey: string): Promise<boolean>;
}

/** Reads with the group's own session, the one its writes use. */
export function pdsEventLocator(cred: GroupCredential, groupDid: string): GroupEventLocator {
	const spaces = pdsSpaceReader(cred, groupDid);
	return {
		getSpace: (space) => spaces.getSpace(space),
		async has(space, rkey) {
			if (space !== null) {
				const found = await spaces.get({
					space,
					repo: groupDid,
					collection: GROUP_EVENT_COLLECTION,
					rkey
				});
				return found !== null;
			}
			const { handle } = await groupClient(cred, groupDid);
			const query = new URLSearchParams({
				repo: groupDid,
				collection: GROUP_EVENT_COLLECTION,
				rkey
			});
			const res = await handle(`/xrpc/com.atproto.repo.getRecord?${query}`, { method: 'GET' });
			if (res.ok) return true;
			const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
			if (res.status === 400 && body?.error === 'RecordNotFound') return false;
			throw new Error(
				`com.atproto.repo.getRecord failed: ${res.status} ${String(body?.error ?? '')}`
			);
		}
	};
}

/** The locator for a group's events. Throws GroupCredentialError when the group
 *  is not linked, as `groupWriter` does. */
export async function groupEventLocator(
	env: CredentialStoreEnv,
	db: D1Database,
	group: GroupRow
): Promise<GroupEventLocator> {
	const cred = await resolveGroupCredential(env, group.group_did);
	if (!cred) throw new GroupCredentialError(group.group_did);
	return pdsEventLocator(cred, group.group_did);
}

/**
 * Before a members-only create or update: the calendar space must exist, and only
 * its members may read it. The host checks neither. A space write into a space
 * that was never created succeeds anyway, so a group made before the calendar
 * space would take members-only events into a space this app never set up, with
 * no read policy or access record of its choosing. And a space whose read policy
 * was changed out of band would hand the event to whoever it now lets in. One
 * `getSpace` answers both, and a group without the space is re-created, never
 * written to in public instead. (Spec: FR-101a.)
 */
export async function checkCalendarSpace(locator: GroupEventLocator, space: string): Promise<void> {
	let readPolicy: string;
	try {
		({ readPolicy } = await locator.getSpace(space));
	} catch (e) {
		if (e instanceof Error && NO_SUCH_SPACE.test(e.message)) {
			throw new GroupPlacementError('no-calendar-space');
		}
		console.error(`[groups] ${space} could not be checked; a members-only write was refused:`, e);
		throw new GroupPlacementError('calendar-space-unchecked');
	}
	if (readPolicy !== POLICY_MEMBER_LIST) throw new GroupPlacementError('calendar-space-readable');
}

/**
 * Before an update or a delete: the event must be where the page says it is.
 * Both containers create a record on a put and take a delete of a missing record
 * as done, so a write sent to the wrong one would silently copy the event across,
 * or report a delete that left it where it was. And a move cannot be allowed
 * anyway: a space record's URI is not a repo record's, so moving an event changes
 * its identity and strands every RSVP that names the old one. So the event is
 * looked up where the page says, and then in the other container. Found only
 * there, the write is refused: an edit as a move, a delete as a page that had the
 * event in the wrong place. Found in neither, the write goes where it was sent,
 * as it always has. (Spec: FR-107.)
 */
async function checkPlacement(
	locator: GroupEventLocator,
	groupDid: string,
	space: string | null,
	rkey: string,
	intent: 'update' | 'delete'
): Promise<void> {
	const has = async (at: string | null) => {
		try {
			return await locator.has(at, rkey);
		} catch (e) {
			console.error(`[groups] ${groupDid}: could not tell where event ${rkey} is:`, e);
			throw new GroupPlacementError('placement-unchecked');
		}
	};
	if (await has(space)) return;
	const other = space === null ? groupSpaceUris(groupDid).calendarSpaceUri : null;
	if (await has(other)) {
		throw new GroupPlacementError(
			intent === 'delete' ? 'wrong-placement-delete' : 'placement-change'
		);
	}
}

/** Authorizes the caller, then writes an event where `space` says: the group's
 *  calendar space for a members-only event, its public repo otherwise. */
export async function writeGroupEvent(input: WriteGroupEventInput): Promise<GroupEventWriteResult> {
	// No call is made for a placement the page should never send.
	const space = checkEventSpace(input.group.group_did, input.space);
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

	// A public create reads nothing first, as before.
	if (space !== null || input.intent === 'update') {
		const locator = input.locator ?? (await groupEventLocator(input.env, input.db, input.group));
		if (space !== null) await checkCalendarSpace(locator, space);
		if (input.intent === 'update') {
			await checkPlacement(locator, input.group.group_did, space, rkey, 'update');
		}
	}

	const writer = input.writer ?? (await groupWriter(input.env, input.db, input.group));
	const result = await writer({
		repo: input.group.group_did,
		collection: GROUP_EVENT_COLLECTION,
		rkey,
		record,
		intent: input.intent,
		space: space ?? undefined
	});

	assertAuthoredByGroup(result.uri, input.group.group_did);

	// The events tab reads our index, not the PDS. This is the one function that
	// writes a group event, so the index is told here. Never about a members-only
	// event, which the index would publish. The test is the placement the write
	// was sent to, not the URI that came back. (Spec: FR-111a.)
	if (space === null) await notifyIndex(input, result.uri);
	return { uri: result.uri, cid: result.cid, rkey, repo: input.group.group_did };
}

export async function deleteGroupEvent(
	input: Omit<WriteGroupEventInput, 'intent' | 'record'> & { rkey: string }
): Promise<{ uri: string; repo: string }> {
	const space = checkEventSpace(input.group.group_did, input.space);
	await authorize(input, 'delete');
	const locator = input.locator ?? (await groupEventLocator(input.env, input.db, input.group));
	await checkPlacement(locator, input.group.group_did, space, input.rkey, 'delete');
	const writer = input.writer ?? (await groupWriter(input.env, input.db, input.group));
	const result = await writer({
		repo: input.group.group_did,
		collection: GROUP_EVENT_COLLECTION,
		rkey: input.rkey,
		record: {},
		intent: 'delete',
		space: space ?? undefined
	});
	assertAuthoredByGroup(result.uri, input.group.group_did);

	// The index re-fetches the URI, finds nothing, and drops the row. A space
	// delete answers with the plain URI too, so here as well the skip keys on
	// where the delete was sent. (Spec: FR-111a.)
	if (space === null) await notifyIndex(input, result.uri);
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
