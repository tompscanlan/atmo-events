import { error, isHttpError } from '@sveltejs/kit';
import { command, getRequestEvent } from '$app/server';
import * as v from 'valibot';
import { GROUP_EVENT_COLLECTION } from './ids';
import { requireGroupWriter, requireStoredLink } from './server/context';
import { listGroup, notifyIndex, readGroupMeta, unlistGroup } from './server/group';
import { unlinkGroup } from './server/sign-in';
import { isRoleRefused, xrpc, xrpcBlob, XrpcError } from './server/xrpc';

const didSchema = v.pipe(v.string(), v.regex(/^did:[a-z]+:[a-zA-Z0-9._:%-]{1,2048}$/));
const rkeySchema = v.pipe(v.string(), v.regex(/^[a-zA-Z0-9._:~-]{1,512}$/));

function callerDid(): string | null {
	return getRequestEvent().locals.did;
}

const ONLY_PUBLIC =
	'Only a public group can be listed, and this one is private. Make it public at its group host first.';
const NO_ROLE = 'Your role in this group no longer allows that.';

/** Lists only a public group. This site's rule, kept from the earlier proposal: the spec's
 *  declaration says nothing of the meta space being public. */
export const setGroupListed = command(
	v.object({ groupDid: didSchema, listed: v.boolean() }),
	async ({ groupDid, listed }) => {
		const writer = await requireGroupWriter(groupDid, callerDid());
		try {
			if (listed) {
				const meta = await readGroupMeta(writer.handle, groupDid);
				if (!meta.public) error(409, ONLY_PUBLIC);
				await listGroup(writer.handle, groupDid);
			} else {
				await unlistGroup(writer.handle, groupDid);
			}
		} catch (e) {
			if (isHttpError(e)) throw e;
			if (isRoleRefused(e)) error(403, NO_ROLE);
			// A group host refuses the declaration while the meta space is private, with the
			// generic InvalidRequest: it turned private since it was read.
			if (
				e instanceof XrpcError &&
				e.nsid === 'com.atproto.repo.putRecord' &&
				e.status === 400 &&
				e.error === 'InvalidRequest'
			) {
				error(409, ONLY_PUBLIC);
			}
			throw e;
		}
		return { listed };
	}
);

export const unlinkGroupSession = command(v.object({ groupDid: didSchema }), async (input) => {
	const did = await requireStoredLink(input.groupDid, callerDid());
	await unlinkGroup(input.groupDid, did);
	return { ok: true };
});

export const putGroupEvent = command(
	v.object({ groupDid: didSchema, rkey: rkeySchema, record: v.record(v.string(), v.unknown()) }),
	async ({ groupDid, rkey, record }) => {
		const writer = await requireGroupWriter(groupDid, callerDid());
		const result = await xrpc(writer.handle, 'com.atproto.repo.putRecord', {
			body: { repo: groupDid, collection: GROUP_EVENT_COLLECTION, rkey, record }
		}).catch(() => error(502, 'Saving the event failed'));
		const uri = String(result.uri);
		await notifyIndex(uri);
		return { uri, cid: String(result.cid) };
	}
);

export const deleteGroupEvent = command(
	v.object({ groupDid: didSchema, rkey: rkeySchema }),
	async ({ groupDid, rkey }) => {
		const writer = await requireGroupWriter(groupDid, callerDid());
		await xrpc(writer.handle, 'com.atproto.repo.deleteRecord', {
			body: { repo: groupDid, collection: GROUP_EVENT_COLLECTION, rkey }
		}).catch(() => error(502, 'Deleting the event failed'));
		await notifyIndex(`at://${groupDid}/${GROUP_EVENT_COLLECTION}/${rkey}`);
		return { ok: true };
	}
);

export const uploadGroupBlob = command(
	v.object({ groupDid: didSchema, bytes: v.array(v.number()), mimeType: v.string() }),
	async ({ groupDid, bytes, mimeType }) => {
		const writer = await requireGroupWriter(groupDid, callerDid());
		const blob = new Blob([new Uint8Array(bytes)], { type: mimeType });
		const result = await xrpcBlob(writer.handle, 'com.atproto.repo.uploadBlob', blob).catch(() =>
			error(502, 'Upload failed')
		);
		return result.blob as { $type: 'blob'; ref: { $link: string }; mimeType: string; size: number };
	}
);
