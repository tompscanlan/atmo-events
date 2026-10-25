// atmo's event editor, writing as a group: the editor builds the record as it does
// for a person's own event, and this adapter hands it to the group's commands.
import { goto } from '$app/navigation';
import { resolve } from '$app/paths';
import { resolveHandle } from '$lib/atproto/methods';
import { atProtoLoginModalState } from '$lib/components/LoginModal.svelte';
import type { EditorAdapter, EditorBlobRef } from '$lib/components/editor/adapter';
import type { GroupFormResult } from './form-result';
import { putGroupEvent, putGroupEventImage, removeGroupEvent } from './group-events.remote';

// The editor shows its own generic line for every failure, so a refusal's words
// go to the page first.
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
	onRefusal: (message: string) => void;
}): EditorAdapter {
	const { groupDid, editingRkey, onRefusal } = opts;
	const intentFor = (rkey: string) => (rkey === editingRkey ? 'update' : 'create');
	const eventsTab = resolve('/(app)/groups/[actor]/events', { actor: groupDid });

	return {
		features: { delete: opts.canDelete, recurring: true, privateMode: false },
		async putRecord({ rkey, record }) {
			return unwrap(
				await putGroupEvent({ groupDid, rkey, intent: intentFor(rkey), record }),
				onRefusal
			);
		},
		async createRecord() {
			throw new Error('a group event is written with putRecord');
		},
		async deleteRecord({ rkey }) {
			unwrap(await removeGroupEvent({ groupDid, rkey }), onRefusal);
		},
		async uploadBlob(blob) {
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
