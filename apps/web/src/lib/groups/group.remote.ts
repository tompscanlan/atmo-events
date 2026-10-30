import { error } from '@sveltejs/kit';
import { command, getRequestEvent } from '$app/server';
import * as v from 'valibot';
import { GROUP_EVENT_COLLECTION } from './ids';
import { requireGroupWriter } from './server/context';
import { listGroup, notifyIndex, readGroupMeta, unlistGroup } from './server/group';
import { unlinkGroup } from './server/sign-in';
import { xrpc } from './server/xrpc';

const didSchema = v.pipe(v.string(), v.regex(/^did:[a-z]+:[a-zA-Z0-9._:%-]{1,2048}$/));
const rkeySchema = v.pipe(v.string(), v.regex(/^[a-zA-Z0-9._:~-]{1,512}$/));

function callerDid(): string | null {
	return getRequestEvent().locals.did;
}

/** Lists only a public group, as the proposal publishes a declaration only then. */
export const setGroupListed = command(
	v.object({ groupDid: didSchema, listed: v.boolean() }),
	async ({ groupDid, listed }) => {
		const writer = await requireGroupWriter(groupDid, callerDid());
		if (listed) {
			const meta = await readGroupMeta(writer.handle, groupDid);
			if (!meta.public) error(409, 'Only a public group can be listed');
			await listGroup(writer.handle, groupDid);
		} else {
			await unlistGroup(writer.handle, groupDid);
		}
		return { listed };
	}
);

export const unlinkGroupSession = command(v.object({ groupDid: didSchema }), async (input) => {
	const did = callerDid();
	await requireGroupWriter(input.groupDid, did);
	await unlinkGroup(input.groupDid, did as string);
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
		const result = await xrpc(writer.handle, 'com.atproto.repo.uploadBlob', { blob }).catch(() =>
			error(502, 'Upload failed')
		);
		return result.blob as { $type: 'blob'; ref: { $link: string }; mimeType: string; size: number };
	}
);
