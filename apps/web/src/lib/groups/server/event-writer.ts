import type { GroupBlobRef } from '../about-record';
import { now as tidNow } from '@atcute/tid';
import * as v from '@atcute/lexicons/validations';
import { mainSchema as eventSchema } from '../../../lexicon-types/types/community/lexicon/calendar/event';
import { GROUP_EVENT_COLLECTION } from '../ids';
import type { GroupRow } from '../types';
import type { GroupSpaceReader } from './about-read';
import { notifyIndexQuietly } from './events-index';
import {
	actingPerson,
	GroupRecordError,
	hostGroupWriter,
	requireGroupPermission,
	type GroupGateInput
} from './group-write';
import {
	groupClient,
	type CredentialStoreEnv,
	type GroupCredential,
	requireGroupCredential
} from './session';
import { xrpc, xrpcError } from './xrpc';

export interface WriteGroupEventInput {
	db: D1Database;
	env: CredentialStoreEnv;
	group: GroupRow;
	callerDid: string | null;
	intent: 'create' | 'update';
	rkey?: string;
	record: Record<string, unknown>;
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

/** Writes an event into the group's repo, as the group. */
export async function writeGroupEvent(input: WriteGroupEventInput): Promise<GroupEventWriteResult> {
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
	const result = await writer({
		repo: input.group.group_did,
		collection: GROUP_EVENT_COLLECTION,
		rkey,
		record,
		intent: input.intent
	});
	assertAuthoredByGroup(result.uri, input.group.group_did);
	await notifyIndexQuietly(input.db, result.uri);
	return { uri: result.uri, cid: result.cid, rkey, repo: input.group.group_did };
}

export async function deleteGroupEvent(
	input: Omit<WriteGroupEventInput, 'intent' | 'record'> & { rkey: string }
): Promise<{ uri: string; repo: string }> {
	await requireEventPermission(input, 'delete');
	const writer = await hostGroupWriter(input.env, input.group, actingPerson(input));
	const result = await writer({
		repo: input.group.group_did,
		collection: GROUP_EVENT_COLLECTION,
		rkey: input.rkey,
		record: {},
		intent: 'delete'
	});
	assertAuthoredByGroup(result.uri, input.group.group_did);
	// The index re-fetches the URI, finds nothing, and drops the row.
	await notifyIndexQuietly(input.db, result.uri);
	return { uri: result.uri, repo: input.group.group_did };
}

// The event editor compresses to 900 KB before it uploads.
export const GROUP_EVENT_IMAGE_MAX_BYTES = 1_000_000;

export type { GroupBlobRef };

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
