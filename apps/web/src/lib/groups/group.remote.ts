import { error, isHttpError } from '@sveltejs/kit';
import { command, getRequestEvent } from '$app/server';
import * as v from 'valibot';
import { GROUP_EVENT_COLLECTION } from './ids';
import { requireGroupWriter, requireStoredLink } from './server/context';
import { listGroup, notifyIndex, readGroupMeta, unlistGroup } from './server/group';
import { unlinkGroup } from './server/sign-in';
import { isLinkBroken, isRoleRefused, xrpc, xrpcBlob, XrpcError } from './server/xrpc';

const didSchema = v.pipe(v.string(), v.regex(/^did:[a-z]+:[a-zA-Z0-9._:%-]{1,2048}$/));
const rkeySchema = v.pipe(v.string(), v.regex(/^[a-zA-Z0-9._:~-]{1,512}$/));

function callerDid(): string | null {
	return getRequestEvent().locals.did;
}

const ONLY_PUBLIC =
	'Only a public group can be listed, and this one is private. Make it public at its group host first.';
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
			if (isLinkBroken(e)) error(403, RELINK);
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
		}).catch(refusedOr('Saving the event failed'));
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
