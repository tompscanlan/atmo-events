import { error } from '@sveltejs/kit';
import { command, getRequestEvent } from '$app/server';
import * as v from 'valibot';
import { EVENT_PLACEMENTS } from './event-placement';
import { GROUP_EVENT_COLLECTION } from './ids';
import { requireGroupWriter, requireStoredLink } from './server/context';
import {
	deleteMembersOnlyEvent,
	GroupEventRefused,
	putMembersOnlyEvent,
	refuseMembersOnlyKey
} from './server/group-events';
import { notifyIndex } from './server/group';
import { unlinkGroup } from './server/sign-in';
import { isLinkBroken, isRoleRefused, xrpc, xrpcBlob } from './server/xrpc';

const didSchema = v.pipe(v.string(), v.regex(/^did:[a-z]+:[a-zA-Z0-9._:%-]{1,2048}$/));
const rkeySchema = v.pipe(v.string(), v.regex(/^[a-zA-Z0-9._:~-]{1,512}$/));
/** Public unless the page says members only. */
const placementSchema = v.optional(v.picklist(EVENT_PLACEMENTS), 'everyone');

function callerDid(): string | null {
	return getRequestEvent().locals.did;
}

const NO_ROLE = 'Your role in this group no longer allows that.';
const RELINK = 'Your link to this group stopped working. Link it again from its page.';

/** A refusal from the group's host, as a 403 whose words the page shows; any other failure is
 *  `outage`, a 502, which says nothing of what the host answered. */
function refusedOr(outage: string) {
	return (e: unknown): never => {
		if (isRoleRefused(e)) error(403, NO_ROLE);
		if (isLinkBroken(e)) error(403, RELINK);
		error(502, outage);
	};
}

export const unlinkGroupSession = command(v.object({ groupDid: didSchema }), async (input) => {
	const did = await requireStoredLink(input.groupDid, callerDid());
	await unlinkGroup(input.groupDid, did);
	return { ok: true };
});

/** A refusal of a members-only write, in its own words, as a 409; anything else as `refusedOr`. */
function membersOnlyRefusedOr(outage: string) {
	const refused = refusedOr(outage);
	return (e: unknown): never => {
		if (e instanceof GroupEventRefused) error(409, e.message);
		return refused(e);
	};
}

export const putGroupEvent = command(
	v.object({
		groupDid: didSchema,
		rkey: rkeySchema,
		record: v.record(v.string(), v.unknown()),
		placement: placementSchema
	}),
	async ({ groupDid, rkey, record, placement }) => {
		const writer = await requireGroupWriter(groupDid, callerDid());
		if (placement === 'members') {
			// Into the group's calendar space: never the public repo, and nothing to the index.
			return putMembersOnlyEvent(writer, { rkey, record }).catch(
				membersOnlyRefusedOr('Saving the event failed')
			);
		}
		// A members-only event stays members-only: no public copy under its key.
		await refuseMembersOnlyKey(writer, rkey).catch(membersOnlyRefusedOr('Saving the event failed'));
		const result = await xrpc(writer.handle, 'com.atproto.repo.putRecord', {
			body: { repo: groupDid, collection: GROUP_EVENT_COLLECTION, rkey, record }
		}).catch(refusedOr('Saving the event failed'));
		const uri = String(result.uri);
		await notifyIndex(uri);
		return { uri, cid: String(result.cid) };
	}
);

export const deleteGroupEvent = command(
	v.object({ groupDid: didSchema, rkey: rkeySchema, placement: placementSchema }),
	async ({ groupDid, rkey, placement }) => {
		const writer = await requireGroupWriter(groupDid, callerDid());
		if (placement === 'members') {
			await deleteMembersOnlyEvent(writer, rkey).catch(refusedOr('Deleting the event failed'));
			return { ok: true };
		}
		await xrpc(writer.handle, 'com.atproto.repo.deleteRecord', {
			body: { repo: groupDid, collection: GROUP_EVENT_COLLECTION, rkey }
		}).catch(refusedOr('Deleting the event failed'));
		await notifyIndex(`at://${groupDid}/${GROUP_EVENT_COLLECTION}/${rkey}`);
		return { ok: true };
	}
);

export const uploadGroupBlob = command(
	v.object({ groupDid: didSchema, bytes: v.array(v.number()), mimeType: v.string() }),
	async ({ groupDid, bytes, mimeType }) => {
		const writer = await requireGroupWriter(groupDid, callerDid());
		const blob = new Blob([new Uint8Array(bytes)], { type: mimeType });
		const result = await xrpcBlob(writer.handle, 'com.atproto.repo.uploadBlob', blob).catch(
			refusedOr('Upload failed')
		);
		return result.blob as { $type: 'blob'; ref: { $link: string }; mimeType: string; size: number };
	}
);
