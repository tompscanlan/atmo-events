// atmo's event editor, writing as a group. The editor builds the record exactly as
// it does for a person's own event; this adapter hands it to the group's commands,
// which check the caller's permission and write with the group's credential. The
// page gives the editor the group as its viewer, so the preview shows the group as
// the host.
import { goto } from '$app/navigation';
import { resolve } from '$app/paths';
import { getRecord, resolveHandle } from '$lib/atproto/methods';
import { atProtoLoginModalState } from '$lib/components/LoginModal.svelte';
import type { EditorAdapter, EditorBlobRef } from '$lib/components/editor/adapter';
import type { GroupFormResult } from './form-result';
import { putGroupEvent, putGroupEventImage, removeGroupEvent } from './groups.remote';

/** A refusal becomes a throw, which the editor reports as a failed save. */
function unwrap<T extends object>(result: GroupFormResult<T>): T {
	if (!result.ok) throw new Error(result.error);
	return result;
}

export function createGroupEditorAdapter(opts: {
	groupDid: string;
	/** The event being edited, or null on the new-event page. A write to any
	 *  other rkey, such as a recurrence, is a create. */
	editingRkey: string | null;
	canDelete: boolean;
	/** Where the event is: the group's calendar space for a members-only event,
	 *  or null for its public repo. Required and passed on every save and delete,
	 *  so none of them can fall back to public. (Spec: FR-116.) */
	space: string | null;
}): EditorAdapter {
	const { groupDid, editingRkey, space } = opts;
	const intentFor = (rkey: string) => (rkey === editingRkey ? 'update' : 'create');
	const eventsTab = resolve('/(app)/groups/[actor]/events', { actor: groupDid });

	return {
		// No private mode: members-only group events need a space of their own.
		features: { delete: opts.canDelete, recurring: true, privateMode: false },
		async putRecord({ rkey, record }) {
			return unwrap(
				await putGroupEvent({ groupDid, rkey, intent: intentFor(rkey), space, record })
			);
		},
		async createRecord() {
			// The editor writes public events with putRecord; only its private
			// mode, which is off here, would call this.
			throw new Error('a group event is written with putRecord');
		},
		async deleteRecord({ rkey }) {
			unwrap(await removeGroupEvent({ groupDid, rkey, space }));
		},
		async uploadBlob(blob) {
			const { blob: ref } = unwrap(
				await putGroupEventImage({
					groupDid,
					intent: editingRkey ? 'update' : 'create',
					bytes: Array.from(new Uint8Array(await blob.arrayBuffer())),
					mimeType: blob.type || 'application/octet-stream'
				})
			);
			return ref as EditorBlobRef;
		},
		async getRecord({ did, collection, rkey }) {
			const fresh = await getRecord({
				did: did as `did:${string}:${string}`,
				collection: collection as Parameters<typeof getRecord>[0]['collection'],
				rkey
			});
			return { value: (fresh as { value?: Record<string, unknown> }).value ?? {} };
		},
		async resolveHandle(handle: string) {
			return resolveHandle({ handle: handle as Parameters<typeof resolveHandle>[0]['handle'] });
		},
		onSaved() {
			goto(eventsTab, { invalidateAll: true });
		},
		onDeleted() {
			goto(eventsTab, { invalidateAll: true });
		},
		requestLogin() {
			atProtoLoginModalState.show();
		}
		// No notifyUpdate: the group's writer tells the index about every write.
	};
}
