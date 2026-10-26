// A group's events: written into its public repo, or for members only into its calendar
// space. Nothing on the record says which, so these checks keep each write where it was sent.
import { now as tidNow } from '@atcute/tid';
import * as v from '@atcute/lexicons/validations';
import { mainSchema as eventSchema } from '../../../lexicon-types/types/community/lexicon/calendar/event';
import type { EventPlacement } from '../event-placement';
import { GROUP_EVENT_COLLECTION, groupSpaceUris } from '../ids';
import {
	GROUP_ACCESS_COLLECTION,
	GROUP_ACCESS_RKEY,
	parseGroupAccess,
	type GroupAccessFields
} from '../members-record';
import type { GroupRow } from '../types';
import { isSpaceNotFound, pdsSpaceReader, type GroupSpaceReader } from './about-read';
import { notifyIndexQuietly } from './events-index';
import {
	actingPerson,
	GroupRecordError,
	requireGroupPermission,
	type GroupGateInput
} from './group-write';
import { hostGroupWriter } from './host';
import {
	groupClient,
	type CredentialStoreEnv,
	type GroupCredential,
	requireGroupCredential
} from './session';
import { repoRecordExists, xrpc, xrpcError } from './xrpc';

export interface WriteGroupEventInput {
	db: D1Database;
	env: CredentialStoreEnv;
	group: GroupRow;
	callerDid: string | null;
	intent: 'create' | 'update';
	rkey?: string;
	record: Record<string, unknown>;
	/** Required: a put creates a record that is not there, so an edit without it could make a
	 *  public copy of a members-only event. */
	placement: EventPlacement;
	reader?: GroupSpaceReader | null;
}

export interface GroupEventWriteResult {
	uri: string;
	cid: string;
	rkey: string;
	repo: string;
}

async function requireEventPermission(
	input: GroupGateInput,
	intent: 'create' | 'update' | 'delete'
): Promise<void> {
	await requireGroupPermission(input, intent === 'create' ? 'CREATE_EVENT' : 'MANAGE_EVENTS');
}

const PLACEMENT_REFUSALS = {
	'no-placement':
		'This event was sent without saying whether it is public or members-only, so nothing was saved.',
	'no-calendar-space':
		'This group has no calendar space for members-only events, so nothing was saved.',
	'calendar-space-readable':
		"This group's calendar space can be read by more than its members, so the members-only event was not saved.",
	'calendar-space-unchecked':
		"The group's calendar space could not be checked, so the members-only event was not saved. Try again later.",
	'placement-change':
		"This event can't be moved between public and members-only. Nothing was saved.",
	'wrong-placement-delete':
		"This event wasn't deleted, because the page had it as public when it's members-only, or the other way round. Reload and try again.",
	'placement-unchecked':
		'Whether this event is public or members-only could not be checked, so nothing was saved. Try again later.'
} as const;

export class GroupPlacementError extends GroupRecordError {
	constructor(readonly reason: keyof typeof PLACEMENT_REFUSALS) {
		super(PLACEMENT_REFUSALS[reason]);
		this.name = 'GroupPlacementError';
	}
}

/** From the DID, never from a page. Anything but the two answers is refused, never read as public. */
function eventSpace(groupDid: string, placement: EventPlacement): string | null {
	if (placement === 'members') return groupSpaceUris(groupDid).calendarSpaceUri;
	if (placement === 'everyone') return null;
	throw new GroupPlacementError('no-placement');
}

/** Reads made with the group's own session before a write. Each throws on a failure, so a
 *  failed read never passes for an answer. */
export interface GroupEventLocator {
	/** Whether event `rkey` is in `space`, or in the public repo for null. */
	has(space: string | null, rkey: string): Promise<boolean>;
	/** The space's `access` record; null when it has none. */
	access(space: string): Promise<GroupAccessFields | null>;
}

export function pdsEventLocator(cred: GroupCredential, groupDid: string): GroupEventLocator {
	const spaces = pdsSpaceReader(cred, groupDid);
	const record = (space: string, collection: string, rkey: string) =>
		spaces.get({ space, repo: groupDid, collection, rkey });
	return {
		async has(space, rkey) {
			if (space !== null) return (await record(space, GROUP_EVENT_COLLECTION, rkey)) !== null;
			const { handle } = await groupClient(cred, groupDid);
			return repoRecordExists(handle, groupDid, GROUP_EVENT_COLLECTION, rkey);
		},
		async access(space) {
			const found = await record(space, GROUP_ACCESS_COLLECTION, GROUP_ACCESS_RKEY);
			return found ? parseGroupAccess(found.value) : null;
		}
	};
}

/** A space write into a space that was never made succeeds anyway, so before a members-only
 *  write the calendar space must exist and its `access` (which the host reads for every
 *  reader) must not say public. */
export async function checkCalendarSpace(locator: GroupEventLocator, space: string): Promise<void> {
	let access: GroupAccessFields | null;
	try {
		access = await locator.access(space);
	} catch (e) {
		if (isSpaceNotFound(e)) throw new GroupPlacementError('no-calendar-space');
		console.error(`[groups] ${space} could not be checked; a members-only write was refused:`, e);
		throw new GroupPlacementError('calendar-space-unchecked');
	}
	if (!access) throw new GroupPlacementError('calendar-space-unchecked');
	if (access.public) throw new GroupPlacementError('calendar-space-readable');
}

