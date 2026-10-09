// atmo's event editor, writing as a group. The editor builds the record exactly as
// it does for a person's own event; this adapter hands it to the group's commands,
// which check the caller's permission and write with the group's credential. The
// page gives the editor the group as its viewer, so the preview shows the group as
// the host.
import { goto } from '$app/navigation';
import { resolve } from '$app/paths';
import { resolveHandle } from '$lib/atproto/methods';
import { atProtoLoginModalState } from '$lib/components/LoginModal.svelte';
import type { EditorAdapter, EditorBlobRef } from '$lib/components/editor/adapter';
import type { GroupFormResult } from './form-result';
import { putGroupEvent, putGroupEventImage, removeGroupEvent } from './groups.remote';

/** A refusal goes to the page in its own words, then becomes a throw, which the
 *  editor reports as a failed save. */
function unwrap<T extends object>(
	result: GroupFormResult<T>,
	onRefusal: (message: string) => void
): T {
	if (!result.ok) {
		onRefusal(result.error);
		throw new Error(result.error);
	}
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
	/** Called with a refusal's message before the save, delete or upload fails.
	 *  The editor shows its own "Please try again" for every failure, so without
	 *  this the reason, such as a group that has to be re-created, reaches only
	 *  the console. */
	onRefusal: (message: string) => void;
	/** Called when a save is over, with whether it was written: when the write
	 *  settles, or when the image upload before it fails, which stops the
	 *  editor's save. Not when a mention's handle fails to resolve, since the
	 *  editor drops that mention and goes on to the write. The new-event page
	 *  unlocks its choice here. */
	onSaveEnd?: (saved: boolean) => void;
}): EditorAdapter {
	const { groupDid, editingRkey, space, onRefusal, onSaveEnd } = opts;
	const intentFor = (rkey: string) => (rkey === editingRkey ? 'update' : 'create');
	const eventsTab = resolve('/(app)/groups/[actor]/events', { actor: groupDid });

	return {
		// Recurring copies are off for a members-only event for now, until a copy
		// can cite its original by the original's members-only URI: the editor
		// cites it by a URI in the group's repo, where a members-only event isn't.
		// privateMode stays off: a members-only event goes in the calendar space
		// through `space`, not through the editor's own mode.
		features: { delete: opts.canDelete, recurring: space === null, privateMode: false },
		async putRecord({ rkey, record }) {
			let saved = false;
			try {
				const result = unwrap(
					await putGroupEvent({ groupDid, rkey, intent: intentFor(rkey), space, record }),
					onRefusal
				);
				saved = true;
				return result;
			} finally {
				onSaveEnd?.(saved);
			}
		},
		async createRecord() {
			// The editor writes public events with putRecord; only its private
			// mode, which is off here, would call this.
			throw new Error('a group event is written with putRecord');
		},
		async deleteRecord({ rkey }) {
			unwrap(await removeGroupEvent({ groupDid, rkey, space }), onRefusal);
		},
		async uploadBlob(blob) {
			try {
				const { blob: ref } = unwrap(
					await putGroupEventImage({
						groupDid,
						intent: editingRkey ? 'update' : 'create',
						bytes: Array.from(new Uint8Array(await blob.arrayBuffer())),
						mimeType: blob.type || 'application/octet-stream'
					}),
					onRefusal
				);
				return ref as EditorBlobRef;
			} catch (e) {
				// The editor's save stops here, before any write.
				onSaveEnd?.(false);
				throw e;
			}
		},
		async getRecord() {
			// Only the share flow reads a record back, and the editor never opens it.
			throw new Error('the group event editor reads no record back');
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
