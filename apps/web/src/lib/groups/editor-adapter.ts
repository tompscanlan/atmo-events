// atmo's event editor, writing as a group: the editor builds the record, this hands it on.
import { goto } from '$app/navigation';
import { resolve } from '$app/paths';
import { resolveHandle } from '$lib/atproto/methods';
import { atProtoLoginModalState } from '$lib/components/LoginModal.svelte';
import type { EditorAdapter, EditorBlobRef } from '$lib/components/editor/adapter';
import type { EventPlacement } from './event-placement';
import type { GroupFormResult } from './form-result';
import { putGroupEvent, putGroupEventImage, removeGroupEvent } from './group-events.remote';

// The editor shows a generic line for every failure, so a refusal's words go first.
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
	/** Null on the new-event page. A write to any other rkey, such as a recurrence, is a create. */
	editingRkey: string | null;
	canDelete: boolean;
	/** Sent with every save and delete, so none can fall back to public. */
	placement: EventPlacement;
	onRefusal: (message: string) => void;
	/** When a save is over, with whether it was written. */
	onSaveEnd?: (saved: boolean) => void;
}): EditorAdapter {
	const { groupDid, editingRkey, placement, onRefusal, onSaveEnd } = opts;
	const intentFor = (rkey: string) => (rkey === editingRkey ? 'update' : 'create');
	const eventsTab = resolve('/(app)/groups/[actor]/events', { actor: groupDid });

	return {
		// A recurring copy cites its original by a URI in the group's repo, where a members-only
		// event isn't. A members-only event goes to the calendar space by `placement`, not by the
		// editor's private mode.
		features: { delete: opts.canDelete, recurring: placement === 'everyone', privateMode: false },
		async putRecord({ rkey, record }) {
			let saved = false;
			try {
				const result = unwrap(
					await putGroupEvent({ groupDid, rkey, intent: intentFor(rkey), placement, record }),
					onRefusal
				);
				saved = true;
				return result;
			} finally {
				onSaveEnd?.(saved);
			}
		},
		async createRecord() {
			throw new Error('a group event is written with putRecord');
		},
		async deleteRecord({ rkey }) {
			unwrap(await removeGroupEvent({ groupDid, rkey, placement }), onRefusal);
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
	};
}