/** Both containers create on a put and take a delete of a missing record as done, so a write
 *  sent to the wrong one would copy the event across, or report a delete that did nothing. An
 *  event found only in the other container is refused; found in neither, the write goes ahead. */
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

async function eventLocator(input: WriteGroupEventInput | DeleteGroupEventInput) {
	return pdsEventLocator(
		await requireGroupCredential(input.env, input.group.group_did, actingPerson(input)),
		input.group.group_did
	);
}

/** Writes an event where its placement says, as the group. */
export async function writeGroupEvent(input: WriteGroupEventInput): Promise<GroupEventWriteResult> {
	const space = eventSpace(input.group.group_did, input.placement);
	await requireEventPermission(input, input.intent);

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

	const writer = await hostGroupWriter(input.env, input.group, actingPerson(input));
	// A public create reads nothing first.
	if (space !== null || input.intent === 'update') {
		const locator = await eventLocator(input);
		if (space !== null) await checkCalendarSpace(locator, space);
		if (input.intent === 'update') {
			await checkPlacement(locator, input.group.group_did, space, rkey, 'update');
		}
	}
	const result = await writer({
		repo: input.group.group_did,
		collection: GROUP_EVENT_COLLECTION,
		rkey,
		record,
		intent: input.intent,
		space: space ?? undefined
	});
	assertAuthoredByGroup(result.uri, input.group.group_did);
	// Never about a members-only event: the index would publish it.
	if (space === null) await notifyIndexQuietly(input.db, result.uri);
	return { uri: result.uri, cid: result.cid, rkey, repo: input.group.group_did };
}

type DeleteGroupEventInput = Omit<WriteGroupEventInput, 'intent' | 'record'> & { rkey: string };

export async function deleteGroupEvent(
	input: DeleteGroupEventInput
): Promise<{ uri: string; repo: string }> {
	const space = eventSpace(input.group.group_did, input.placement);
	await requireEventPermission(input, 'delete');
	const writer = await hostGroupWriter(input.env, input.group, actingPerson(input));
	await checkPlacement(
		await eventLocator(input),
		input.group.group_did,
		space,
		input.rkey,
		'delete'
	);
	const result = await writer({
		repo: input.group.group_did,
		collection: GROUP_EVENT_COLLECTION,
		rkey: input.rkey,
		record: {},
		intent: 'delete',
		space: space ?? undefined
	});
	assertAuthoredByGroup(result.uri, input.group.group_did);
	// The index re-fetches the URI, finds nothing, and drops the row.
	if (space === null) await notifyIndexQuietly(input.db, result.uri);
	return { uri: result.uri, repo: input.group.group_did };
}

// The event editor compresses to 900 KB before it uploads.
export const GROUP_EVENT_IMAGE_MAX_BYTES = 1_000_000;

/** A blob reference as a record holds it. */
export interface GroupBlobRef {
	$type: 'blob';
	ref: { $link: string };
	mimeType: string;
	size: number;
}

export type GroupBlobUploader = (blob: Blob) => Promise<GroupBlobRef>;

export interface UploadGroupEventImageInput extends GroupGateInput {
	intent: 'create' | 'update';
	bytes: Uint8Array<ArrayBuffer>;
	mimeType: string;
}

export async function uploadGroupEventImage(
	input: UploadGroupEventImageInput
): Promise<GroupBlobRef> {
	await requireEventPermission(input, input.intent);
	if (!input.mimeType.startsWith('image/')) {
		throw new GroupRecordError(`an event image must be an image, not ${input.mimeType}`);
	}
	if (input.bytes.byteLength > GROUP_EVENT_IMAGE_MAX_BYTES) {
		throw new GroupRecordError(
			`an event image may be at most ${GROUP_EVENT_IMAGE_MAX_BYTES} bytes, not ${input.bytes.byteLength}`
		);
	}
	const upload = await groupBlobUploader(input.env, input.group, actingPerson(input));
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

export async function groupBlobUploader(
	env: CredentialStoreEnv,
	group: GroupRow,
	personDid: string
): Promise<GroupBlobUploader> {
	return credentialBlobUploader(
		await requireGroupCredential(env, group.group_did, personDid),
		group.group_did
	);
}

export function credentialBlobUploader(cred: GroupCredential, groupDid: string): GroupBlobUploader {
	return async (blob) => {
		const { handle } = await groupClient(cred, groupDid);
		const nsid = 'com.atproto.repo.uploadBlob';
		const answer = await xrpc(handle, nsid, { blob });
		if (!answer.ok) throw xrpcError(nsid, answer);
		if (!isBlobRef(answer.data.blob)) throw new Error(`${nsid} returned no blob reference`);
		return answer.data.blob;
	};
}

function assertAuthoredByGroup(uri: string, groupDid: string) {
	if (!uri.startsWith(`at://${groupDid}/`)) {
		throw new GroupRecordError(`group event landed at ${uri}, which is not ${groupDid}'s repo`);
	}
}
