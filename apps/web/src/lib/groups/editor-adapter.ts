import { goto } from '$app/navigation';
import { resolve } from '$app/paths';
import { createInAppAdapter } from '#lib/components/editor/adapter.js';
import type { EditorAdapter, EditorViewer } from '@atmo-dev/events-ui';
import type { EventPlacement } from './event-placement';
import { removeGroupEvent, saveGroupEvent, uploadGroupBlob } from './group.remote';

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

/** The in-app adapter, with every write sent as the group to where `placement` says. A
 *  members-only event takes no image, since a blob is public wherever its record is. */
export function createGroupAdapter(
	groupDid: string,
	viewer: EditorViewer,
	placement: EventPlacement
): EditorAdapter {
	const base = createInAppAdapter({ viewer });
	const membersOnly = placement === 'members';
	return {
		...base,
		features: { delete: true, recurring: false, images: !membersOnly },
		async putRecord({ rkey, record }) {
			return saveGroupEvent({ groupDid, rkey, record, placement });
		},
		async createRecord({ rkey, record }) {
			if (!rkey) throw new Error('a group event needs its rkey');
			return saveGroupEvent({ groupDid, rkey, record, placement });
		},
		async deleteRecord({ rkey }) {
			await removeGroupEvent({ groupDid, rkey, placement });
		},
		async uploadBlob(blob) {
			if (membersOnly) throw new Error('a members-only event takes no image');
			return uploadGroupBlob({
				groupDid,
				bytes: Array.from(new Uint8Array(await blob.arrayBuffer())),
				mimeType: blob.type || 'application/octet-stream'
			});
		},
		onSaved({ rkey, isNew }) {
			if (membersOnly) {
				goto(resolve('/(app)/groups/[actor]/events/[rkey]', { actor: groupDid, rkey }));
				return;
			}
			const event = resolve('/(app)/p/[actor]/e/[rkey]', { actor: groupDid, rkey });
			// The path is resolved above; the query string can't go through resolve(), so the
			// rule can't see it.
			// eslint-disable-next-line svelte/no-navigation-without-resolve
			goto(isNew ? `${event}?created=true` : event);
		},
		onDeleted() {
			goto(resolve('/(app)/groups/[actor]', { actor: groupDid }));
		},
		// The server already told the index of a public event, and never tells it of a
		// members-only one; the group is not the browser's own account.
		async notifyUpdate() {}
	};
}
