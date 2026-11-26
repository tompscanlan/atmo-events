import { isHttpError } from '@sveltejs/kit';
import { goto } from '$app/navigation';
import { resolve } from '$app/paths';
import {
	createInAppAdapter,
	type EditorAdapter,
	type EditorViewer
} from '#lib/components/editor/adapter.js';
import { deleteGroupEvent, putGroupEvent, uploadGroupBlob } from './group.remote';

/** The editor shows the group as the host, so `viewer` is the group, not the person
 *  signed in; the server writes only for someone who linked it. */
export function groupViewer(group: { did: string; handle: string | null; name: string }) {
	return {
		isLoggedIn: true,
		canPostToBluesky: false,
		did: group.did,
		handle: group.handle ?? undefined,
		displayName: group.name
	} satisfies EditorViewer;
}

/** The in-app adapter, with every write sent as the group. The editor words every failure its own
 *  way, so a refusal the server explains (a 403: the person's role no longer allows it, or the link
 *  broke) also goes to `onRefused`, for the page to show beside it. */
export function createGroupAdapter(
	groupDid: string,
	viewer: EditorViewer,
	onRefused: (reason: string) => void = () => {}
): EditorAdapter {
	const base = createInAppAdapter({ viewer });
	const explained = async <T>(write: Promise<T>): Promise<T> => {
		try {
			return await write;
		} catch (e) {
			if (isHttpError(e, 403)) onRefused(e.body.message);
			throw e;
		}
	};
	return {
		...base,
		features: { delete: true, recurring: false },
		async putRecord({ rkey, record }) {
			return explained(putGroupEvent({ groupDid, rkey, record }));
		},
		async createRecord({ rkey, record }) {
			if (!rkey) throw new Error('a group event needs its rkey');
			return explained(putGroupEvent({ groupDid, rkey, record }));
		},
		async deleteRecord({ rkey }) {
			await explained(deleteGroupEvent({ groupDid, rkey }));
		},
		async uploadBlob(blob) {
			return explained(
				uploadGroupBlob({
					groupDid,
					bytes: Array.from(new Uint8Array(await blob.arrayBuffer())),
					mimeType: blob.type || 'application/octet-stream'
				})
			);
		},
		onSaved({ rkey, isNew }) {
			const event = resolve('/(app)/p/[actor]/e/[rkey]', { actor: groupDid, rkey });
			// The path is resolved above; the query string can't go through resolve(), so the
			// rule can't see it.
			// eslint-disable-next-line svelte/no-navigation-without-resolve
			goto(isNew ? `${event}?created=true` : event);
		},
		onDeleted() {
			goto(resolve('/(app)/groups/[actor]', { actor: groupDid }));
		},
		// The server already told the index; the group is not the browser's own account.
		async notifyUpdate() {}
	};
}
